'use strict';

const express = require('express');
const v = require('../validate');
const store = require('../db');
const events = require('../events');
const { sendAndRecord } = require('../messaging');

const { db } = store;
const router = express.Router();
const FOREVER = '9999-12-31T00:00:00.000Z';

function contactOr404(chatId) {
  const contact = store.getContact(chatId);
  if (!contact) {
    const err = new v.ValidationError('Conversation not found.');
    err.status = 404;
    throw err;
  }
  return contact;
}

// Conversation list: contacts that have at least one message, newest first.
router.get('/conversations', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const filter = ['all', 'unread', 'paused', 'opted_out'].includes(req.query.filter) ? req.query.filter : 'all';
  const limit = v.int(req.query.limit, { label: 'limit', min: 1, max: 200, fallback: 100 });

  const where = ['last_message_at IS NOT NULL'];
  const params = [];
  if (q) {
    where.push('(name LIKE ? OR push_name LIKE ? OR phone LIKE ? OR last_message LIKE ?)');
    const like = `%${q.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like);
  }
  if (filter === 'unread') where.push('unread > 0');
  if (filter === 'paused') {
    where.push('bot_paused_until > ?');
    params.push(store.now());
  }
  if (filter === 'opted_out') where.push('opted_out = 1');

  const rows = db
    .prepare(`SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY last_message_at DESC LIMIT ?`)
    .all(...params, limit);
  res.json({ items: rows.map(store.mapContact) });
});

router.get('/conversations/:chatId/messages', (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  const contact = contactOr404(chatId);
  const limit = v.int(req.query.limit, { label: 'limit', min: 1, max: 200, fallback: 60 });
  const before = v.int(req.query.before, { label: 'before', min: 1, fallback: Number.MAX_SAFE_INTEGER });

  const rows = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(chatId, before, limit)
    .reverse();
  res.json({ contact, items: rows.map(store.mapMessage), hasMore: rows.length === limit });
});

router.post('/conversations/:chatId/read', (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  db.prepare('UPDATE contacts SET unread = 0 WHERE chat_id = ?').run(chatId);
  events.publish('contact', { chatId });
  res.json({ ok: true });
});

// Manual reply. Pauses the bot for this chat so it does not talk over the human.
router.post('/conversations/:chatId/send', async (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  const contact = contactOr404(chatId);
  const text = v.text(req.body?.text);
  const sessionId = req.body?.sessionId ? v.uuid(req.body.sessionId, 'session id') : contact.sessionId;
  if (!sessionId) throw new v.ValidationError('This conversation has no session yet. Pick a session to send from.');
  if (contact.optedOut && !v.bool(req.body?.force)) {
    throw new v.ValidationError('This contact opted out. Tick "send anyway" only if they asked you to reply.');
  }

  const { message } = await sendAndRecord({ sessionId, chatId, text, source: 'manual' });

  const pauseMinutes = store.getSetting('humanTakeover').pauseMinutes;
  if (pauseMinutes > 0 && contact.botPausedUntil !== FOREVER) {
    const until = new Date(Date.now() + pauseMinutes * 60000).toISOString();
    db.prepare('UPDATE contacts SET bot_paused_until = ?, unread = 0 WHERE chat_id = ?').run(until, chatId);
  } else {
    db.prepare('UPDATE contacts SET unread = 0 WHERE chat_id = ?').run(chatId);
  }
  events.publish('contact', { chatId });
  res.json({ message, contact: store.getContact(chatId) });
});

// Pause or resume auto-replies for one chat. minutes = 0 means until resumed.
router.post('/conversations/:chatId/bot', (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  contactOr404(chatId);
  const paused = v.bool(req.body?.paused);
  const minutes = v.int(req.body?.minutes, { label: 'minutes', min: 0, max: 43200, fallback: 0 });
  const until = !paused ? null : minutes ? new Date(Date.now() + minutes * 60000).toISOString() : FOREVER;
  db.prepare('UPDATE contacts SET bot_paused_until = ? WHERE chat_id = ?').run(until, chatId);
  events.publish('contact', { chatId });
  res.json({ contact: store.getContact(chatId) });
});

module.exports = router;
