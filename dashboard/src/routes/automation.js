'use strict';

const express = require('express');
const v = require('../validate');
const store = require('../db');
const { ruleMatches } = require('../automation');
const { isOpen } = require('../schedule');

const { db } = store;
const router = express.Router();

const MATCH_TYPES = ['contains', 'exact', 'starts_with', 'regex', 'any'];
const SCHEDULES = ['always', 'business_hours', 'after_hours'];

function parseRule(body, partial = false) {
  const out = {};
  const has = (k) => !partial || k in body;

  if (has('name')) out.name = v.text(body.name, { label: 'Name', max: 80 }).trim();
  if (has('matchType')) out.match_type = v.oneOf(String(body.matchType), MATCH_TYPES, 'Match type');

  const matchType = out.match_type ?? body.matchType;
  if (has('pattern') || has('matchType')) {
    if (matchType === 'any') out.pattern = '';
    else if (matchType === 'regex') out.pattern = v.regexPattern(body.pattern);
    else out.pattern = v.text(body.pattern, { label: 'Keywords', max: 500 }).trim();
  }
  if (has('reply')) out.reply = v.text(body.reply, { label: 'Reply' });
  if (has('enabled')) out.enabled = v.bool(body.enabled ?? true) ? 1 : 0;
  if (has('sessionId')) out.session_id = body.sessionId ? v.uuid(body.sessionId, 'session id') : null;
  if (has('priority')) out.priority = v.int(body.priority, { label: 'Priority', min: 0, max: 10000, fallback: 100 });
  if (has('schedule')) out.schedule = v.oneOf(String(body.schedule || 'always'), SCHEDULES, 'Schedule');
  if (has('cooldownMinutes')) {
    out.cooldown_minutes = v.int(body.cooldownMinutes, { label: 'Cooldown', min: 0, max: 43200, fallback: 60 });
  }
  if (has('addTags')) out.add_tags = JSON.stringify(v.tags(body.addTags));
  if (has('pauseBot')) out.pause_bot = v.bool(body.pauseBot) ? 1 : 0;
  if (has('setStage')) out.set_stage = body.setStage ? v.oneOf(String(body.setStage), v.STAGES, 'Stage') : null;
  return out;
}

const ruleOr404 = (id) => {
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
  if (!row) throw Object.assign(new v.ValidationError('Rule not found.'), { status: 404 });
  return row;
};

router.get('/rules', (req, res) => {
  const rows = db.prepare('SELECT * FROM rules ORDER BY priority ASC, id ASC').all();
  res.json({ items: rows.map(store.mapRule) });
});

router.post('/rules', (req, res) => {
  const r = parseRule(req.body || {});
  const ts = store.now();
  const info = db
    .prepare(
      `INSERT INTO rules (name, enabled, match_type, pattern, reply, session_id, priority, schedule, cooldown_minutes, add_tags, set_stage, pause_bot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(r.name, r.enabled, r.match_type, r.pattern, r.reply, r.session_id, r.priority, r.schedule, r.cooldown_minutes, r.add_tags, r.set_stage, r.pause_bot, ts, ts);
  res.status(201).json({ rule: store.mapRule(ruleOr404(Number(info.lastInsertRowid))) });
});

router.patch('/rules/:id', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  const current = store.mapRule(ruleOr404(id));
  // Validate against the merged rule so pattern and match type stay consistent.
  const merged = { ...current, ...(req.body || {}) };
  const fields = parseRule(merged);
  const keys = Object.keys(fields);
  db.prepare(`UPDATE rules SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    store.now(),
    id
  );
  res.json({ rule: store.mapRule(ruleOr404(id)) });
});

router.delete('/rules/:id', (req, res) => {
  const id = v.int(req.params.id, { label: 'id', min: 1 });
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  res.json({ ok: true });
});

// "Which rule would answer this message right now?"
router.post('/rules/test', (req, res) => {
  const body = v.text(req.body?.text, { label: 'Test message', max: 1000 });
  const open = isOpen();
  const rules = db.prepare('SELECT * FROM rules WHERE enabled = 1 ORDER BY priority ASC, id ASC').all().map(store.mapRule);
  const hit = rules.find(
    (r) =>
      (r.schedule === 'always' || (r.schedule === 'business_hours' ? open : !open)) && ruleMatches(r, body)
  );
  res.json({ open, rule: hit || null });
});

