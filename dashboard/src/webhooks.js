'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { config } = require('./config');
const store = require('./db');
const events = require('./events');
const openwa = require('./openwa');
const automation = require('./automation');
const media = require('./media');
const { canonicalChatId, phoneFromChatId } = require('./messaging');

const { db } = store;
const SUBSCRIBED_EVENTS = ['message.received', 'message.sent', 'message.ack', 'session.status'];
const status = new Map(); // sessionId -> { state, error, checkedAt }

// ---------- Signature ----------
function validSignature(rawBody, header) {
  if (!config.webhookSecret || typeof header !== 'string') return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Event handlers ----------
function shouldIgnore(msg) {
  const chatId = String(msg.chatId || '');
  return (
    msg.isGroup ||
    msg.isStatusBroadcast ||
    chatId.endsWith('@g.us') ||
    chatId.endsWith('@broadcast') ||
    chatId.endsWith('@newsletter')
  );
}

// Media arrives inline as base64 when small; larger files come as an "omitted" marker and are
// downloaded from OpenWA afterwards.
function extractMedia(msg) {
  const m = msg && msg.media;
  if (!m || typeof m !== 'object') return null;
  const mime = media.cleanMime(m.mimetype);
  const filename = typeof m.filename === 'string' ? media.safeFilename(m.filename, mime) : null;
  const out = { mime, filename, size: Number(m.sizeBytes) || null, path: null, state: 'unavailable' };
  if (typeof m.data === 'string' && m.data && !/^https?:/i.test(m.data) && !m.omitted) {
    const buffer = media.decodeBase64(m.data);
    if (buffer && buffer.length) {
      try {
        const saved = media.saveBuffer(buffer, mime);
        return { ...out, path: saved.path, size: saved.size, state: 'stored' };
      } catch (err) {
        console.warn(`[webhook] could not store media: ${err.message}`);
        return out;
      }
    }
  }
  if (msg.id && (!out.size || out.size <= media.MAX_MEDIA_BYTES)) out.state = 'pending';
  return out;
}

async function fetchPendingMedia(sessionId, chatId, rawChatId, message) {
  if (!message || !message.waId) return;
  for (const id of [rawChatId, chatId]) {
    try {
      const { buffer, mime } = await openwa.downloadMedia(sessionId, id, message.waId);
      const saved = media.saveBuffer(buffer, message.media?.mime || mime);
      db.prepare("UPDATE messages SET media_path = ?, media_size = ?, media_state = 'stored' WHERE id = ?").run(saved.path, saved.size, message.id);
      events.publish('message', { chatId, message: store.mapMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id)) });
      return;
    } catch {
      /* try the other id form, then give up */
    }
  }
  db.prepare("UPDATE messages SET media_state = 'unavailable' WHERE id = ?").run(message.id);
  events.publish('message', { chatId });
}

function mediaFields(found) {
  if (!found) return {};
  return { mediaPath: found.path, mediaMime: found.mime, mediaName: found.filename, mediaSize: found.size, mediaState: found.state };
}

async function onMessageReceived(sessionId, msg) {
  if (!msg || shouldIgnore(msg)) return;
  if (msg.fromMe) return onMessageSent(sessionId, msg);

  const chatId = canonicalChatId(msg.chatId || msg.from);
  if (!chatId) return;
  const phone = phoneFromChatId(chatId) || (msg.senderPhone && /^\d{7,15}$/.test(msg.senderPhone) ? msg.senderPhone : null);
  const pushName = (msg.contact && (msg.contact.pushName || msg.contact.name || msg.contact.verifiedName)) || null;

  const { created: isNewContact } = store.upsertContact({ chatId, sessionId, phone, pushName, source: 'inbound' });
  const createdAt = msg.timestamp ? new Date(Number(msg.timestamp) * (msg.timestamp < 1e12 ? 1000 : 1)).toISOString() : undefined;
  const body = typeof msg.body === 'string' ? msg.body : '';
  const found = extractMedia(msg);

  const { message, created } = store.recordMessage({
    sessionId,
    chatId,
    waId: msg.id ? String(msg.id) : null,
    direction: 'in',
    body,
    type: msg.type || 'chat',
    source: 'contact',
    createdAt,
    ...mediaFields(found),
  });
  if (!created) {
    if (found && found.path) media.remove(found.path);
    return; // duplicate delivery
  }

  events.publish('message', { chatId, message });
  if (found && found.state === 'pending') await fetchPendingMedia(sessionId, chatId, msg.chatId || msg.from, message);
  await automation.handleInbound({ sessionId, contact: store.getContact(chatId), body, isNewContact, message });
}

