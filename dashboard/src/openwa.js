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
  isOnWhatsApp,
  listWebhooks,
  createWebhook,
  deleteWebhook,
};
