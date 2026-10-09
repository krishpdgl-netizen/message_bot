'use strict';

const express = require('express');
const v = require('../validate');
const store = require('../db');
const events = require('../events');
const ai = require('../ai');
const llm = require('../llm');
const media = require('../media');

const { db } = store;
const router = express.Router();

function contactOr404(chatId) {
  const contact = store.getContact(chatId);
  if (!contact) throw Object.assign(new v.ValidationError('Conversation not found.'), { status: 404 });
  return contact;
}

// ---------- AI tab ----------
router.get('/ai/overview', (req, res) => {
  res.json(ai.overview());
});

// API key: write-only from the browser. The server keeps it; it is never returned.
router.put('/ai/key', (req, res) => {
  const key = v.text(req.body?.apiKey, { label: 'API key', max: 400 }).trim();
  if (/\s/.test(key)) throw new v.ValidationError('The API key must not contain spaces.');
  store.setSetting('aiSecret', { key });
  res.json({ ok: true, configured: llm.isConfigured(), keySource: llm.apiKey().source });
});

router.delete('/ai/key', (req, res) => {
  store.setSetting('aiSecret', {});
  res.json({ ok: true, configured: llm.isConfigured(), keySource: llm.apiKey().source });
});

// Tries the agent on a sample customer message. Nothing is sent.
router.post('/ai/test', async (req, res) => {
  const message = v.text(req.body?.message, { label: 'Test message', max: 1000 });
  res.json({ decision: await ai.testAgent(message) });
});

router.post('/ai/digest', async (req, res) => {
  const hours = v.int(req.body?.hours, { label: 'Hours', min: 1, max: 168, fallback: 24 });
  res.json({ digest: await ai.digest({ hours }) });
});

router.post('/ai/write-campaign', async (req, res) => {
  const goal = v.text(req.body?.goal, { label: 'Goal', max: 600 });
  const tone = v.optionalText(req.body?.tone, { label: 'Tone', max: 60 });
  const length = v.optionalText(req.body?.length, { label: 'Length', max: 60 });
  res.json({ text: await ai.writeCampaign({ goal, tone, length }) });
});

router.post('/ai/write-snippet', async (req, res) => {
  const purpose = v.text(req.body?.purpose, { label: 'Purpose', max: 300 });
  const draft = v.optionalText(req.body?.draft, { label: 'Draft' });
  res.json({ text: await ai.writeSnippet({ purpose, draft }) });
});

// ---------- Per chat ----------
router.get('/ai/chats/:chatId', (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  contactOr404(chatId);
  const s = store.getSetting('ai');
  res.json({
    configured: llm.isConfigured(),
    mode: s.mode,
    autoSummary: s.autoSummary,
    summary: ai.cachedSummary(chatId),
    draft: ai.pendingDraft(chatId),
  });
});

router.post('/ai/chats/:chatId/summary', async (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  res.json({ summary: await ai.summarize(chatId, { force: v.bool(req.body?.force) }) });
});

router.post('/ai/chats/:chatId/compose', async (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  const action = v.oneOf(String(req.body?.action || ''), Object.keys(ai.COMPOSE_TASKS), 'Action');
  const draft = v.optionalText(req.body?.draft, { label: 'Draft' });
  res.json({ text: await ai.compose({ chatId, action, draft }) });
});

router.post('/ai/drafts/:id/approve', async (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  const body = req.body?.body !== undefined ? v.text(req.body.body) : undefined;
  const sessionId = req.body?.sessionId ? v.uuid(req.body.sessionId, 'session id') : undefined;
  await ai.approveDraft(id, { body, sessionId });
  res.json({ ok: true });
});

router.post('/ai/drafts/:id/discard', (req, res) => {
  ai.discardDraft(v.int(req.params.id, { label: 'id', min: 1 }));
  res.json({ ok: true });
});

// Clear the AI's "needs a person / unhappy / hot" flag once handled.
router.post('/ai/chats/:chatId/clear-flag', (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  contactOr404(chatId);
  db.prepare('UPDATE contacts SET ai_flag = NULL WHERE chat_id = ?').run(chatId);
  events.publish('contact', { chatId });
  events.publish('ai', { chatId });
  res.json({ contact: store.getContact(chatId) });
});

// ---------- Media library ----------
const mapItem = (r) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  filename: r.filename,
  mime: r.mime,
  size: r.size,
  url: `/api/library/${r.id}/file`,
  createdAt: r.created_at,
});

router.get('/library', (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM library ORDER BY title').all().map(mapItem) });
});

router.post('/library', (req, res) => {
  const title = v.text(req.body?.title, { label: 'Title', max: 80 }).trim();
  const description = v.optionalText(req.body?.description, { label: 'Description', max: 500 }).trim();
  const buffer = media.decodeBase64(req.body?.data);
  if (!buffer || !buffer.length) throw new v.ValidationError('Choose a file to upload.');
  if (buffer.length > media.MAX_MEDIA_BYTES) throw new v.ValidationError(`File is too large (max ${media.MAX_MEDIA_BYTES / 1024 / 1024} MB).`);
  const mime = media.cleanMime(req.body?.mimetype);
  const filename = media.safeFilename(v.optionalText(req.body?.filename, { label: 'File name', max: 200 }), mime);
  const saved = media.saveBuffer(buffer, mime);
  const info = db
    .prepare('INSERT INTO library (title, description, path, mime, filename, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(title, description, saved.path, mime, filename, saved.size, store.now());
  res.status(201).json({ item: mapItem(db.prepare('SELECT * FROM library WHERE id = ?').get(Number(info.lastInsertRowid))) });
});

router.patch('/library/:id', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  const row = db.prepare('SELECT * FROM library WHERE id = ?').get(id);
  if (!row) throw Object.assign(new v.ValidationError('File not found.'), { status: 404 });
  const title = 'title' in (req.body || {}) ? v.text(req.body.title, { label: 'Title', max: 80 }).trim() : row.title;
  const description = 'description' in (req.body || {}) ? v.optionalText(req.body.description, { label: 'Description', max: 500 }).trim() : row.description;
  db.prepare('UPDATE library SET title = ?, description = ? WHERE id = ?').run(title, description, id);
  res.json({ item: mapItem(db.prepare('SELECT * FROM library WHERE id = ?').get(id)) });
});

router.delete('/library/:id', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  const row = db.prepare('SELECT * FROM library WHERE id = ?').get(id);
  if (row) {
    db.prepare('DELETE FROM library WHERE id = ?').run(id);
    media.remove(row.path);
  }
  res.json({ ok: true });
});

router.get('/library/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM library WHERE id = ?').get(v.int(req.params.id, { label: 'id', min: 1 }));
  if (!row) return res.status(404).json({ error: 'File not found.' });
  return media.serve(res, { stored: row.path, mime: row.mime, filename: row.filename });
});

module.exports = router;
