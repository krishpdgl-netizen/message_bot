// Inbox tab: conversations, chat thread, attachments, AI summary, AI drafts, reply box, lead details.
import {
  $, api, el, enc, toast, withBusy, on, state, relativeTime, formatDate, isPaused,
  STAGES, STAGE_LABELS, stageBadge, sessionLabel, formatBytes, readFileAsBase64,
  aiFlagTag, scoreMeter,
} from './core.js';

const local = {
  filter: 'all',
  q: '',
  items: [],
  current: null, // chatId
  contact: null,
  messages: [],
  hasMore: false,
  savedReplies: [],
  library: [],
  attachment: null, // { file, data, mimetype, filename, size, previewUrl } or { libraryId, filename, title }
  ai: null, // { configured, mode, autoSummary, summary, draft }
  aiLoading: false,
  summaryOpen: !window.matchMedia('(max-width: 860px)').matches, // collapsed by default on phones
  active: false,
};

const SOURCE_LABELS = { auto: 'Auto-reply', ai: 'AI reply', campaign: 'Campaign', phone: 'From phone', manual: null, contact: null, api: 'API' };
const TICKS = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };
const SENTIMENT_LABEL = { positive: '🙂 Positive', neutral: '😐 Neutral', negative: '🙁 Negative' };
const COMPOSE_ACTIONS = [
  ['improve', 'Improve'],
  ['shorter', 'Make shorter'],
  ['friendlier', 'Friendlier'],
  ['formal', 'More formal'],
  ['fix', 'Fix spelling'],
  ['translate', "Translate to customer's language"],
];

function initials(name) {
  const parts = String(name || '?').replace(/^\+/, '').trim().split(/\s+/);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

// ---------- Conversation list ----------
async function loadList() {
  try {
    const params = new URLSearchParams({ filter: local.filter });
    if (local.q) params.set('q', local.q);
    const data = await api(`/conversations?${params}`);
    local.items = data.items;
    renderList();
  } catch (err) {
    if (local.active) toast(err.message);
  }
}

function renderList() {
  const list = $('conv-list');
  if (!local.items.length) {
    list.replaceChildren(
      el('li', { class: 'conv-empty' }, local.q || local.filter !== 'all' ? 'No conversations match.' : 'No conversations yet. Messages people send you will appear here.')
    );
    return;
  }
  list.replaceChildren(
    ...local.items.map((c) =>
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            class: `conv${c.chatId === local.current ? ' active' : ''}${c.unread ? ' unread' : ''}`,
            onclick: () => openConversation(c.chatId),
          },
          el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(c.displayName) }),
          el(
            'span',
            { class: 'conv-main' },
            el(
              'span',
              { class: 'conv-top' },
              el('span', { class: 'conv-name', text: c.displayName }),
              el('span', { class: 'conv-time', text: relativeTime(c.lastMessageAt) })
            ),
            el(
              'span',
              { class: 'conv-bottom' },
              el('span', { class: 'conv-preview', text: c.lastMessage || '' }),
              aiFlagTag(c.ai && c.ai.flag),
              c.optedOut ? el('span', { class: 'mini-tag danger', text: 'Opted out' }) : null,
              isPaused(c) ? el('span', { class: 'mini-tag', text: 'Bot paused' }) : null,
              c.unread ? el('span', { class: 'unread-dot', text: String(c.unread) }) : null
            )
          )
        )
      )
    )
  );
}

// ---------- Thread ----------
export async function openConversation(chatId, { followup = false } = {}) {
  const changed = local.current !== chatId;
  local.current = chatId;
  if (changed) {
    local.messages = [];
    local.ai = null;
    clearAttachment();
  }
  renderList();
  document.querySelector('.inbox').classList.add('show-chat');
  await loadThread();
  api(`/conversations/${enc(chatId)}/read`, { method: 'POST' }).catch(() => {});
  await loadAi({ autoSummary: true });
  if (followup) composeWithAi('followup');
}

async function loadThread({ older = false } = {}) {
  const chatId = local.current;
  if (!chatId) return;
  try {
    const before = older && local.messages.length ? `&before=${local.messages[0].id}` : '';
    const data = await api(`/conversations/${enc(chatId)}/messages?limit=60${before}`);
    if (local.current !== chatId) return;
    local.contact = data.contact;
    local.messages = older ? [...data.items, ...local.messages] : data.items;
    local.hasMore = data.hasMore;
    renderThread({ keepScroll: older });
    renderLeadPanel();
  } catch (err) {
    toast(err.message);
  }
}

