'use strict';

// Rules, welcome message, away message, STOP / START opt-out, human takeover and the hand-over to the AI agent.
const store = require('./db');
const events = require('./events');
const ai = require('./ai');
const { isOpen } = require('./schedule');
const { render, sendAndRecord } = require('./messaging');

const { db } = store;
const FOREVER = '9999-12-31T00:00:00.000Z';
const HOUR = 3600 * 1000;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Does this rule answer this message? `rule` is a mapped rule (matchType, pattern).
 * Keywords are comma separated and not case sensitive.
 */
function ruleMatches(rule, text) {
  if (!rule) return false;
  if (rule.matchType === 'any') return true;
  const raw = String(text || '');
  const pattern = String(rule.pattern || '');
  if (!pattern) return false;
  if (rule.matchType === 'regex') {
    try {
      return new RegExp(pattern, 'i').test(raw);
    } catch {
      return false;
    }
  }
  const t = norm(raw);
  const words = pattern.split(',').map(norm).filter(Boolean);
  if (!words.length || !t) return false;
  if (rule.matchType === 'exact') return words.some((w) => t === w);
  if (rule.matchType === 'starts_with') return words.some((w) => t.startsWith(w));
  return words.some((w) => t.includes(w)); // contains
}

const scheduleAllows = (schedule, open) => schedule === 'always' || (schedule === 'business_hours' ? open : !open);

function isPaused(contact) {
  return Boolean(contact.botPausedUntil && contact.botPausedUntil > new Date().toISOString());
}

function autoRepliesLastHour(chatId) {
  const since = new Date(Date.now() - HOUR).toISOString();
  return db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND direction = 'out' AND source IN ('auto', 'ai') AND created_at >= ?")
    .get(chatId, since).n;
}

function sentRecently({ chatId, ruleId, body, hours, minutes }) {
  const cutoff = new Date(Date.now() - (hours ? hours * HOUR : minutes * 60000)).toISOString();
  if (ruleId) {
    return Boolean(
      db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND rule_id = ? AND direction = 'out' AND created_at > ? LIMIT 1").get(chatId, ruleId, cutoff)
    );
  }
  return Boolean(
    db.prepare("SELECT 1 FROM messages WHERE chat_id = ? AND source = 'auto' AND rule_id IS NULL AND direction = 'out' AND body = ? AND created_at > ? LIMIT 1").get(chatId, body, cutoff)
  );
}

function pauseBot(chatId, minutes) {
  const until = new Date(Date.now() + minutes * 60000).toISOString();
  db.prepare('UPDATE contacts SET bot_paused_until = ? WHERE chat_id = ? AND (bot_paused_until IS NULL OR bot_paused_until != ?)').run(until, chatId, FOREVER);
}

function applyRuleEffects(contact, rule) {
  const chatId = contact.chatId;
  if (rule.addTags && rule.addTags.length) {
    const merged = [...new Set([...(contact.tags || []), ...rule.addTags])].slice(0, 20);
    db.prepare('UPDATE contacts SET tags = ? WHERE chat_id = ?').run(JSON.stringify(merged), chatId);
  }
  if (rule.setStage) db.prepare('UPDATE contacts SET stage = ? WHERE chat_id = ?').run(rule.setStage, chatId);
  if (rule.pauseBot) {
    pauseBot(chatId, store.getSetting('humanTakeover').pauseMinutes || 60);
    db.prepare("UPDATE contacts SET ai_flag = 'needs_human' WHERE chat_id = ?").run(chatId);
  }
  db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(rule.id);
  events.publish('contact', { chatId });
  if (rule.pauseBot) events.publish('ai', { chatId });
}

async function reply(sessionId, contact, text, extra = {}) {
  if (!text || !String(text).trim()) return;
  await sendAndRecord({ sessionId, chatId: contact.chatId, text: render(text, contact), source: 'auto', ...extra });
}

async function handle({ sessionId, contact, body, isNewContact }) {
  const chatId = contact.chatId;
  const text = String(body || '').trim();
  const t = norm(text);

  // 1. STOP / START always win.
  const optOut = store.getSetting('optOut');
  if (optOut.enabled && t) {
    if ((optOut.keywords || []).includes(t) && !contact.optedOut) {
      db.prepare('UPDATE contacts SET opted_out = 1 WHERE chat_id = ?').run(chatId);
      events.publish('contact', { chatId });
      await reply(sessionId, contact, optOut.reply);
      return;
    }
    if ((optOut.optInKeywords || []).includes(t) && contact.optedOut) {
      db.prepare('UPDATE contacts SET opted_out = 0 WHERE chat_id = ?').run(chatId);
      events.publish('contact', { chatId });
      await reply(sessionId, contact, optOut.optInReply);
      return;
    }
  }
  if (contact.optedOut) return;

  // 2. A person is handling this chat, or the loop guard tripped.
  if (isPaused(contact)) return;
  const maxPerHour = store.getSetting('safety').maxAutoRepliesPerHour;
  if (autoRepliesLastHour(chatId) >= maxPerHour) return;

  const open = isOpen();

  // 3. Keyword rules, first match by priority.
  if (text) {
    const rules = db.prepare('SELECT * FROM rules WHERE enabled = 1 ORDER BY priority ASC, id ASC').all().map(store.mapRule);
    for (const rule of rules) {
      if (rule.sessionId && rule.sessionId !== sessionId) continue;
      if (!scheduleAllows(rule.schedule, open)) continue;
      if (!ruleMatches(rule, text)) continue;
      if (rule.cooldownMinutes > 0 && sentRecently({ chatId, ruleId: rule.id, minutes: rule.cooldownMinutes })) continue;
      await reply(sessionId, contact, rule.reply, { ruleId: rule.id });
      applyRuleEffects(store.getContact(chatId) || contact, rule);
      return;
    }
  }

  // 4. Away message when closed (also while the AI drafts).
  let answered = false;
  const away = store.getSetting('away');
  if (!open && away.enabled && away.text && !sentRecently({ chatId, body: render(away.text, contact), hours: away.cooldownHours || 12 })) {
    await reply(sessionId, contact, away.text);
    answered = true;
  }

  // 5. AI agent.
  if (ai.isActive()) {
    ai.queueInbound(sessionId, chatId);
    return;
  }

  // 6. Welcome for brand new contacts.
  const welcome = store.getSetting('welcome');
  if (!answered && isNewContact && welcome.enabled && welcome.text) await reply(sessionId, contact, welcome.text);
}

async function handleInbound(args) {
  if (!args || !args.contact) return;
  try {
    await handle(args);
  } catch (err) {
    console.warn(`[automation] ${args.contact.chatId}: ${err.message}`);
  }
}

module.exports = { ruleMatches, handleInbound };
