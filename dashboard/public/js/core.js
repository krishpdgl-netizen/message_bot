// Shared helpers: API client, DOM builder (no innerHTML), toasts, dialogs, live events.

export const $ = (id) => document.getElementById(id);

export const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
export const STAGE_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
};

// ---------- API ----------
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Cannot reach the dashboard server. Check your connection.', 0, null);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }
  if (res.status === 401) throw new ApiError('Your login expired. Reload the page to sign in again.', 401, data);
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (HTTP ${res.status}).`, res.status, data);
  return data;
}

export const enc = encodeURIComponent;

// ---------- DOM ----------
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'selected') node.selected = Boolean(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function setBusy(btn, busy, busyLabel = 'Working...') {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = busyLabel;
    btn.disabled = true;
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = false;
  }
}

// Runs an async action with a busy button and a toast on failure. Returns the result or undefined.
export async function withBusy(btn, label, fn) {
  setBusy(btn, true, label);
  try {
    return await fn();
  } catch (err) {
    toast(err.message);
    return undefined;
  } finally {
    setBusy(btn, false);
  }
}

export function toast(message, type = 'error', ms = 5000) {
  const node = el(
    'div',
    { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    el('span', { text: message }),
    el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', text: '×', onclick: () => node.remove() })
  );
  $('toasts').append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 300);
  }, ms);
}

export function field(label, control, hint) {
  return el('label', { class: 'field' }, el('span', { text: label }), control, hint ? el('small', { class: 'hint', text: hint }) : null);
}

export function emptyState(text) {
  return el('p', { class: 'empty', text });
}

// ---------- Dialog ----------
// openDialog({ title, body: Node, actions: [{ label, primary, danger, onClick(close) }] })
export function openDialog({ title, body, actions = [], wide = false }) {
  const dialog = el('dialog', { class: `dialog${wide ? ' wide' : ''}`, 'aria-label': title });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const footer = el(
    'div',
    { class: 'dialog-actions' },
    el('button', { type: 'button', class: 'btn ghost', text: 'Cancel', onclick: close }),
    ...actions.map((a) =>
      el('button', {
        type: 'button',
        class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
        text: a.label,
        onclick: (ev) => a.onClick(close, ev.currentTarget),
      })
    )
  );
  dialog.append(
    el('div', { class: 'dialog-head' }, el('h2', { text: title }), el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: close })),
    el('div', { class: 'dialog-body' }, body),
    footer
  );
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

export function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const { dialog } = openDialog({
      title,
      body: el('p', { text: message }),
      actions: [
        {
          label: confirmLabel,
          primary: !danger,
          danger,
          onClick: (close) => {
            done = true;
            close();
            resolve(true);
          },
        },
      ],
    });
    dialog.addEventListener('close', () => !done && resolve(false));
  });
}

// ---------- Formatting ----------
export function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function relativeTime(value) {
  if (!value) return '';
  const d = new Date(value);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 7 * 86400) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const isPaused = (contact) => Boolean(contact && contact.botPausedUntil && contact.botPausedUntil > new Date().toISOString());

export function stageBadge(stage) {
  return el('span', { class: `stage stage-${stage}`, text: STAGE_LABELS[stage] || stage });
}

export function tagChips(tags = []) {
  return el('span', { class: 'chips' }, ...tags.map((t) => el('span', { class: 'chip', text: t })));
}

// Minimal CSV parser (quotes, commas, newlines). Returns array of rows (arrays of strings).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

// Turns pasted lines or CSV into [{ phone, name, tags }]. Detects a header row.
export function rowsToRecipients(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) return [];
  let phoneIdx = 0;
  let nameIdx = 1;
  let tagsIdx = -1;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (header.some((h) => /phone|number|mobile|whatsapp/.test(h))) {
    phoneIdx = header.findIndex((h) => /phone|number|mobile|whatsapp/.test(h));
    nameIdx = header.findIndex((h) => /name/.test(h));
    tagsIdx = header.findIndex((h) => /tag/.test(h));
    rows.shift();
  }
  return rows.map((r) => ({
    phone: (r[phoneIdx] || '').trim(),
    name: nameIdx >= 0 ? (r[nameIdx] || '').trim() : '',
    tags: tagsIdx >= 0 ? (r[tagsIdx] || '').split(/[|/]/).map((t) => t.trim()).filter(Boolean) : [],
  }));
}

// ---------- Shared state ----------
export const state = {
  sessions: [],
  readySessions: [],
};

const listeners = new Map();
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
}
export function emit(type, payload) {
  for (const fn of listeners.get(type) || []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err);
    }
  }
}

// One SSE stream for the whole app; re-emitted on the local bus.
export function connectEvents() {
  const source = new EventSource('/api/events');
  for (const type of ['message', 'ack', 'contact', 'campaign', 'session']) {
    source.addEventListener(type, (e) => {
      let payload = {};
      try {
        payload = JSON.parse(e.data);
      } catch {
        /* ignore */
      }
      emit(`live:${type}`, payload);
    });
  }
  source.onopen = () => emit('live:open');
  source.onerror = () => emit('live:error');
}

export function sessionLabel(s) {
  return s.phone ? `${s.name} (${s.phone})` : s.name;
}

export function sessionOptions(select, { includeAny = false, anyLabel = 'Any session', readyOnly = false, selected } = {}) {
  const list = readyOnly ? state.readySessions : state.sessions;
  const opts = [];
  if (includeAny) opts.push(el('option', { value: '', text: anyLabel }));
  for (const s of list) opts.push(el('option', { value: s.id, text: sessionLabel(s) }));
  if (!opts.length) opts.push(el('option', { value: '', text: readyOnly ? 'No ready sessions' : 'No sessions' }));
  select.replaceChildren(...opts);
  if (selected !== undefined && [...select.options].some((o) => o.value === selected)) select.value = selected;
}
