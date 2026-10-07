// Leads tab: mini CRM with pipeline stages, tags, import and export.
import {
  $, api, el, enc, toast, withBusy, on, emit, openDialog, confirmDialog, field, emptyState,
  STAGES, STAGE_LABELS, stageBadge, tagChips, relativeTime, rowsToRecipients,
} from './core.js';

const PAGE = 100;
const local = { q: '', stage: '', tag: '', optedOut: '', offset: 0, total: 0, items: [], tags: [], stageCounts: {}, active: false };

function query(extra = {}) {
  const p = new URLSearchParams();
  if (local.q) p.set('q', local.q);
  if (local.stage) p.set('stage', local.stage);
  if (local.tag) p.set('tag', local.tag);
  if (local.optedOut) p.set('optedOut', local.optedOut);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

async function load() {
  try {
    const [list, tags, stats] = await Promise.all([
      api(`/contacts?${query({ limit: PAGE, offset: local.offset })}`),
      api('/tags'),
      api('/stats'),
    ]);
    local.items = list.items;
    local.total = list.total;
    local.tags = tags.items;
    local.stageCounts = Object.fromEntries(stats.stages.map((s) => [s.stage, s.n]));
    render();
  } catch (err) {
    toast(err.message);
  }
}

function pipeline() {
  const total = Object.values(local.stageCounts).reduce((a, b) => a + b, 0);
  const pill = (value, label, count) =>
    el(
      'button',
      {
        type: 'button',
        class: `pipe${local.stage === value ? ' active' : ''} pipe-${value || 'all'}`,
        onclick: () => {
          local.stage = value;
          local.offset = 0;
          load();
        },
      },
      el('span', { text: label }),
      el('strong', { text: String(count || 0) })
    );
  return el('div', { class: 'pipeline' }, pill('', 'All leads', total), ...STAGES.map((s) => pill(s, STAGE_LABELS[s], local.stageCounts[s])));
}

function toolbar() {
  const search = el('input', { type: 'search', placeholder: 'Search name, number or notes', value: local.q, 'aria-label': 'Search leads' });
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      local.q = search.value.trim();
      local.offset = 0;
      load();
    }, 300);
  });

  const tagSel = el(
    'select',
    { 'aria-label': 'Filter by tag', onchange: (e) => { local.tag = e.target.value; local.offset = 0; load(); } },
    el('option', { value: '', text: 'All tags' }),
    ...local.tags.map((t) => el('option', { value: t.tag, text: `${t.tag} (${t.count})`, selected: t.tag === local.tag }))
  );
  const optSel = el(
    'select',
    { 'aria-label': 'Opt-out filter', onchange: (e) => { local.optedOut = e.target.value; local.offset = 0; load(); } },
    el('option', { value: '', text: 'Everyone', selected: local.optedOut === '' }),
    el('option', { value: 'false', text: 'Subscribed', selected: local.optedOut === 'false' }),
    el('option', { value: 'true', text: 'Opted out', selected: local.optedOut === 'true' })
  );

  return el(
    'div',
    { class: 'toolbar' },
    search,
    tagSel,
    optSel,
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'btn ghost', text: 'Export CSV', onclick: () => { window.location.href = `/api/contacts/export.csv?${query()}`; } }),
    el('button', { type: 'button', class: 'btn ghost', text: 'Import', onclick: openImport }),
    el('button', { type: 'button', class: 'btn primary', text: 'Add lead', onclick: () => openEditor() })
  );
}

function row(c) {
  const stageSel = el(
    'select',
    {
      class: `stage-select stage-${c.stage}`,
      'aria-label': 'Stage',
      onchange: async (e) => {
        try {
          await api(`/contacts/${enc(c.chatId)}`, { method: 'PATCH', body: { stage: e.target.value } });
          e.target.className = `stage-select stage-${e.target.value}`;
          load();
        } catch (err) {
          toast(err.message);
        }
      },
    },
    ...STAGES.map((s) => el('option', { value: s, text: STAGE_LABELS[s], selected: s === c.stage }))
  );

  return el(
    'tr',
    {},
    el(
      'td',
      {},
      el('div', { class: 'session-name', text: c.displayName }),
      el('div', { class: 'muted small mono', text: c.phone ? `+${c.phone}` : c.chatId }),
      c.optedOut ? el('span', { class: 'mini-tag danger', text: 'Opted out' }) : null
    ),
    el('td', {}, stageSel),
    el('td', {}, tagChips(c.tags)),
    el('td', { class: 'notes-cell' }, el('div', { class: 'muted small clamp', text: c.notes || '' })),
    el('td', { class: 'muted small', text: c.lastMessageAt ? relativeTime(c.lastMessageAt) : 'Never' }),
    el(
      'td',
      { class: 'actions' },
      c.lastMessageAt ? el('button', { type: 'button', class: 'btn small ghost', text: 'Chat', onclick: () => emit('open-chat', c.chatId) }) : null,
      el('button', { type: 'button', class: 'btn small ghost', text: 'Edit', onclick: () => openEditor(c) }),
      el('button', { type: 'button', class: 'btn small ghost danger-text', text: 'Delete', onclick: () => remove(c) })
    )
  );
}