// ---------- Saved replies (quick replies in the inbox) ----------
router.get('/saved-replies', (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM saved_replies ORDER BY title').all() });
});

router.post('/saved-replies', (req, res) => {
  const title = v.text(req.body?.title, { label: 'Title', max: 60 }).trim();
  const body = v.text(req.body?.body, { label: 'Reply text' });
  const info = db.prepare('INSERT INTO saved_replies (title, body, created_at) VALUES (?, ?, ?)').run(title, body, store.now());
  res.status(201).json({ item: db.prepare('SELECT * FROM saved_replies WHERE id = ?').get(Number(info.lastInsertRowid)) });
});

router.delete('/saved-replies/:id', (req, res) => {
  db.prepare('DELETE FROM saved_replies WHERE id = ?').run(v.int(req.params.id, { label: 'id', min: 1 }));
  res.json({ ok: true });
});

// ---------- Settings ----------
const keywordList = (value, label) => {
  const list = (Array.isArray(value) ? value : String(value || '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  if (list.length > 20) throw new v.ValidationError(`${label}: at most 20 keywords.`);
  list.forEach((k) => {
    if (k.length > 30) throw new v.ValidationError(`${label}: keywords must be 30 characters or less.`);
  });
  return list;
};

const SETTING_PARSERS = {
  businessHours: (b) => {
    const days = (Array.isArray(b.days) ? b.days : []).map((d) => v.int(d, { label: 'Day', min: 0, max: 6 }));
    return {
      enabled: v.bool(b.enabled),
      timezone: v.timezone(b.timezone),
      days: [...new Set(days)].sort(),
      start: v.hhmm(b.start, 'Opening time'),
      end: v.hhmm(b.end, 'Closing time'),
    };
  },
  welcome: (b) => ({ enabled: v.bool(b.enabled), text: v.optionalText(b.text, { label: 'Welcome message' }) }),
  away: (b) => ({
    enabled: v.bool(b.enabled),
    text: v.optionalText(b.text, { label: 'Away message' }),
    cooldownHours: v.int(b.cooldownHours, { label: 'Away cooldown', min: 1, max: 168, fallback: 12 }),
  }),
  optOut: (b) => ({
    enabled: v.bool(b.enabled),
    keywords: keywordList(b.keywords, 'Opt-out keywords'),
    optInKeywords: keywordList(b.optInKeywords, 'Opt-in keywords'),
    reply: v.optionalText(b.reply, { label: 'Opt-out reply' }),
    optInReply: v.optionalText(b.optInReply, { label: 'Opt-in reply' }),
  }),
  humanTakeover: (b) => ({
    pauseMinutes: v.int(b.pauseMinutes, { label: 'Pause after manual reply', min: 0, max: 10080, fallback: 60 }),
  }),
  safety: (b) => ({
    maxAutoRepliesPerHour: v.int(b.maxAutoRepliesPerHour, { label: 'Max auto-replies per hour', min: 1, max: 50, fallback: 5 }),
  }),
  campaigns: (b) => {
    const minDelay = v.int(b.minDelay, { label: 'Minimum delay', min: 3, max: 3600, fallback: 8 });
    const maxDelay = v.int(b.maxDelay, { label: 'Maximum delay', min: 3, max: 3600, fallback: 20 });
    if (maxDelay < minDelay) throw new v.ValidationError('Maximum delay must be at least the minimum delay.');
    return { dailyCap: v.int(b.dailyCap, { label: 'Daily cap', min: 0, max: 10000, fallback: 200 }), minDelay, maxDelay };
  },
};

router.get('/settings', (req, res) => {
  res.json({ settings: store.getAllSettings(), open: isOpen() });
});

router.put('/settings/:key', (req, res) => {
  const parse = SETTING_PARSERS[req.params.key];
  if (!parse) throw Object.assign(new v.ValidationError('Unknown setting.'), { status: 404 });
  const value = parse(req.body || {});
  store.setSetting(req.params.key, value);
  res.json({ key: req.params.key, value: store.getSetting(req.params.key), open: isOpen() });
});

module.exports = router;
