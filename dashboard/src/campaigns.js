'use strict';

const store = require('./db');
const events = require('./events');
const { isOpen } = require('./schedule');
const { render, sendAndRecord } = require('./messaging');
const openwa = require('./openwa');

const { db } = store;
const TICK_MS = 3000;
const MAX_ATTEMPTS = 3;
const sessionNextAt = new Map(); // keeps campaigns on one number from sending in parallel
let running = false;

const later = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function sentInLast24h(sessionId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  return db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND source = 'campaign' AND created_at >= ?")
    .get(sessionId, since).n;
}

function setCampaign(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    id
  );
}

function finishRecipient(campaign, recipient, outcome, extra = {}) {
  const counter = { sent: 'sent', failed: 'failed', skipped: 'skipped' }[outcome];
  store.tx(() => {
    db.prepare('UPDATE campaign_recipients SET status = ?, error = ?, wa_id = ?, sent_at = ?, attempts = attempts + 1 WHERE id = ?').run(
      outcome,
      extra.error ?? null,
      extra.waId ?? null,
      outcome === 'sent' ? store.now() : null,
      recipient.id
    );
    db.prepare(`UPDATE campaigns SET ${counter} = ${counter} + 1 WHERE id = ?`).run(campaign.id);
  });
}

async function processCampaign(campaign) {
  const ts = store.now();
  if (campaign.next_send_at && campaign.next_send_at > ts) return;
  if ((sessionNextAt.get(campaign.session_id) || '') > ts) return;

  if (campaign.business_hours_only && !isOpen()) {
    if (campaign.last_error !== 'Waiting for business hours') {
      setCampaign(campaign.id, { last_error: 'Waiting for business hours' });
      events.publish('campaign', { id: campaign.id });
    }
    return;
  }

  const cap = store.getSetting('campaigns').dailyCap;
  if (cap > 0 && sentInLast24h(campaign.session_id) >= cap) {
    if (!String(campaign.last_error || '').startsWith('Daily cap')) {
      setCampaign(campaign.id, { last_error: `Daily cap of ${cap} reached. Resumes automatically.` });
      events.publish('campaign', { id: campaign.id });
    }
    return;
  }

  const recipient = db
    .prepare("SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 1")
    .get(campaign.id);

  if (!recipient) {
    setCampaign(campaign.id, { status: 'completed', finished_at: ts, next_send_at: null, last_error: null });
    events.publish('campaign', { id: campaign.id });
    return;
  }

  const contact = store.getContact(recipient.chat_id);
  if (contact && contact.optedOut) {
    finishRecipient(campaign, recipient, 'skipped', { error: 'Opted out' });
    events.publish('campaign', { id: campaign.id });
    return; // no delay needed, nothing was sent
  }

  if (campaign.skip_unregistered) {
    try {
      const exists = await openwa.isOnWhatsApp(campaign.session_id, recipient.phone);
      if (exists === false) {
        finishRecipient(campaign, recipient, 'skipped', { error: 'Not on WhatsApp' });
        setCampaign(campaign.id, { next_send_at: later(2) });
        events.publish('campaign', { id: campaign.id });
        return;
      }
    } catch {
      // If the check itself fails, fall through and let the send decide.
    }
  }

  store.upsertContact({
    chatId: recipient.chat_id,
    sessionId: campaign.session_id,
    phone: recipient.phone,
    name: recipient.name || null,
    source: 'campaign',
  });

  const delay = randomBetween(campaign.min_delay, campaign.max_delay);
  try {
    const { messageId } = await sendAndRecord({
      sessionId: campaign.session_id,
      chatId: recipient.chat_id,
      text: render(campaign.message, store.getContact(recipient.chat_id)),
      source: 'campaign',
      campaignId: campaign.id,
    });
    finishRecipient(campaign, recipient, 'sent', { waId: messageId });
    setCampaign(campaign.id, { next_send_at: later(delay), last_error: null });
    sessionNextAt.set(campaign.session_id, later(delay));
  } catch (err) {
    const transient = err.status === 0 || err.status === 409 || err.status >= 500 || err.status === 429;
    if (transient && recipient.attempts + 1 < MAX_ATTEMPTS) {
      db.prepare('UPDATE campaign_recipients SET attempts = attempts + 1, error = ? WHERE id = ?').run(err.message, recipient.id);
      setCampaign(campaign.id, { next_send_at: later(30), last_error: `Retrying soon: ${err.message}` });
    } else {
      finishRecipient(campaign, recipient, 'failed', { error: err.message });
      setCampaign(campaign.id, { next_send_at: later(delay), last_error: err.message });
    }
  }
  events.publish('campaign', { id: campaign.id });
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const ts = store.now();
    const due = db
      .prepare("SELECT id FROM campaigns WHERE status = 'scheduled' AND (scheduled_at IS NULL OR scheduled_at <= ?)")
      .all(ts);
    for (const { id } of due) {
      setCampaign(id, { status: 'running', started_at: ts, next_send_at: ts });
      events.publish('campaign', { id });
    }

    const active = db.prepare("SELECT * FROM campaigns WHERE status = 'running' ORDER BY id").all();
    for (const campaign of active) await processCampaign(campaign);
  } catch (err) {
    console.error(`[campaigns] worker error: ${err.message}`);
  } finally {
    running = false;
  }
}

function startWorker() {
  setInterval(tick, TICK_MS).unref();
}

module.exports = { startWorker, tick };