function mediaBlock(m) {
  const md = m.media;
  if (!md) return null;
  if (md.state === 'pending') return el('div', { class: 'media-note', text: 'Downloading file…' });
  if (!md.url) return el('div', { class: 'media-note', text: `${md.name || 'File'} (not available)` });
  const mime = md.mime || '';
  if (/^image\//.test(mime)) {
    return el(
      'a',
      { href: md.url, target: '_blank', rel: 'noopener', class: `bubble-media${m.type === 'sticker' ? ' sticker' : ''}`, title: 'Open full size' },
      el('img', { src: md.url, alt: md.name || 'Photo', loading: 'lazy' })
    );
  }
  if (/^video\//.test(mime)) return el('video', { class: 'bubble-media', src: md.url, controls: true, preload: 'metadata' });
  if (/^audio\//.test(mime)) return el('audio', { class: 'bubble-audio', src: md.url, controls: true, preload: 'none' });
  return el(
    'a',
    { class: 'doc-chip', href: md.url, target: '_blank', rel: 'noopener' },
    el('span', { class: 'doc-icon', 'aria-hidden': 'true', text: (md.name || '').split('.').pop().slice(0, 4).toUpperCase() || 'FILE' }),
    el('span', { class: 'doc-meta' }, el('strong', { text: md.name || 'Document' }), el('small', { text: [formatBytes(md.size), 'Open'].filter(Boolean).join(' · ') }))
  );
}

function messageBubble(m) {
  const label = SOURCE_LABELS[m.source];
  const media = mediaBlock(m);
  const showText = m.body || !media;
  return el(
    'div',
    {
      class: `bubble ${m.direction === 'in' ? 'in' : 'out'}${m.source === 'auto' ? ' auto' : ''}${m.source === 'ai' ? ' ai' : ''}${media ? ' has-media' : ''}`,
      dataset: { id: String(m.id) },
    },
    label ? el('span', { class: 'bubble-label', text: label }) : null,
    media,
    showText ? el('p', { class: 'bubble-text', text: m.body || `[${m.type}]` }) : null,
    el(
      'span',
      { class: 'bubble-meta' },
      el('time', { datetime: m.createdAt, title: formatDate(m.createdAt), text: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
      m.direction === 'out' ? el('span', { class: `tick tick-${m.status || 'sent'}`, title: m.status || 'sent', text: TICKS[m.status] || '✓' }) : null
    )
  );
}

function dayDivider(date) {
  return el('div', { class: 'day-divider' }, el('span', { text: date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }) }));
}

function renderThread({ keepScroll = false } = {}) {
  const c = local.contact;
  const chat = $('chat');
  if (!c) return;

  const paused = isPaused(c);
  const pausedForever = paused && c.botPausedUntil.startsWith('9999');

  const header = el(
    'div',
    { class: 'chat-head' },
    el('button', { type: 'button', class: 'icon-btn back', 'aria-label': 'Back to conversations', text: '‹', onclick: () => document.querySelector('.inbox').classList.remove('show-chat') }),
    el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(c.displayName) }),
    el(
      'div',
      { class: 'chat-title' },
      el('strong', { text: c.displayName }),
      el('span', { class: 'muted small mono', text: c.phone ? `+${c.phone}` : c.chatId })
    ),
    aiFlagTag(c.ai && c.ai.flag),
    stageBadge(c.stage),
    el('button', {
      type: 'button',
      class: `btn small ${paused ? '' : 'ghost'}`,
      title: paused ? 'Auto-replies are paused for this chat' : 'Stop auto-replies for this chat',
      text: paused ? (pausedForever ? 'Resume bot' : `Bot paused until ${new Date(c.botPausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`) : 'Pause bot',
      onclick: (ev) => toggleBot(!paused, ev.currentTarget),
    }),
    el('button', { type: 'button', class: 'btn small ghost details-toggle', text: 'Details', onclick: () => $('lead-panel').classList.toggle('open') })
  );

  const scroller = el('div', { class: 'messages', id: 'messages' });
  if (local.hasMore) {
    scroller.append(el('button', { type: 'button', class: 'btn small ghost load-older', text: 'Load older messages', onclick: () => loadThread({ older: true }) }));
  }
  let lastDay = '';
  for (const m of local.messages) {
    const d = new Date(m.createdAt);
    const key = d.toDateString();
    if (key !== lastDay) {
      scroller.append(dayDivider(d));
      lastDay = key;
    }
    scroller.append(messageBubble(m));
  }
  if (!local.messages.length) scroller.append(el('p', { class: 'empty', text: 'No messages yet.' }));

  const prevScroller = $('messages');
  const prevFromBottom = prevScroller ? prevScroller.scrollHeight - prevScroller.scrollTop : 0;
  const keepDraft = $('reply-text') ? $('reply-text').value : '';

  const optedOutBanner = c.optedOut
    ? el('div', { class: 'banner banner-warn slim', text: 'This contact opted out. Only reply if they asked you something.' })
    : null;
  chat.replaceChildren(...[header, optedOutBanner, summaryCard(), scroller, draftCard(), composer(keepDraft)].filter(Boolean));
  $('chat-empty')?.remove();

  // Images load after render; keep the view pinned to the bottom when they do.
  if (!keepScroll) {
    for (const img of scroller.querySelectorAll('img')) {
      img.addEventListener('load', () => {
        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 400) scroller.scrollTop = scroller.scrollHeight;
      }, { once: true });
    }
  }
  if (keepScroll) scroller.scrollTop = scroller.scrollHeight - prevFromBottom;
  else scroller.scrollTop = scroller.scrollHeight;
}