function render() {
  const view = $('view-leads');
  const tableWrap = local.items.length
    ? el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'leads-table' },
          el('thead', {}, el('tr', {}, ...['Lead', 'Stage', 'Tags', 'Notes', 'Last message', ''].map((h) => el('th', { text: h })))),
          el('tbody', {}, ...local.items.map(row))
        )
      )
    : emptyState(local.q || local.stage || local.tag ? 'No leads match these filters.' : 'No leads yet. They are created automatically when someone messages you, or add and import them here.');

  const pages = Math.ceil(local.total / PAGE);
  const page = Math.floor(local.offset / PAGE) + 1;
  const pager =
    pages > 1
      ? el(
          'div',
          { class: 'pager' },
          el('button', { type: 'button', class: 'btn small ghost', text: 'Previous', disabled: page <= 1, onclick: () => { local.offset -= PAGE; load(); } }),
          el('span', { class: 'muted small', text: `Page ${page} of ${pages} (${local.total} leads)` }),
          el('button', { type: 'button', class: 'btn small ghost', text: 'Next', disabled: page >= pages, onclick: () => { local.offset += PAGE; load(); } })
        )
      : el('p', { class: 'muted small', text: `${local.total} lead${local.total === 1 ? '' : 's'}` });

  view.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'Leads' })), pipeline(), toolbar(), tableWrap, pager));
}

function openEditor(c = null) {
  const phone = el('input', { type: 'tel', inputmode: 'numeric', placeholder: '919876543210', value: c ? c.phone || '' : '', disabled: Boolean(c) });
  const name = el('input', { type: 'text', maxlength: '100', value: c ? c.name || '' : '', placeholder: c && c.pushName ? c.pushName : 'Full name' });
  const stage = el('select', {}, ...STAGES.map((s) => el('option', { value: s, text: STAGE_LABELS[s], selected: c ? s === c.stage : s === 'new' })));
  const tags = el('input', { type: 'text', value: c ? c.tags.join(', ') : '', placeholder: 'hot, pricing, referral' });
  const notes = el('textarea', { rows: '4', maxlength: '4000', value: c ? c.notes : '' });
  const optedOut = el('input', { type: 'checkbox', checked: c ? c.optedOut : false });

  openDialog({
    title: c ? `Edit ${c.displayName}` : 'Add lead',
    body: el(
      'div',
      { class: 'form-grid' },
      field('Phone number', phone, c ? null : 'International format, digits only'),
      field('Name', name),
      field('Stage', stage),
      field('Tags', tags, 'Comma separated'),
      el('div', { class: 'span-all' }, field('Notes', notes)),
      el('label', { class: 'check span-all' }, optedOut, el('span', { text: 'Opted out of messages' }))
    ),
    actions: [
      {
        label: c ? 'Save' : 'Add lead',
        primary: true,
        onClick: async (close, btn) => {
          const body = { name: name.value, stage: stage.value, tags: tags.value, notes: notes.value, optedOut: optedOut.checked };
          const res = await withBusy(btn, 'Saving...', () =>
            c ? api(`/contacts/${enc(c.chatId)}`, { method: 'PATCH', body }) : api('/contacts', { method: 'POST', body: { ...body, phone: phone.value } })
          );
          if (res) {
            close();
            toast(c ? 'Lead saved.' : 'Lead added.', 'success', 2500);
            load();
          }
        },
      },
    ],
  });
}

async function remove(c) {
  const ok = await confirmDialog('Delete lead', `Delete ${c.displayName} and their whole message history from the dashboard? This does not affect WhatsApp itself.`, {
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/contacts/${enc(c.chatId)}`, { method: 'DELETE' });
    toast('Lead deleted.', 'success', 2500);
    load();
  } catch (err) {
    toast(err.message);
  }
}

function openImport() {
  const file = el('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
  const text = el('textarea', { rows: '8', placeholder: 'phone,name,tags\n919876543210,Priya Shah,hot\n919812345678,Amit Patel' });
  const tags = el('input', { type: 'text', placeholder: 'e.g. expo-2026' });
  const stage = el('select', {}, ...STAGES.map((s) => el('option', { value: s, text: STAGE_LABELS[s] })));
  const preview = el('p', { class: 'muted small', text: 'Paste rows or choose a CSV file. A header row with "phone" and "name" columns is detected automatically.' });

  const updatePreview = () => {
    const rows = rowsToRecipients(text.value);
    preview.textContent = rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'} ready to import.` : 'No rows yet.';
  };
  text.addEventListener('input', updatePreview);
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('File is larger than 5 MB.');
    text.value = await f.text();
    updatePreview();
  });

  openDialog({
    title: 'Import leads',
    wide: true,
    body: el(
      'div',
      { class: 'form-grid' },
      el('div', { class: 'span-all' }, field('CSV file', file)),
      el('div', { class: 'span-all' }, field('Or paste rows', text)),
      field('Add tags to all', tags, 'Optional, comma separated'),
      field('Stage for new leads', stage),
      el('div', { class: 'span-all' }, preview)
    ),
    actions: [
      {
        label: 'Import',
        primary: true,
        onClick: async (close, btn) => {
          const rows = rowsToRecipients(text.value);
          if (!rows.length) return toast('Nothing to import.');
          const res = await withBusy(btn, 'Importing...', () => api('/contacts/import', { method: 'POST', body: { rows, tags: tags.value, stage: stage.value } }));
          if (res) {
            close();
            const bad = res.invalid.length ? ` ${res.invalid.length} row(s) skipped, first problem: row ${res.invalid[0].row}, ${res.invalid[0].error}` : '';
            toast(`Imported: ${res.created} new, ${res.updated} updated.${bad}`, res.invalid.length ? 'info' : 'success', 8000);
            load();
          }
        },
      },
    ],
  });
}

let refreshTimer;
export function initLeads() {
  on('live:contact', () => {
    if (!local.active || document.activeElement?.closest('#view-leads')) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(load, 500);
  });
}

export function showLeads() {
  local.active = true;
  load();
}

export function hideLeads() {
  local.active = false;
}
