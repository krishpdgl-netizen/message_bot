'use strict';

// Files (photos, documents, voice notes) are stored on the data volume, next to the database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { config } = require('./config');

const MEDIA_DIR = path.join(config.dataDir, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// WhatsApp's own limit for documents is 100 MB, but OpenWA's request body limit is 25 MB of base64.
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

// Types the browser may render inline. Everything else is served as a download, so an uploaded
// HTML or SVG file can never run script on the dashboard's origin.
const INLINE_SAFE = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'application/pdf',
]);

// Images the AI models accept as input.
const VISION_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const MIME_RE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/i;

function cleanMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_RE.test(m) ? m : 'application/octet-stream';
}

// Which OpenWA send endpoint a file goes through.
function kindFromMime(mime) {
  const m = cleanMime(mime);
  if (m === 'image/jpeg' || m === 'image/png' || m === 'image/webp') return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

function safeFilename(name, mime) {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120);
  if (base) return base;
  return `file.${EXT[cleanMime(mime)] || 'bin'}`;
}

function saveBuffer(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty file.');
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error(`File is too large (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).`);
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${EXT[cleanMime(mime)] || 'bin'}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buffer);
  return { path: name, size: buffer.length };
}

// Stored paths are bare file names we generated; never trust anything else.
function resolve(stored) {
  if (!stored || !/^[a-z0-9]+-[a-f0-9]{16}\.[a-z0-9]{1,5}$/.test(stored)) return null;
  const full = path.join(MEDIA_DIR, stored);
  return fs.existsSync(full) ? full : null;
}

function readBuffer(stored) {
  const full = resolve(stored);
  return full ? fs.readFileSync(full) : null;
}

function remove(stored) {
  const full = resolve(stored);
  if (full) fs.rmSync(full, { force: true });
}

function decodeBase64(data) {
  const clean = String(data || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/=_-]+$/.test(clean)) return null;
  return Buffer.from(clean, 'base64');
}

// Express handler body for GET /api/media/:id style routes.
function serve(res, { stored, mime, filename }) {
  const full = resolve(stored);
  if (!full) return res.status(404).json({ error: 'File not found.' });
  const type = cleanMime(mime);
  const inline = INLINE_SAFE.has(type);
  const name = safeFilename(filename, type);
  res.set({
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=86400',
  });
  return res.sendFile(full);
}

module.exports = {
  MEDIA_DIR,
  MAX_MEDIA_BYTES,
  VISION_TYPES,
  cleanMime,
  kindFromMime,
  safeFilename,
  saveBuffer,
  readBuffer,
  remove,
  decodeBase64,
  serve,
};