// ---------- AI: summary and draft ----------
async function loadAi({ autoSummary = false } = {}) {
  const chatId = local.current;
  if (!chatId) return;
  try {
    const data = await api(`/ai/chats/${enc(chatId)}`);
    if (local.current !== chatId) return;
    local.ai = data;
    rerenderAi();
    const enoughMessages = local.messages.length >= 2;
    if (autoSummary && data.configured && data.autoSummary && enoughMessages && (!data.summary || data.summary.stale)) {
      await refreshSummary(false);
    }
  } catch {
    local.ai = null;
  }
}

async function refreshSummary(force, btn) {
  const chatId = local.current;
  if (!chatId || local.aiLoading) return;
  local.aiLoading = true;
  if (force) local.summaryOpen = true;
  rerenderAi();
  try {
    const data = await api(`/ai/chats/${enc(chatId)}/summary`, { method: 'POST', body: { force } });
    if (local.current === chatId && local.ai) local.ai.summary = data.summary;
  } catch (err) {
    if (btn || force) toast(err.message);
    else if (local.ai) local.ai.summaryError = err.message;
  } finally {
    local.aiLoading = false;
    rerenderAi();
  }
}

// Swap only the AI cards so the thread does not jump.
function rerenderAi() {
  const oldSummary = $('ai-summary');
  const newSummary = summaryCard();
  if (oldSummary && newSummary) oldSummary.replaceWith(newSummary);
  else if (oldSummary) oldSummary.remove();
  else if (newSummary) $('messages')?.before(newSummary);

  const oldDraft = $('ai-draft');
  const newDraft = draftCard();
  if (oldDraft && newDraft) oldDraft.replaceWith(newDraft);
  else if (oldDraft) oldDraft.remove();
  else if (newDraft) document.querySelector('#chat .composer')?.before(newDraft);
}

