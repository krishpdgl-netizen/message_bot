'use strict';

const express = require('express');
const v = require('../validate');
const store = require('../db');
const events = require('../events');
const media = require('../media');
const { sendAndRecord, sendMediaAndRecord, sendLibraryItem } = require('../messaging');

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
  afterManualSend(contact);
  res.json({ message, contact: store.getContact(chatId) });
});

// Human takeover: the bot stays quiet after a person replied, and pending AI drafts are dropped.
function afterManualSend(contact) {
  const chatId = contact.chatId;
  const pauseMinutes = store.getSetting('humanTakeover').pauseMinutes;
  if (pauseMinutes > 0 && contact.botPausedUntil !== FOREVER) {
    const until = new Date(Date.now() + pauseMinutes * 60000).toISOString();
    db.prepare('UPDATE contacts SET bot_paused_until = ?, unread = 0 WHERE chat_id = ?').run(until, chatId);
  } else {
    db.prepare('UPDATE contacts SET unread = 0 WHERE chat_id = ?').run(chatId);
  }
  db.prepare("UPDATE ai_drafts SET status = 'discarded' WHERE chat_id = ? AND status = 'pending'").run(chatId);
  db.prepare("UPDATE contacts SET ai_flag = NULL WHERE chat_id = ? AND ai_flag = 'needs_human'").run(chatId);
  events.publish('contact', { chatId });
  events.publish('ai', { chatId });
}

// Send a photo, video, audio file or document. Body: { data (base64), mimetype, filename, caption }
// or { libraryId, caption } to send a file from the media library.
router.post('/conversations/:chatId/send-media', async (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  const contact = contactOr404(chatId);
  const caption = v.optionalText(req.body?.caption, { label: 'Caption', max: 1024 });
  const sessionId = req.body?.sessionId ? v.uuid(req.body.sessionId, 'session id') : contact.sessionId;
  if (!sessionId) throw new v.ValidationError('This conversation has no session yet. Pick a session to send from.');
  if (contact.optedOut && !v.bool(req.body?.force)) {
    throw new v.ValidationError('This contact opted out. Tick "send anyway" only if they asked you to reply.');
  }

  let result;
  if (req.body?.libraryId !== undefined) {
    const itemId = v.int(req.body.libraryId, { label: 'Library file', min: 1 });
    try {
      result = await sendLibraryItem({ sessionId, chatId, itemId, caption, source: 'manual' });
    } catch (err) {
      if (err.status !== undefined) throw err;
      throw new v.ValidationError(err.message);
    }
  } else {
    const buffer = media.decodeBase64(req.body?.data);
    if (!buffer || !buffer.length) throw new v.ValidationError('Attach a file to send.');
    if (buffer.length > media.MAX_MEDIA_BYTES) throw new v.ValidationError(`File is too large (max ${media.MAX_MEDIA_BYTES / 1024 / 1024} MB).`);
    const filename = v.optionalText(req.body?.filename, { label: 'File name', max: 200 });
    result = await sendMediaAndRecord({ sessionId, chatId, buffer, mime: req.body?.mimetype, filename, caption, source: 'manual' });
  }
  afterManualSend(contact);
  res.json({ message: result.message, contact: store.getContact(chatId) });
});

// Stored file of a message (photo, document...). Behind the dashboard login like the rest of /api.
router.get('/media/:id', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  const row = db.prepare('SELECT media_path, media_mime, media_name FROM messages WHERE id = ?').get(id);
  if (!row || !row.media_path) return res.status(404).json({ error: 'File not found.' });
  return media.serve(res, { stored: row.media_path, mime: row.media_mime, filename: row.media_name });
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
