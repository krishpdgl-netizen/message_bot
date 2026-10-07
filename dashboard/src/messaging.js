'use strict';

const openwa = require('./openwa');
const store = require('./db');
const events = require('./events');

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

module.exports = { canonicalChatId, phoneFromChatId, render, sendAndRecord };