function summaryCard() {
  const ai = local.ai;
  if (!ai || !ai.configured) return null;
  const s = ai.summary;
  if (!s && !local.aiLoading) {
    if (local.messages.length < 2) return null;
    return el(
      'div',
      { class: 'ai-summary collapsed', id: 'ai-summary' },
      el(
        'div',
        { class: 'ai-summary-head' },
        el('span', { class: 'ai-badge', text: 'AI' }),
        el('span', { class: 'muted small', text: ai.summaryError ? `Summary failed: ${ai.summaryError}` : 'No summary yet.' }),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn small ghost', text: 'Summarise chat', onclick: (e) => refreshSummary(true, e.currentTarget) })
      )
    );
  }
  if (local.aiLoading && !s) {
    return el(
      'div',
      { class: 'ai-summary', id: 'ai-summary' },
      el('div', { class: 'ai-summary-head' }, el('span', { class: 'ai-badge', text: 'AI' }), el('span', { class: 'muted small shimmer', text: 'Reading the conversation…' }))
    );
  }

  const toggle = el('button', {
    type: 'button',
    class: 'icon-btn small-icon',
    'aria-label': local.summaryOpen ? 'Hide summary' : 'Show summary',
    'aria-expanded': String(local.summaryOpen),
    text: local.summaryOpen ? '▾' : '▸',
    onclick: () => {
      local.summaryOpen = !local.summaryOpen;
      rerenderAi();
    },
  });

  const head = el(
    'div',
    { class: 'ai-summary-head' },
    el('span', { class: 'ai-badge', text: 'AI' }),
    el('strong', { class: 'ai-wants', text: s.wants || 'Summary' }),
    s.sentiment ? el('span', { class: `sentiment s-${s.sentiment}`, text: SENTIMENT_LABEL[s.sentiment] }) : null,
    scoreMeter(s.score),
    el('span', { class: 'spacer' }),
    local.aiLoading
      ? el('span', { class: 'muted small shimmer', text: 'Updating…' })
      : el('button', {
          type: 'button',
          class: `btn small ${s.stale ? '' : 'ghost'}`,
          title: s.stale ? 'New messages since this summary' : `Summarised ${relativeTime(s.createdAt)} ago`,
          text: s.stale ? 'Update' : 'Refresh',
          onclick: (e) => refreshSummary(true, e.currentTarget),
        }),
    toggle
  );

  const body = local.summaryOpen
    ? el(
        'div',
        { class: 'ai-summary-body' },
        el('p', { text: s.summary }),
        s.facts && s.facts.length
          ? el('dl', { class: 'ai-facts' }, ...s.facts.flatMap((f) => [el('dt', { text: f.label }), el('dd', { text: f.value })]))
          : null,
        s.open && s.open.length ? el('div', { class: 'ai-open' }, el('span', { class: 'field-label', text: 'Still open' }), el('ul', {}, ...s.open.map((q) => el('li', { text: q })))) : null,
        s.next ? el('p', { class: 'ai-next' }, el('strong', { text: 'Next step: ' }), s.next) : null
      )
    : null;

  return el('div', { class: `ai-summary${local.summaryOpen ? '' : ' collapsed'}`, id: 'ai-summary' }, head, body);
}

function draftCard() {
  const d = local.ai && local.ai.draft;
  if (!d) return null;
  const text = el('textarea', { rows: '3', maxlength: '4096', value: d.body, 'aria-label': 'AI draft reply' });
  const files = d.attachments
    .map((id) => local.library.find((f) => f.id === id))
    .filter(Boolean)
    .map((f) => el('span', { class: 'chip', text: `📎 ${f.title}` }));
  const send = el('button', { type: 'button', class: 'btn primary small', text: 'Send' });
  send.addEventListener('click', async () => {
    const ok = await withBusy(send, 'Sending...', () => api(`/ai/drafts/${d.id}/approve`, { method: 'POST', body: { body: text.value } }));
    if (ok) {
      local.ai.draft = null;
      rerenderAi();
      loadThread();
    }
  });
  return el(
    'div',
    { class: 'ai-draft', id: 'ai-draft' },
    el(
      'div',
      { class: 'ai-draft-head' },
      el('span', { class: 'ai-badge', text: 'AI' }),
      el('strong', { text: 'Suggested reply' }),
      d.confidence !== null ? el('span', { class: 'muted small', text: `${Math.round(d.confidence * 100)}% sure` }) : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: relativeTime(d.createdAt) })
    ),
    d.reason ? el('p', { class: 'muted small ai-reason', text: d.reason }) : null,
    text,
    files.length ? el('div', { class: 'chips' }, ...files) : null,
    el(
      'div',
      { class: 'row tight' },
      send,
      el('button', {
        type: 'button',
        class: 'btn small ghost',
        text: 'Edit in reply box',
        onclick: () => {
          const box = $('reply-text');
          if (box) {
            box.value = text.value;
            box.focus();
          }
          discardDraft(d.id);
        },
      }),
      el('button', { type: 'button', class: 'btn small ghost', text: 'Discard', onclick: () => discardDraft(d.id) })
    )
  );
}

async function discardDraft(id) {
  try {
    await api(`/ai/drafts/${id}/discard`, { method: 'POST' });
  } catch (err) {
    toast(err.message);
  }
  if (local.ai) local.ai.draft = null;
  rerenderAi();
}

// ---------- Composer ----------
function clearAttachment() {
  if (local.attachment && local.attachment.previewUrl) URL.revokeObjectURL(local.attachment.previewUrl);
  local.attachment = null;
}

