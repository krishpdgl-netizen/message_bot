'use strict';

class ValidationError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9-]{3,50}$/;
const PHONE_RE = /^\d{7,15}$/;
const CHAT_ID_RE = /^[0-9A-Za-z._:-]{3,80}@(c\.us|s\.whatsapp\.net|lid)$/;
const TAG_RE = /^[\p{L}\p{N} _-]{1,30}$/u;
const MAX_TEXT = 4096;

const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];

function fail(message) {
  throw new ValidationError(message);
}

function uuid(value, label = 'id') {
  const v = String(value ?? '');
  if (!UUID_RE.test(v)) fail(`Invalid ${label}.`);
  return v.toLowerCase();
}

function sessionName(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!NAME_RE.test(v)) fail('Session name must be 3 to 50 characters: letters, digits and hyphens only.');
  return v;
}

function phone(value) {
  const digits = String(value ?? '').replace(/[\s()+.-]/g, '');
  if (!PHONE_RE.test(digits)) {
    fail('Phone must be 7 to 15 digits in international format without +, for example 919876543210.');
  }
  return digits;
}

function chatId(value) {
  const v = String(value ?? '').trim();
  if (!CHAT_ID_RE.test(v)) fail('Invalid chat id.');
  return v;
}

function text(value, { label = 'Message', max = MAX_TEXT, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') fail(`${label} must be text.`);
  if (required && !value.trim()) fail(`${label} is required.`);
  if (value.length > max) fail(`${label} is too long (max ${max} characters).`);
  return value;
}

function optionalText(value, opts = {}) {
  return text(value, { ...opts, required: false });
}

function int(value, { label = 'Value', min = -Infinity, max = Infinity, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number between ${min} and ${max}.`);
  return n;
}

function bool(value) {
  return value === true || value === 1 || value === 'true' || value === '1' || value === 'on';
}

function oneOf(value, allowed, label = 'Value') {
  if (!allowed.includes(value)) fail(`${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function tags(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const raw of list) {
    const t = String(raw).trim().toLowerCase();
    if (!t) continue;
    if (!TAG_RE.test(t)) fail(`Invalid tag "${t.slice(0, 30)}". Use letters, digits, spaces, hyphens or underscores.`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > 20) fail('A maximum of 20 tags is allowed.');
  return out;
}

function hhmm(value, label) {
  const v = String(value ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail(`${label} must be a time like 09:30.`);
  return v;
}

function timezone(value) {
  const v = String(value ?? '');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
  } catch {
    fail('Unknown time zone. Use a name like Asia/Kolkata.');
  }
  return v;
}

function isoDate(value, label = 'Date') {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) fail(`${label} is not a valid date.`);
  return d.toISOString();
}

function regexPattern(value) {
  const v = text(value, { label: 'Pattern', max: 300 });
  try {
    new RegExp(v, 'i');
  } catch {
    fail('Pattern is not a valid regular expression.');
  }
  return v;
}

module.exports = {
  ValidationError,
  STAGES,
  MAX_TEXT,
  CHAT_ID_RE,
  uuid,
  sessionName,
  phone,
  chatId,
  text,
  optionalText,
  int,
  bool,
  oneOf,
  tags,
  hhmm,
  timezone,
  isoDate,
  regexPattern,
};
