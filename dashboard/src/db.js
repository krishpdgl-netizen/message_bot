'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'dashboard.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    chat_id           TEXT PRIMARY KEY,
    session_id        TEXT,
    phone             TEXT,
    name              TEXT,
    push_name         TEXT,
    stage             TEXT NOT NULL DEFAULT 'new',
    tags              TEXT NOT NULL DEFAULT '[]',
    notes             TEXT NOT NULL DEFAULT '',
    opted_out         INTEGER NOT NULL DEFAULT 0,
    bot_paused_until  TEXT,
    unread            INTEGER NOT NULL DEFAULT 0,
    last_message      TEXT,
    last_message_at   TEXT,
    last_inbound_at   TEXT,
    source            TEXT NOT NULL DEFAULT 'inbound',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_last ON contacts(last_message_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    wa_id        TEXT UNIQUE,
    direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    body         TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL DEFAULT 'chat',
    status       TEXT,
    source       TEXT NOT NULL,
    rule_id      INTEGER,
    campaign_id  INTEGER,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

  CREATE TABLE IF NOT EXISTS rules (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    match_type        TEXT NOT NULL,
    pattern           TEXT NOT NULL DEFAULT '',
    reply             TEXT NOT NULL,
    session_id        TEXT,
    priority          INTEGER NOT NULL DEFAULT 100,
    schedule          TEXT NOT NULL DEFAULT 'always',
    cooldown_minutes  INTEGER NOT NULL DEFAULT 60,
    add_tags          TEXT NOT NULL DEFAULT '[]',
    set_stage         TEXT,
    pause_bot         INTEGER NOT NULL DEFAULT 0,
    hits              INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_replies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    session_id           TEXT NOT NULL,
    message              TEXT NOT NULL,
    status               TEXT NOT NULL,
    scheduled_at         TEXT,
    min_delay            INTEGER NOT NULL,
    max_delay            INTEGER NOT NULL,
    business_hours_only  INTEGER NOT NULL DEFAULT 0,
    skip_unregistered    INTEGER NOT NULL DEFAULT 1,
    total                INTEGER NOT NULL DEFAULT 0,
    sent                 INTEGER NOT NULL DEFAULT 0,
    failed               INTEGER NOT NULL DEFAULT 0,
    skipped              INTEGER NOT NULL DEFAULT 0,
    next_send_at         TEXT,
    last_error           TEXT,
    created_at           TEXT NOT NULL,
    started_at           TEXT,
    finished_at          TEXT
  );

  CREATE TABLE IF NOT EXISTS campaign_recipients (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    chat_id      TEXT NOT NULL,
    phone        TEXT NOT NULL,
    name         TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    wa_id        TEXT,
    sent_at      TEXT,
    UNIQUE (campaign_id, chat_id)
  );
  CREATE INDEX IF NOT EXISTS idx_recipients_status ON campaign_recipients(campaign_id, status, id);

  CREATE TABLE IF NOT EXISTS processed_events (
    key  TEXT PRIMARY KEY,
    at   TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  businessHours: {
    enabled: false,
    timezone: config.defaultTimezone,
    days: [1, 2, 3, 4, 5, 6],
    start: '09:00',
    end: '19:00',
  },
  welcome: {
    enabled: true,
    text: 'Hi {{name}}! Thanks for reaching out. How can we help you today?',
  },
  away: {
    enabled: false,
    text: 'Thanks for your message! We are closed right now and will reply as soon as we are back.',
    cooldownHours: 12,
  },
  optOut: {
    enabled: true,
    keywords: ['stop', 'unsubscribe'],
    optInKeywords: ['start'],
    reply: 'You have been unsubscribed and will not receive further messages. Reply START to subscribe again.',
    optInReply: 'Welcome back! You are subscribed again.',
  },
  humanTakeover: { pauseMinutes: 60 },
  safety: { maxAutoRepliesPerHour: 5 },
  campaigns: { dailyCap: 200, minDelay: 8, maxDelay: 20 },
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function getSetting(key) {
  const row = getSettingStmt.get(key);
  const stored = row ? parseJson(row.value, null) : null;
  const def = DEFAULT_SETTINGS[key];
  if (def && stored && typeof stored === 'object' && !Array.isArray(stored)) return { ...def, ...stored };
  return stored ?? def ?? null;
}

function setSetting(key, value) {
  setSettingStmt.run(key, JSON.stringify(value));
}

function getAllSettings() {
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = getSetting(key);
  return out;
}

// ---------- Row mappers ----------
function mapContact(row) {
  if (!row) return null;
  return {
    chatId: row.chat_id,
    sessionId: row.session_id,
    phone: row.phone,
    name: row.name,
    pushName: row.push_name,
    displayName: row.name || row.push_name || (row.phone ? `+${row.phone}` : row.chat_id),
    stage: row.stage,
    tags: parseJson(row.tags, []),
    notes: row.notes,
    optedOut: Boolean(row.opted_out),
    botPausedUntil: row.bot_paused_until,
    unread: row.unread,
    lastMessage: row.last_message,
    lastMessageAt: row.last_message_at,
    lastInboundAt: row.last_inbound_at,
    source: row.source,
    createdAt: row.created_at,
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    chatId: row.chat_id,
    waId: row.wa_id,
    direction: row.direction,
    body: row.body,
    type: row.type,
    status: row.status,
    source: row.source,
    ruleId: row.rule_id,
    campaignId: row.campaign_id,
    createdAt: row.created_at,
  };
}

function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    matchType: row.match_type,
    pattern: row.pattern,
    reply: row.reply,
    sessionId: row.session_id,
    priority: row.priority,
    schedule: row.schedule,
    cooldownMinutes: row.cooldown_minutes,
    addTags: parseJson(row.add_tags, []),
    setStage: row.set_stage,
    pauseBot: Boolean(row.pause_bot),
    hits: row.hits,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCampaign(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    sessionId: row.session_id,
    message: row.message,
    status: row.status,
    scheduledAt: row.scheduled_at,
    minDelay: row.min_delay,
    maxDelay: row.max_delay,
    businessHoursOnly: Boolean(row.business_hours_only),
    skipUnregistered: Boolean(row.skip_unregistered),
    total: row.total,
    sent: row.sent,
    failed: row.failed,
    skipped: row.skipped,
    pending: Math.max(0, row.total - row.sent - row.failed - row.skipped),
    nextSendAt: row.next_send_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

// ---------- Contacts ----------
const getContactStmt = db.prepare('SELECT * FROM contacts WHERE chat_id = ?');

function getContact(chatId) {
  return mapContact(getContactStmt.get(chatId));
}

// Create the contact if missing, otherwise refresh the fields we were given.
function upsertContact({ chatId, sessionId, phone, pushName, name, source = 'inbound' }) {
  const ts = now();
  const existing = getContactStmt.get(chatId);
  if (!existing) {
    db.prepare(
      `INSERT INTO contacts (chat_id, session_id, phone, name, push_name, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(chatId, sessionId ?? null, phone ?? null, name ?? null, pushName ?? null, source, ts, ts);
    return { contact: getContact(chatId), created: true };
  }
  db.prepare(
    `UPDATE contacts SET
       session_id = COALESCE(?, session_id),
       phone = COALESCE(?, phone),
       push_name = COALESCE(?, push_name),
       name = COALESCE(name, ?),
       updated_at = ?
     WHERE chat_id = ?`
  ).run(sessionId ?? null, phone ?? null, pushName ?? null, name ?? null, ts, chatId);
  return { contact: getContact(chatId), created: false };
}

// ---------- Messages ----------
// Inserts a message once (dedupe on wa_id). Returns the stored row and whether it was new.
function recordMessage(msg) {
  const ts = msg.createdAt || now();
  if (msg.waId) {
    const existing = db.prepare('SELECT * FROM messages WHERE wa_id = ?').get(msg.waId);
    if (existing) {
      // Our own send path may land after the webhook echo: enrich instead of duplicating.
      if (msg.source && msg.source !== 'phone' && existing.source === 'phone') {
        db.prepare('UPDATE messages SET source = ?, rule_id = ?, campaign_id = ? WHERE id = ?').run(
          msg.source,
          msg.ruleId ?? null,
          msg.campaignId ?? null,
          existing.id
        );
      }
      return { message: mapMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(existing.id)), created: false };
    }
  }

  const info = db
    .prepare(
      `INSERT INTO messages (session_id, chat_id, wa_id, direction, body, type, status, source, rule_id, campaign_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      msg.sessionId,
      msg.chatId,
      msg.waId ?? null,
      msg.direction,
      msg.body ?? '',
      msg.type ?? 'chat',
      msg.status ?? (msg.direction === 'out' ? 'sent' : null),
      msg.source,
      msg.ruleId ?? null,
      msg.campaignId ?? null,
      ts
    );

  const preview = (msg.body || `[${msg.type || 'message'}]`).slice(0, 140);
  db.prepare(
    `UPDATE contacts SET
       last_message = ?,
       last_message_at = ?,
       last_inbound_at = CASE WHEN ? = 'in' THEN ? ELSE last_inbound_at END,
       unread = CASE WHEN ? = 'in' THEN unread + 1 ELSE unread END,
       updated_at = ?
     WHERE chat_id = ?`
  ).run(preview, ts, msg.direction, ts, msg.direction, ts, msg.chatId);

  return {
    message: mapMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid))),
    created: true,
  };
}

// ---------- Idempotency ----------
function markEventProcessed(key) {
  if (!key) return true;
  const info = db.prepare('INSERT OR IGNORE INTO processed_events (key, at) VALUES (?, ?)').run(key, now());
  return info.changes > 0;
}

function pruneOldEvents() {
  const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM processed_events WHERE at < ?').run(cutoff);
}

module.exports = {
  db,
  now,
  tx,
  parseJson,
  DEFAULT_SETTINGS,
  getSetting,
  setSetting,
  getAllSettings,
  mapContact,
  mapMessage,
  mapRule,
  mapCampaign,
  getContact,
  upsertContact,
  recordMessage,
  markEventProcessed,
  pruneOldEvents,
};