function attachmentChip(onRemove) {
  const a = local.attachment;
  if (!a) return null;
  const isImage = a.previewUrl && /^image\//.test(a.mimetype || '');
  return el(
    'div',
    { class: 'attach-chip' },
    isImage ? el('img', { src: a.previewUrl, alt: '' }) : el('span', { class: 'doc-icon', 'aria-hidden': 'true', text: (a.filename || '').split('.').pop().slice(0, 4).toUpperCase() || 'FILE' }),
    el(
      'span',
      { class: 'doc-meta' },
      el('strong', { text: a.title || a.filename }),
      el('small', { text: a.libraryId ? 'From library · message becomes the caption' : `${formatBytes(a.size)} · message becomes the caption` })
    ),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove attachment', text: '×', onclick: onRemove })
  );
}

async function composeWithAi(action, btn) {
  const box = $('reply-text');
  if (!box || !local.current) return;
  const chatId = local.current;
  const res = await withBusy(btn, 'Writing...', () =>
    api(`/ai/chats/${enc(chatId)}/compose`, { method: 'POST', body: { action, draft: box.value } })
  );
  if (res && local.current === chatId) {
    const current = $('reply-text');
    current.value = res.text;
    current.focus();
    current.dispatchEvent(new Event('input'));
  }
}

function composer(draft) {
  const textarea = el('textarea', { id: 'reply-text', rows: '2', maxlength: '4096', placeholder: 'Type a reply. Enter to send, Shift+Enter for a new line.', value: draft });
  const sendBtn = el('button', { type: 'submit', class: 'btn primary', text: 'Send' });

  const sessionSelect = el('select', { id: 'reply-session', 'aria-label': 'Send from session' });
  const ready = state.readySessions;
  const preferred = local.contact.sessionId;
  sessionSelect.replaceChildren(
    ...(ready.length ? ready : state.sessions).map((s) => el('option', { value: s.id, text: sessionLabel(s), selected: s.id === preferred }))
  );

  const saved = el(
    'select',
    {
      'aria-label': 'Insert saved reply',
      class: 'saved-select',
      onchange: (e) => {
        const item = local.savedReplies.find((r) => String(r.id) === e.target.value);
        if (item) {
          const name = local.contact.name || local.contact.pushName || 'there';
          textarea.value = item.body.replace(/\{\{\s*name\s*\}\}/gi, name).replace(/\{\{\s*first_name\s*\}\}/gi, name.split(/\s+/)[0]);
          textarea.focus();
        }
        e.target.value = '';
      },
    },
    el('option', { value: '', text: local.savedReplies.length ? 'Saved replies' : 'No saved replies' }),
    ...local.savedReplies.map((r) => el('option', { value: String(r.id), text: r.title }))
  );

  // Attachments: a file from this computer, or one from the media library.
  const chipSlot = el('div', { class: 'attach-slot' });
  const refreshChip = () => chipSlot.replaceChildren(...[attachmentChip(() => { clearAttachment(); refreshChip(); })].filter(Boolean));
  const fileInput = el('input', { type: 'file', hidden: true, 'aria-hidden': 'true' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const read = await readFileAsBase64(file);
      clearAttachment();
      local.attachment = { ...read, previewUrl: /^image\//.test(read.mimetype) ? URL.createObjectURL(file) : null };
      refreshChip();
      textarea.focus();
    } catch (err) {
      toast(err.message);
    }
  });
  const attachBtn = el('button', { type: 'button', class: 'btn small ghost', title: 'Attach a photo, video or document', text: '📎 Attach', onclick: () => fileInput.click() });
  const library = local.library.length
    ? el(
        'select',
        {
          'aria-label': 'Attach a file from the library',
          onchange: (e) => {
            const item = local.library.find((f) => String(f.id) === e.target.value);
            e.target.value = '';
            if (!item) return;
            clearAttachment();
            local.attachment = { libraryId: item.id, filename: item.filename, title: item.title, mimetype: item.mime };
            refreshChip();
          },
        },
        el('option', { value: '', text: 'Library' }),
        ...local.library.map((f) => el('option', { value: String(f.id), text: f.title }))
      )
    : null;

  // AI writing tools.
  const aiOn = local.ai && local.ai.configured;
  const suggestBtn = aiOn
    ? el('button', { type: 'button', class: 'btn small ai-btn', title: 'Let AI write the next reply from the conversation', text: '✨ Suggest reply', onclick: (e) => composeWithAi('suggest', e.currentTarget) })
    : null;
  const rewrite = aiOn
    ? el(
        'select',
        {
          'aria-label': 'Rewrite your draft with AI',
          class: 'ai-select',
          onchange: (e) => {
            const action = e.target.value;
            e.target.value = '';
            if (action) composeWithAi(action, suggestBtn);
          },
        },
        el('option', { value: '', text: '✨ Rewrite' }),
        ...COMPOSE_ACTIONS.map(([value, label]) => el('option', { value, text: label }))
      )
    : null;

  const form = el(
    'form',
    { class: 'composer', novalidate: true },
    el('div', { class: 'composer-tools' }, attachBtn, fileInput, library, saved, suggestBtn, rewrite, state.sessions.length > 1 ? sessionSelect : null),
    chipSlot,
    el('div', { class: 'composer-row' }, textarea, sendBtn)
  );
  refreshChip();

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value;
    const att = local.attachment;
    if (!text.trim() && !att) return;
    const body = { force: local.contact.optedOut };
    if (state.sessions.length > 1 && sessionSelect.value) body.sessionId = sessionSelect.value;
    let path = `/conversations/${enc(local.current)}/send`;
    if (att) {
      path = `/conversations/${enc(local.current)}/send-media`;
      body.caption = text;
      if (att.libraryId) body.libraryId = att.libraryId;
      else Object.assign(body, { data: att.data, mimetype: att.mimetype, filename: att.filename });
    } else {
      body.text = text;
    }
    const ok = await withBusy(sendBtn, att ? 'Uploading...' : 'Sending...', () => api(path, { method: 'POST', body }));
    if (ok) {
      textarea.value = '';
      clearAttachment();
      refreshChip();
      local.contact = ok.contact;
      if (local.ai) local.ai.draft = null;
      await loadThread();
      $('reply-text')?.focus();
    }
  });
  return form;
}

