'use strict';

const openwa = require('./openwa');
const store = require('./db');
const events = require('./events');
const media = require('./media');

// WhatsApp ids arrive as either @c.us or @s.whatsapp.net depending on the engine.
// Store one canonical form so the same person never becomes two contacts.
function canonicalChatId(chatId) {
  if (!chatId) return null;
  const v = String(chatId).trim();
  return v.endsWith('@s.whatsapp.net') ? v.replace(/@s\.whatsapp\.net$/, '@c.us') : v;
}

function phoneFromChatId(chatId) {
  const m = /^(\d{7,15})@c\.us$/.exec(chatId || '');
  return m ? m[1] : null;
}

function render(template, contact) {
  const display = (contact && (contact.name || contact.pushName)) || 'there';
  const first = display.split(/\s+/)[0] || display;
  const phone = (contact && contact.phone) || '';
  return String(template)
    .replace(/\{\{\s*name\s*\}\}/gi, display)
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*phone\s*\}\}/gi, phone);
}

/**
 * Sends a text through OpenWA and records it in the inbox.
 * source: manual | auto | campaign | api
 */
async function sendAndRecord({ sessionId, chatId, text, source, ruleId, campaignId }) {
  const { messageId } = await openwa.sendText(sessionId, chatId, text);
  store.upsertContact({ chatId, sessionId, phone: phoneFromChatId(chatId), source: 'outbound' });
  const { message } = store.recordMessage({
    sessionId,
    chatId,
    waId: messageId,
    direction: 'out',
    body: text,
    type: 'chat',
    status: 'sent',
    source,
    ruleId,
    campaignId,
  });
  events.publish('message', { chatId, message });
  return { messageId, message };
}

const TYPE_FOR_KIND = { image: 'image', video: 'video', audio: 'audio', document: 'document' };

/**
 * Sends a file (photo, video, audio, document) with an optional caption and records it in the inbox.
 * The file is kept on the data volume so the thread can show it.
 */
async function sendMediaAndRecord({ sessionId, chatId, buffer, mime, filename, caption, source, ruleId, campaignId }) {
  const mimetype = media.cleanMime(mime);
  const kind = media.kindFromMime(mimetype);
  const name = media.safeFilename(filename, mimetype);
  const stored = media.saveBuffer(buffer, mimetype);
  let messageId;
  try {
    ({ messageId } = await openwa.sendMedia(sessionId, chatId, kind, { buffer, mimetype, filename: name, caption }));
  } catch (err) {
    media.remove(stored.path);
    throw err;
  }
  store.upsertContact({ chatId, sessionId, phone: phoneFromChatId(chatId), source: 'outbound' });
  const { message } = store.recordMessage({
    sessionId,
    chatId,
    waId: messageId,
    direction: 'out',
    body: caption || '',
    type: TYPE_FOR_KIND[kind],
    status: 'sent',
    source,
    ruleId,
    campaignId,
    mediaPath: stored.path,
    mediaMime: mimetype,
    mediaName: name,
    mediaSize: stored.size,
    mediaState: 'stored',
  });
  events.publish('message', { chatId, message });
  return { messageId, message };
}

// Sends one item from the media library.
async function sendLibraryItem({ sessionId, chatId, itemId, caption, source }) {
  const item = store.db.prepare('SELECT * FROM library WHERE id = ?').get(itemId);
  if (!item) throw new Error('Library file not found.');
  const buffer = media.readBuffer(item.path);
  if (!buffer) throw new Error('Library file is missing on disk.');
  return sendMediaAndRecord({ sessionId, chatId, buffer, mime: item.mime, filename: item.filename, caption, source });
}

module.exports = { canonicalChatId, phoneFromChatId, render, sendAndRecord, sendMediaAndRecord, sendLibraryItem };
