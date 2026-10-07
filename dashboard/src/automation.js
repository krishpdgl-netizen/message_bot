'use strict';

const store = require('./db');
const events = require('./events');
const { isOpen } = require('./schedule');
const { render, sendAndRecord } = require('./messaging');

const { db } = store;

const normalize = (s) => String(s || '').trim().toLowerCase();

// "price, cost , rate" -> ["price", "cost", "rate"]
const alternatives = (pattern) =>
  String(pattern || '')
    .split(',')
    .map((p) => normalize(p))
    .filter(Boolean);

function ruleMatches(rule, body) {
  const text = normalize(body);
  switch (rule.matchType) {
    case 'any':
      return true;
    case 'exact':
      return alternatives(rule.pattern).some((p) => text === p);
    case 'starts_with':
      return alternatives(rule.pattern).some((p) => text.startsWith(p));
    case 'contains':
      return alternatives(rule.pattern).some((p) => text.includes(p));
    case 'regex':
      try {
        return new RegExp(rule.pattern, 'i').test(String(body || '').slice(0, 1000));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function scheduleAllows(schedule, open) {
  if (schedule === 'business_hours') return open;
  if (schedule === 'after_hours') return !open;
  return true;
}

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

function autoRepliesInLastHour(chatId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND source = 'auto' AND created_at >= ?")
    .get(chatId, minutesAgo(60)).n;
}

function ruleFiredRecently(ruleId, chatId, cooldownMinutes) {
  if (!cooldownMinutes) return false;
  return Boolean(
    db
      .prepare('SELECT 1 FROM messages WHERE chat_id = ? AND rule_id = ? AND created_at >= ? LIMIT 1')
      .get(chatId, ruleId, minutesAgo(cooldownMinutes))
  );
}

function awaySentRecently(chatId, hours) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM messages WHERE chat_id = ? AND source = 'auto' AND rule_id = -2 AND created_at >= ? LIMIT 1")
      .get(chatId, minutesAgo(hours * 60))
  );
}

function applyRuleActions(rule, contact) {
  const tags = new Set(contact.tags);
  for (const t of rule.addTags) tags.add(t);
  const stage = rule.setStage || contact.stage;
  // Hand-off rules pause the bot for this chat until someone resumes it in the inbox.
  const pausedUntil = rule.pauseBot ? '9999-12-31T00:00:00.000Z' : contact.botPausedUntil;
  db.prepare('UPDATE contacts SET tags = ?, stage = ?, bot_paused_until = ?, updated_at = ? WHERE chat_id = ?').run(
    JSON.stringify([...tags]),
    stage,
    pausedUntil ?? null,
    store.now(),
    contact.chatId
  );
  db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(rule.id);
}

// Special rule ids used in messages.rule_id so system replies are traceable.
const SYSTEM_RULE = { welcome: -1, away: -2, optOut: -3, optIn: -4 };

async function reply(sessionId, contact, text, ruleId) {
  try {
    await sendAndRecord({
      sessionId,
      chatId: contact.chatId,
      text: render(text, contact),
      source: 'auto',
      ruleId,
    });
  } catch (err) {
    console.warn(`[automation] auto-reply to a contact failed: ${err.message}`);
  }
}

/**
 * Runs after an inbound message is stored. Order:
 * opt-out keywords, opted-out / paused checks, rate limit, rules, welcome, away.
 */
async function handleInbound({ sessionId, contact, body, isNewContact }) {
  const optOut = store.getSetting('optOut');
  const text = normalize(body);

  if (optOut.enabled && text) {
    if (optOut.keywords.map(normalize).includes(text)) {
      if (!contact.optedOut) {
        db.prepare('UPDATE contacts SET opted_out = 1, updated_at = ? WHERE chat_id = ?').run(store.now(), contact.chatId);
        events.publish('contact', { chatId: contact.chatId });
        if (optOut.reply) await reply(sessionId, contact, optOut.reply, SYSTEM_RULE.optOut);
      }
      return;
    }
    if (optOut.optInKeywords.map(normalize).includes(text) && contact.optedOut) {
      db.prepare('UPDATE contacts SET opted_out = 0, updated_at = ? WHERE chat_id = ?').run(store.now(), contact.chatId);
      events.publish('contact', { chatId: contact.chatId });
      if (optOut.optInReply) await reply(sessionId, contact, optOut.optInReply, SYSTEM_RULE.optIn);
      return;
    }
  }

  if (contact.optedOut) return;
  if (contact.botPausedUntil && contact.botPausedUntil > store.now()) return;

  const safety = store.getSetting('safety');
  if (autoRepliesInLastHour(contact.chatId) >= safety.maxAutoRepliesPerHour) return;

  const open = isOpen();
  const rules = db
    .prepare('SELECT * FROM rules WHERE enabled = 1 ORDER BY priority ASC, id ASC')
    .all()
    .map(store.mapRule)
    .filter((r) => (!r.sessionId || r.sessionId === sessionId) && scheduleAllows(r.schedule, open));

  for (const rule of rules) {
    if (!ruleMatches(rule, body)) continue;
    // A matching rule on cooldown still "wins", so a catch-all rule below it does not fire instead.
    if (ruleFiredRecently(rule.id, contact.chatId, rule.cooldownMinutes)) return;
    applyRuleActions(rule, contact);
    events.publish('contact', { chatId: contact.chatId });
    await reply(sessionId, contact, rule.reply, rule.id);
    return;
  }

  const welcome = store.getSetting('welcome');
  const away = store.getSetting('away');

  if (isNewContact && welcome.enabled && welcome.text) {
    const textOut = !open && away.enabled && away.text ? `${welcome.text}\n\n${away.text}` : welcome.text;
    await reply(sessionId, contact, textOut, !open && away.enabled ? SYSTEM_RULE.away : SYSTEM_RULE.welcome);
    return;
  }

  if (!open && away.enabled && away.text && !awaySentRecently(contact.chatId, away.cooldownHours)) {
    await reply(sessionId, contact, away.text, SYSTEM_RULE.away);
  }
}

module.exports = { handleInbound, ruleMatches, SYSTEM_RULE };