async function toggleBot(pause, btn) {
  const res = await withBusy(btn, pause ? 'Pausing...' : 'Resuming...', () =>
    api(`/conversations/${enc(local.current)}/bot`, { method: 'POST', body: { paused: pause, minutes: 0 } })
  );
  if (res) {
    local.contact = res.contact;
    renderThread({ keepScroll: true });
    toast(pause ? 'Auto-replies paused for this chat until you resume them.' : 'Auto-replies resumed for this chat.', 'success', 3000);
  }
}

// ---------- Lead details panel ----------
function aiInsights(c) {
  const a = c.ai || {};
  if (a.score === null && !a.intent && !a.flag && !a.sentiment) return null;
  const clear = a.flag
    ? el('button', {
        type: 'button',
        class: 'btn small ghost',
        text: 'Mark handled',
        onclick: async (e) => {
          const res = await withBusy(e.currentTarget, '...', () => api(`/ai/chats/${enc(c.chatId)}/clear-flag`, { method: 'POST' }));
          if (res) {
            local.contact = res.contact;
            renderLeadPanel();
            renderThread({ keepScroll: true });
            loadList();
          }
        },
      })
    : null;
  return el(
    'div',
    { class: 'ai-insights' },
    el('div', { class: 'row tight' }, el('span', { class: 'ai-badge', text: 'AI' }), el('strong', { text: 'Insights' })),
    el(
      'dl',
      { class: 'facts' },
      a.score !== null ? [el('dt', { text: 'Lead score' }), el('dd', {}, scoreMeter(a.score))] : null,
      a.intent ? [el('dt', { text: 'Wants' }), el('dd', { text: a.intent })] : null,
      a.sentiment ? [el('dt', { text: 'Mood' }), el('dd', { text: SENTIMENT_LABEL[a.sentiment] || a.sentiment })] : null,
      a.flag ? [el('dt', { text: 'Flag' }), el('dd', {}, aiFlagTag(a.flag))] : null
    ),
    clear
  );
}

