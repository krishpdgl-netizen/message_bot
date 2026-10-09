'use strict';

const { config } = require('./config');

class UpstreamError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function upstreamMessage(data, status) {
  const m = data && (data.message ?? data.error);
  if (Array.isArray(m)) return m.map(String).join('; ').slice(0, 300);
  if (typeof m === 'string' && m.trim()) return m.slice(0, 300);
  if (m && typeof m === 'object' && typeof m.message === 'string') return m.message.slice(0, 300);
  return `Gateway returned HTTP ${status}.`;
}

// Raw call: never throws on HTTP status, only on network failure / timeout.
async function call(method, apiPath, body) {
  const headers = { 'X-API-Key': config.openwaApiKey, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(config.openwaUrl + apiPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  });

  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw.slice(0, 500) };
    }
  }
  return { status: res.status, data };
}

// Convenience wrapper that throws UpstreamError on any non-2xx (status 0 = unreachable).
async function request(method, apiPath, body) {
  let result;
  try {
    result = await call(method, apiPath, body);
  } catch (err) {
    throw new UpstreamError('WhatsApp gateway is unreachable.', 0, { cause: err.name });
  }
  if (result.status >= 400) throw new UpstreamError(upstreamMessage(result.data, result.status), result.status, result.data);
  return result.data;
}

function listFrom(data, keys = ['data', 'sessions', 'webhooks', 'items', 'results']) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of keys) if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

async function listSessions() {
  return listFrom(await request('GET', '/api/sessions'));
}

async function sendText(sessionId, chatId, text) {
  const data = await request('POST', `/api/sessions/${sessionId}/messages/send-text`, { chatId, text });
  const messageId = data && (data.messageId || data.id || (data.data && (data.data.messageId || data.data.id)));
  return { messageId: messageId ? String(messageId) : null, data };
}

// kind: image | video | audio | document. The file goes as base64 (OpenWA never needs to reach us).
async function sendMedia(sessionId, chatId, kind, { buffer, mimetype, filename, caption }) {
  const route = { image: 'send-image', video: 'send-video', audio: 'send-audio', document: 'send-document' }[kind] || 'send-document';
  const body = { chatId, base64: buffer.toString('base64'), mimetype };
  if (filename && kind === 'document') body.filename = filename.slice(0, 255);
  if (caption && kind !== 'audio') body.caption = caption.slice(0, 1024);
  const data = await requestWithTimeout('POST', `/api/sessions/${sessionId}/messages/${route}`, body, 120000);
  const messageId = data && (data.messageId || data.id || (data.data && (data.data.messageId || data.data.id)));
  return { messageId: messageId ? String(messageId) : null, data };
}

// Downloads the stored media of a message (used when the webhook left it out because it was large).
async function downloadMedia(sessionId, chatId, messageId) {
  let res;
  try {
    res = await fetch(
      `${config.openwaUrl}/api/sessions/${sessionId}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`,
      { headers: { 'X-API-Key': config.openwaApiKey }, signal: AbortSignal.timeout(60000) }
    );
  } catch (err) {
    throw new UpstreamError('WhatsApp gateway is unreachable.', 0, { cause: err.name });
  }
  if (!res.ok) throw new UpstreamError(`Media download failed (HTTP ${res.status}).`, res.status, null);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime: res.headers.get('content-type') || 'application/octet-stream' };
}

async function requestWithTimeout(method, apiPath, body, timeoutMs) {
  const headers = { 'X-API-Key': config.openwaApiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
  let res;
  try {
    res = await fetch(config.openwaUrl + apiPath, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new UpstreamError('WhatsApp gateway is unreachable.', 0, { cause: err.name });
  }
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { message: raw.slice(0, 500) };
  }
  if (res.status >= 400) throw new UpstreamError(upstreamMessage(data, res.status), res.status, data);
  return data;
}

// Returns true / false when the gateway gives a clear answer, otherwise null.
async function isOnWhatsApp(sessionId, phone) {
  const data = await request('GET', `/api/sessions/${sessionId}/contacts/check/${phone}`);
  for (const src of [data, data && data.data, data && data.result]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of ['exists', 'isRegistered', 'registered', 'numberExists', 'onWhatsApp', 'isOnWhatsApp']) {
      if (typeof src[k] === 'boolean') return src[k];
    }
  }
  return null;
}

async function listWebhooks(sessionId) {
  return listFrom(await request('GET', `/api/sessions/${sessionId}/webhooks`));
}

async function createWebhook(sessionId, body) {
  return request('POST', `/api/sessions/${sessionId}/webhooks`, body);
}

async function deleteWebhook(sessionId, webhookId) {
  return request('DELETE', `/api/sessions/${sessionId}/webhooks/${encodeURIComponent(webhookId)}`);
}

module.exports = {
  UpstreamError,
  upstreamMessage,
  call,
  request,
  listSessions,
  sendText,
  sendMedia,
  downloadMedia,
  isOnWhatsApp,
  listWebhooks,
  createWebhook,
  deleteWebhook,
};