function onMessageSent(sessionId, msg) {
  if (!msg || shouldIgnore(msg)) return;
  const chatId = canonicalChatId(msg.chatId || msg.to);
  if (!chatId) return;
  store.upsertContact({ chatId, sessionId, phone: phoneFromChatId(chatId), source: 'outbound' });
  // Messages we sent ourselves are already stored; this records ones typed on the phone.
  // Our own media sends are stored already, so only take the inline copy for phone-sent files.
  const waId = msg.id ? String(msg.id) : null;
  const known = waId && db.prepare('SELECT 1 FROM messages WHERE wa_id = ?').get(waId);
  const found = known ? null : extractMedia(msg);
  if (found && found.state === 'pending') found.state = 'unavailable';
  const { message, created } = store.recordMessage({
    sessionId,
    chatId,
    waId,
    direction: 'out',
    body: typeof msg.body === 'string' ? msg.body : '',
    type: msg.type || 'chat',
    status: 'sent',
    source: 'phone',
    ...mediaFields(found),
  });
  if (!created && found && found.path) media.remove(found.path);
  if (created) events.publish('message', { chatId, message });
}

function onMessageAck(data) {
  const waId = data && (data.messageId || data.id);
  const ack = data && typeof data.status === 'string' ? data.status : null;
  if (!waId || !ack) return;
  const order = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  const row = db.prepare('SELECT id, chat_id, status FROM messages WHERE wa_id = ?').get(String(waId));
  if (!row) return;
  // Never move a receipt backwards (read -> delivered), except to failed.
  if (ack !== 'failed' && (order[row.status] ?? 0) >= (order[ack] ?? 0)) return;
  db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(ack, row.id);
  events.publish('ack', { chatId: row.chat_id, id: row.id, status: ack });
}

// ---------- Receiver route ----------
const router = express.Router();

router.post('/openwa', express.raw({ type: '*/*', limit: '15mb' }), (req, res) => {
  if (!config.webhookSecret) return res.status(503).json({ error: 'Webhooks are not configured.' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!validSignature(raw, req.get('x-openwa-signature'))) return res.status(401).json({ error: 'Bad signature.' });

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON.' });
  }

  // Acknowledge fast; OpenWA retries on slow or failed responses.
  res.status(200).json({ ok: true });

  const key = payload.idempotencyKey || req.get('x-openwa-idempotency-key');
  if (!store.markEventProcessed(key)) return;

  const event = payload.event || req.get('x-openwa-event');
  const sessionId = String(payload.sessionId || '');
  const data = payload.data || {};

  Promise.resolve()
    .then(() => {
      if (event === 'message.received') return onMessageReceived(sessionId, data);
      if (event === 'message.sent') return onMessageSent(sessionId, data);
      if (event === 'message.ack') return onMessageAck(data);
      if (event && event.startsWith('session.')) return events.publish('session', { sessionId });
      return undefined;
    })
    .catch((err) => console.error(`[webhook] failed to process ${event}: ${err.message}`));
});

// ---------- Registration with OpenWA ----------
const secretFingerprint = () => crypto.createHash('sha256').update(config.webhookSecret).digest('hex').slice(0, 16);

async function ensureForSession(sessionId) {
  if (!config.webhookSecret) {
    status.set(sessionId, { state: 'disabled', error: 'WEBHOOK_SECRET is not set', checkedAt: store.now() });
    return status.get(sessionId);
  }
  try {
    const registry = store.getSetting('webhookRegistry') || {};
    const hooks = await openwa.listWebhooks(sessionId);
    const ours = hooks.filter((h) => h && h.url === config.webhookUrl);
    const entry = registry[sessionId];
    const healthy =
      ours.length === 1 &&
      entry &&
      entry.id === ours[0].id &&
      entry.secret === secretFingerprint() &&
      ours[0].active !== false &&
      SUBSCRIBED_EVENTS.every((e) => Array.isArray(ours[0].events) && (ours[0].events.includes(e) || ours[0].events.includes('*')));

    if (!healthy) {
      // Secrets cannot be read back, so replace anything we cannot prove is current.
      for (const hook of ours) await openwa.deleteWebhook(sessionId, hook.id);
      const created = await openwa.createWebhook(sessionId, {
        url: config.webhookUrl,
        events: SUBSCRIBED_EVENTS,
        secret: config.webhookSecret,
        retryCount: 3,
      });
      const id = created && (created.id || (created.data && created.data.id));
      registry[sessionId] = { id, secret: secretFingerprint() };
      store.setSetting('webhookRegistry', registry);
      console.log('[webhook] registered receiver for a session');
    }
    status.set(sessionId, { state: 'active', error: null, checkedAt: store.now() });
  } catch (err) {
    status.set(sessionId, { state: 'error', error: err.message, checkedAt: store.now() });
  }
  return status.get(sessionId);
}

async function ensureAll() {
  if (!config.autoRegisterWebhooks) return;
  let sessions;
  try {
    sessions = await openwa.listSessions();
  } catch {
    return; // gateway down; try again next round
  }
  for (const s of sessions) {
    if (s && typeof s.id === 'string') await ensureForSession(s.id);
  }
}

function startRegistrationLoop() {
  setTimeout(ensureAll, 4000).unref();
  setInterval(ensureAll, 5 * 60 * 1000).unref();
  setInterval(store.pruneOldEvents, 6 * 3600 * 1000).unref();
}

function getStatus() {
  return Object.fromEntries(status);
}

module.exports = { router, ensureForSession, ensureAll, startRegistrationLoop, getStatus, validSignature };