function renderLeadPanel() {
  const c = local.contact;
  const panel = $('lead-panel');
  if (!c) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const name = el('input', { type: 'text', maxlength: '100', value: c.name || '', placeholder: c.pushName || 'Contact name' });
  const stage = el('select', {}, ...STAGES.map((s) => el('option', { value: s, text: STAGE_LABELS[s], selected: s === c.stage })));
  const tags = el('input', { type: 'text', value: c.tags.join(', '), placeholder: 'hot, pricing, referral' });
  const notes = el('textarea', { rows: '5', maxlength: '4000', value: c.notes || '', placeholder: 'Budget, requirements, follow-up date...' });
  const optedOut = el('input', { type: 'checkbox', checked: c.optedOut });
  const save = el('button', { type: 'button', class: 'btn primary small', text: 'Save lead' });

  save.addEventListener('click', async () => {
    const res = await withBusy(save, 'Saving...', () =>
      api(`/contacts/${enc(c.chatId)}`, {
        method: 'PATCH',
        body: { name: name.value, stage: stage.value, tags: tags.value, notes: notes.value, optedOut: optedOut.checked },
      })
    );
    if (res) {
      local.contact = res.contact;
      toast('Lead saved.', 'success', 2500);
      renderThread({ keepScroll: true });
      loadList();
    }
  });

  panel.replaceChildren(
    ...[
      aiInsights(c),
      el('h3', { text: 'Lead details' }),
      el('label', { class: 'field' }, el('span', { text: 'Name' }), name),
      el('label', { class: 'field' }, el('span', { text: 'Stage' }), stage),
      el('label', { class: 'field' }, el('span', { text: 'Tags' }), tags, el('small', { class: 'hint', text: 'Comma separated' })),
      el('label', { class: 'field' }, el('span', { text: 'Notes' }), notes),
      el('label', { class: 'check' }, optedOut, el('span', { text: 'Opted out of messages' })),
      save,
      el(
        'dl',
        { class: 'facts' },
        el('dt', { text: 'WhatsApp name' }), el('dd', { text: c.pushName || 'Unknown' }),
        el('dt', { text: 'First contact' }), el('dd', { text: formatDate(c.createdAt) }),
        el('dt', { text: 'Source' }), el('dd', { text: c.source })
      ),
    ].filter(Boolean)
  );
}

// ---------- Live updates ----------
let listTimer = null;
function scheduleListRefresh() {
  clearTimeout(listTimer);
  listTimer = setTimeout(loadList, 250);
}

let aiTimer = null;
function scheduleAiRefresh() {
  clearTimeout(aiTimer);
  aiTimer = setTimeout(() => loadAi(), 300);
}

async function loadSavedReplies() {
  try {
    local.savedReplies = (await api('/saved-replies')).items;
  } catch {
    local.savedReplies = [];
  }
}

async function loadLibrary() {
  try {
    local.library = (await api('/library')).items;
  } catch {
    local.library = [];
  }
}

export function initInbox() {
  $('conv-search').addEventListener('input', (e) => {
    local.q = e.target.value.trim();
    scheduleListRefresh();
  });
  $('conv-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    local.filter = btn.dataset.filter;
    for (const b of $('conv-filter').querySelectorAll('button')) b.classList.toggle('active', b === btn);
    loadList();
  });

  on('live:message', ({ chatId }) => {
    scheduleListRefresh();
    if (chatId && chatId === local.current) {
      loadThread().then(() => {
        // Show "Update" on the summary once new messages arrive.
        if (local.ai && local.ai.summary) local.ai.summary.stale = true;
        rerenderAi();
      });
      if (local.active && !document.hidden) api(`/conversations/${enc(chatId)}/read`, { method: 'POST' }).catch(() => {});
    }
  });
  on('live:contact', ({ chatId }) => {
    scheduleListRefresh();
    if (chatId && chatId === local.current && !document.activeElement?.closest('#lead-panel')) loadThread();
  });
  on('live:ai', ({ chatId }) => {
    if (chatId && chatId === local.current && !document.activeElement?.closest('#ai-draft')) scheduleAiRefresh();
  });
  on('live:ack', ({ chatId, id, status }) => {
    if (chatId !== local.current) return;
    const m = local.messages.find((x) => x.id === id);
    if (m) m.status = status;
    const tick = document.querySelector(`.bubble[data-id="${id}"] .tick`);
    if (tick) {
      tick.className = `tick tick-${status}`;
      tick.textContent = TICKS[status] || '✓';
      tick.title = status;
    }
  });
  on('saved-replies', loadSavedReplies);
  on('library', loadLibrary);
}

export async function showInbox() {
  local.active = true;
  await Promise.all([loadSavedReplies(), loadLibrary()]);
  await loadList();
  if (local.current) {
    await loadThread();
    loadAi();
  }
}

export function hideInbox() {
  local.active = false;
}
