'use strict';

const express = require('express');
const v = require('../validate');
const store = require('../db');
const events = require('../events');

const { db } = store;
const router = express.Router();
const MAX_RECIPIENTS = 5000;

const campaignOr404 = (id) => {
  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!row) throw Object.assign(new v.ValidationError('Campaign not found.'), { status: 404 });
  return row;
};

// Recipients come from pasted/CSV rows and/or an audience filter (tag, stage).
function collectRecipients(body) {
  const map = new Map();
  const invalid = [];

  const rows = Array.isArray(body.recipients) ? body.recipients : [];
  if (rows.length > MAX_RECIPIENTS) throw new v.ValidationError(`A campaign can have at most ${MAX_RECIPIENTS} recipients.`);
  rows.forEach((row, i) => {
    try {
      const phone = v.phone(row && row.phone);
      const name = row.name ? String(row.name).trim().slice(0, 100) : null;
      map.set(`${phone}@c.us`, { phone, name });
    } catch (err) {
      if (invalid.length < 50) invalid.push({ row: i + 1, error: err.message });
    }
  });

  const audience = body.audience || {};
  if (audience.tag || audience.stage || audience.all) {
    const where = ['opted_out = 0', 'phone IS NOT NULL'];
    const params = [];
    if (audience.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE json_each.value = ?)');
      params.push(v.tags([String(audience.tag)])[0]);
    }
    if (audience.stage) {
      where.push('stage = ?');
      params.push(v.oneOf(String(audience.stage), v.STAGES, 'Stage'));
    }
    for (const c of db.prepare(`SELECT chat_id, phone, name, push_name FROM contacts WHERE ${where.join(' AND ')}`).all(...params)) {
      if (!map.has(c.chat_id)) map.set(c.chat_id, { phone: c.phone, name: c.name || c.push_name || null });
    }
  }

  // Never message people who opted out, whichever way they were added.
  const optedOut = new Set(db.prepare('SELECT chat_id FROM contacts WHERE opted_out = 1').all().map((r) => r.chat_id));
  let excluded = 0;
  for (const chatId of [...map.keys()]) {
    if (optedOut.has(chatId)) {
      map.delete(chatId);
      excluded += 1;
    }
  }
  if (map.size > MAX_RECIPIENTS) throw new v.ValidationError(`A campaign can have at most ${MAX_RECIPIENTS} recipients.`);
  return { recipients: map, invalid, excluded };
}

router.get('/campaigns', (req, res) => {
  const rows = db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 200').all();
  res.json({ items: rows.map(store.mapCampaign) });
});

router.get('/campaigns/:id', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  const campaign = store.mapCampaign(campaignOr404(id));
  const status = ['pending', 'sent', 'failed', 'skipped'].includes(req.query.status) ? req.query.status : null;
  const recipients = db
    .prepare(
      `SELECT id, phone, name, status, error, sent_at FROM campaign_recipients
       WHERE campaign_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id LIMIT 500`
    )
    .all(...(status ? [id, status] : [id]));
  res.json({ campaign, recipients });
});

router.post('/campaigns', (req, res) => {
  const body = req.body || {};
  const defaults = store.getSetting('campaigns');
  const name = v.text(body.name, { label: 'Campaign name', max: 80 }).trim();
  const sessionId = v.uuid(body.sessionId, 'session id');
  const message = v.text(body.message);
  const minDelay = v.int(body.minDelay, { label: 'Minimum delay', min: 3, max: 3600, fallback: defaults.minDelay });
  const maxDelay = v.int(body.maxDelay, { label: 'Maximum delay', min: 3, max: 3600, fallback: defaults.maxDelay });
  if (maxDelay < minDelay) throw new v.ValidationError('Maximum delay must be at least the minimum delay.');
  const scheduledAt = body.scheduledAt ? v.isoDate(body.scheduledAt, 'Schedule time') : null;
  const draft = v.bool(body.draft);

  const { recipients, invalid, excluded } = collectRecipients(body);
  if (!recipients.size) throw new v.ValidationError('No valid recipients. Add numbers or choose an audience.');

  const ts = store.now();
  const id = store.tx(() => {
    const info = db
      .prepare(
        `INSERT INTO campaigns (name, session_id, message, status, scheduled_at, min_delay, max_delay,
           business_hours_only, skip_unregistered, total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        sessionId,
        message,
        draft ? 'paused' : 'scheduled',
        scheduledAt,
        minDelay,
        maxDelay,
        v.bool(body.businessHoursOnly) ? 1 : 0,
        body.skipUnregistered === undefined || v.bool(body.skipUnregistered) ? 1 : 0,
        recipients.size,
        ts
      );
    const campaignId = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO campaign_recipients (campaign_id, chat_id, phone, name) VALUES (?, ?, ?, ?)');
    for (const [chatId, r] of recipients) insert.run(campaignId, chatId, r.phone, r.name);
    return campaignId;
  });

  events.publish('campaign', { id });
  res.status(201).json({ campaign: store.mapCampaign(campaignOr404(id)), invalid, excludedOptedOut: excluded });
});

function transition(id, allowedFrom, to, extra = {}) {
  const row = campaignOr404(id);
  if (!allowedFrom.includes(row.status)) {
    throw new v.ValidationError(`Cannot change a ${row.status} campaign to ${to}.`);
  }
  const fields = { status: to, ...extra };
  const keys = Object.keys(fields);
  db.prepare(`UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  events.publish('campaign', { id });
  return store.mapCampaign(campaignOr404(id));
}

router.post('/campaigns/:id/pause', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  res.json({ campaign: transition(id, ['scheduled', 'running'], 'paused') });
});

router.post('/campaigns/:id/resume', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  res.json({ campaign: transition(id, ['paused'], 'scheduled', { last_error: null }) });
});

router.post('/campaigns/:id/cancel', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  res.json({ campaign: transition(id, ['scheduled', 'running', 'paused'], 'cancelled', { finished_at: store.now(), next_send_at: null }) });
});

router.post('/campaigns/:id/retry-failed', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  const row = campaignOr404(id);
  if (row.status === 'running') throw new v.ValidationError('Pause the campaign first.');
  const reset = store.tx(() => {
    const info = db
      .prepare("UPDATE campaign_recipients SET status = 'pending', attempts = 0, error = NULL WHERE campaign_id = ? AND status = 'failed'")
      .run(id);
    db.prepare("UPDATE campaigns SET failed = failed - ?, status = 'scheduled', finished_at = NULL, last_error = NULL WHERE id = ?").run(
      info.changes,
      id
    );
    return info.changes;
  });
  events.publish('campaign', { id });
  res.json({ reset, campaign: store.mapCampaign(campaignOr404(id)) });
});

router.delete('/campaigns/:id', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  const row = campaignOr404(id);
  if (row.status === 'running' || row.status === 'scheduled') throw new v.ValidationError('Pause or cancel the campaign before deleting it.');
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  events.publish('campaign', { id, deleted: true });
  res.json({ ok: true });
});

module.exports = router;
