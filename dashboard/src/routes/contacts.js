'use strict';

const express = require('express');
const v = require('../validate');
const store = require('../db');
const events = require('../events');

const { db } = store;
const router = express.Router();
const MAX_IMPORT = 5000;

function buildFilter(query) {
  const where = [];
  const params = [];
  const q = String(query.q || '').trim().slice(0, 60);
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    where.push('(name LIKE ? OR push_name LIKE ? OR phone LIKE ? OR notes LIKE ?)');
    params.push(like, like, like, like);
  }
  if (query.stage) {
    where.push('stage = ?');
    params.push(v.oneOf(String(query.stage), v.STAGES, 'Stage'));
  }
  if (query.tag) {
    const [tag] = v.tags([String(query.tag)]);
    where.push('EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE json_each.value = ?)');
    params.push(tag);
  }
  if (query.optedOut === 'true') where.push('opted_out = 1');
  if (query.optedOut === 'false') where.push('opted_out = 0');
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/contacts', (req, res) => {
  const limit = v.int(req.query.limit, { label: 'limit', min: 1, max: 500, fallback: 100 });
  const offset = v.int(req.query.offset, { label: 'offset', min: 0, fallback: 0 });
  const { sql, params } = buildFilter(req.query);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM contacts ${sql}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM contacts ${sql} ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  res.json({ total, items: rows.map(store.mapContact) });
});

router.get('/tags', (req, res) => {
  const rows = db
    .prepare('SELECT json_each.value AS tag, COUNT(*) AS n FROM contacts, json_each(contacts.tags) GROUP BY tag ORDER BY n DESC')
    .all();
  res.json({ items: rows.map((r) => ({ tag: r.tag, count: r.n })) });
});

function applyContactFields(chatId, body) {
  const fields = {};
  if ('name' in body) fields.name = v.optionalText(body.name, { label: 'Name', max: 100 }).trim() || null;
  if ('stage' in body) fields.stage = v.oneOf(String(body.stage), v.STAGES, 'Stage');
  if ('tags' in body) fields.tags = JSON.stringify(v.tags(body.tags));
  if ('notes' in body) fields.notes = v.optionalText(body.notes, { label: 'Notes', max: 4000 });
  if ('optedOut' in body) fields.opted_out = v.bool(body.optedOut) ? 1 : 0;
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE chat_id = ?`).run(
    ...keys.map((k) => fields[k]),
    store.now(),
    chatId
  );
}

router.post('/contacts', (req, res) => {
  const phone = v.phone(req.body?.phone);
  const chatId = `${phone}@c.us`;
  if (store.getContact(chatId)) throw new v.ValidationError('A contact with this number already exists.');
  store.upsertContact({ chatId, phone, source: 'manual' });
  applyContactFields(chatId, req.body || {});
  events.publish('contact', { chatId });
  res.status(201).json({ contact: store.getContact(chatId) });
});

// Bulk import from CSV rows parsed in the browser: [{ phone, name, tags }]
router.post('/contacts/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || !rows.length) throw new v.ValidationError('No rows to import.');
  if (rows.length > MAX_IMPORT) throw new v.ValidationError(`Import at most ${MAX_IMPORT} rows at a time.`);
  const extraTags = v.tags(req.body?.tags);
  const stage = req.body?.stage ? v.oneOf(String(req.body.stage), v.STAGES, 'Stage') : null;

  const result = { created: 0, updated: 0, invalid: [] };
  store.tx(() => {
    rows.forEach((row, i) => {
      let phone;
      let tags;
      try {
        phone = v.phone(row && row.phone);
        tags = v.tags(row && row.tags);
      } catch (err) {
        if (result.invalid.length < 50) result.invalid.push({ row: i + 1, error: err.message });
        return;
      }
      const chatId = `${phone}@c.us`;
      const name = row.name ? String(row.name).trim().slice(0, 100) : null;
      const { contact, created } = store.upsertContact({ chatId, phone, name, source: 'import' });
      const merged = [...new Set([...contact.tags, ...tags, ...extraTags])];
      const fields = { tags: merged };
      if (name) fields.name = name;
      if (stage && created) fields.stage = stage;
      applyContactFields(chatId, fields);
      result[created ? 'created' : 'updated'] += 1;
    });
  });
  events.publish('contact', {});
  res.json(result);
});

router.patch('/contacts/:chatId', (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  if (!store.getContact(chatId)) throw Object.assign(new v.ValidationError('Contact not found.'), { status: 404 });
  applyContactFields(chatId, req.body || {});
  events.publish('contact', { chatId });
  res.json({ contact: store.getContact(chatId) });
});

router.delete('/contacts/:chatId', (req, res) => {
  const chatId = v.chatId(req.params.chatId);
  store.tx(() => {
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM contacts WHERE chat_id = ?').run(chatId);
  });
  events.publish('contact', { chatId, deleted: true });
  res.json({ ok: true });
});

// CSV export of the current filter. Cells are quoted and formula-escaped for spreadsheet safety.
router.get('/contacts/export.csv', (req, res) => {
  const { sql, params } = buildFilter(req.query);
  const rows = db.prepare(`SELECT * FROM contacts ${sql} ORDER BY created_at`).all(...params).map(store.mapContact);
  const cell = (value) => {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = ['phone', 'name', 'whatsapp_name', 'stage', 'tags', 'opted_out', 'notes', 'last_message_at', 'created_at'];
  const lines = [header.join(',')];
  for (const c of rows) {
    lines.push(
      [c.phone, c.name, c.pushName, c.stage, c.tags.join(';'), c.optedOut ? 'yes' : 'no', c.notes, c.lastMessageAt, c.createdAt]
        .map(cell)
        .join(',')
    );
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

module.exports = router;
