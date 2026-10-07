// Inbox tab: conversations, chat thread, reply box, lead details.
import {
  $, api, el, enc, toast, withBusy, on, state, relativeTime, formatDate, isPaused,
  STAGES, STAGE_LABELS, stageBadge, sessionLabel,
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
  active: false,
};

const SOURCE_LABELS = { auto: 'Auto-reply', campaign: 'Campaign', phone: 'From phone', manual: null, contact: null, api: 'API' };
const TICKS = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };

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
export async function openConversation(chatId) {
  local.current = chatId;
  local.messages = [];
  renderList();
  document.querySelector('.inbox').classList.add('show-chat');
  await loadThread();
  api(`/conversations/${enc(chatId)}/read`, { method: 'POST' }).catch(() => {});
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

function messageBubble(m) {
  const label = SOURCE_LABELS[m.source];
  return el(
    'div',
    { class: `bubble ${m.direction === 'in' ? 'in' : 'out'}${m.source === 'auto' ? ' auto' : ''}`, dataset: { id: String(m.id) } },
    label ? el('span', { class: 'bubble-label', text: label }) : null,
    el('p', { class: 'bubble-text', text: m.body || `[${m.type}]` }),
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
  chat.replaceChildren(...[header, optedOutBanner, scroller, composer(keepDraft)].filter(Boolean));
  $('chat-empty')?.remove();

  if (keepScroll) scroller.scrollTop = scroller.scrollHeight - prevFromBottom;
  else scroller.scrollTop = scroller.scrollHeight;
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

  const form = el(
    'form',
    { class: 'composer', novalidate: true },
    el('div', { class: 'composer-tools' }, saved, state.sessions.length > 1 ? sessionSelect : null),
    el('div', { class: 'composer-row' }, textarea, sendBtn)
  );

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value;
    if (!text.trim()) return;
    const body = { text, force: local.contact.optedOut };
    if (state.sessions.length > 1 && sessionSelect.value) body.sessionId = sessionSelect.value;
    const ok = await withBusy(sendBtn, 'Sending...', () => api(`/conversations/${enc(local.current)}/send`, { method: 'POST', body }));
    if (ok) {
      textarea.value = '';
      local.contact = ok.contact;
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
    )
  );
}

// ---------- Live updates ----------
let listTimer = null;
function scheduleListRefresh() {
  clearTimeout(listTimer);
  listTimer = setTimeout(loadList, 250);
}

async function loadSavedReplies() {
  try {
    local.savedReplies = (await api('/saved-replies')).items;
  } catch {
    local.savedReplies = [];
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
      loadThread();
      if (local.active && !document.hidden) api(`/conversations/${enc(chatId)}/read`, { method: 'POST' }).catch(() => {});
    }
  });
  on('live:contact', ({ chatId }) => {
    scheduleListRefresh();
    if (chatId && chatId === local.current && !document.activeElement?.closest('#lead-panel')) loadThread();
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
}

export async function showInbox() {
  local.active = true;
  await loadSavedReplies();
  await loadList();
  if (local.current) loadThread();
}

export function hideInbox() {
  local.active = false;
}
