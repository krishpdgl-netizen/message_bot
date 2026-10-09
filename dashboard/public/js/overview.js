// Overview tab: stats, gateway health, sessions, QR, test message.
import { $, api, el, enc, toast, setBusy, emit, on, state } from './core.js';

const NAME_RE = /^[A-Za-z0-9-]{3,50}$/;
const PHONE_RE = /^\d{7,15}$/;
const QR_SRC_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const KNOWN_STATUSES = ['created', 'initializing', 'qr_ready', 'authenticating', 'ready'];
const STATUS_LABELS = {
  created: 'Created',
  initializing: 'Initializing',
  qr_ready: 'Waiting for scan',
  authenticating: 'Authenticating',
  ready: 'Ready',
};

const local = {
  sessionsSig: '',
  readySig: '',
  sessionsError: '',
  qrSessionId: null,
  healthOk: null,
  webhookStatus: { configured: true, sessions: {} },
};

function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'sessions', 'items', 'results']) if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

const statusOf = (s) => String(s.status || 'unknown').toLowerCase();
const phoneOf = (s) => String(s.phone || s.phoneNumber || '');
const nameOf = (s) => String(s.name || 'unnamed');

function badge(status) {
  const cls = KNOWN_STATUSES.includes(status) ? status : 'error';
  return el('span', { class: `badge badge-${cls}`, text: STATUS_LABELS[status] || status.replace(/_/g, ' ') });
}

// ---------- Health ----------
export async function pollHealth() {
  let ok = true;
  try {
    const data = await api('/health');
    if (data && typeof data.status === 'string' && /^(error|down|unhealthy|fail)/i.test(data.status)) ok = false;
  } catch {
    ok = false;
  }
  $('health').className = `pill ${ok ? 'pill-ok' : 'pill-bad'}`;
  $('health-text').textContent = ok ? 'Gateway online' : 'Gateway offline';
  if (local.healthOk === null && !ok) toast('The WhatsApp gateway is unreachable. Check that the openwa container is running.');
  else if (local.healthOk !== null && local.healthOk !== ok) {
    toast(ok ? 'Gateway is back online.' : 'Lost connection to the WhatsApp gateway.', ok ? 'success' : 'error');
  }
  local.healthOk = ok;
}

// ---------- Stats ----------
export async function refreshStats() {
  let s;
  try {
    s = await api('/stats');
  } catch {
    return;
  }
  const tile = (label, value, note, tone) =>
    el('div', { class: `stat${tone ? ` stat-${tone}` : ''}` }, el('span', { class: 'stat-label', text: label }), el('strong', { text: String(value) }), note ? el('span', { class: 'stat-note', text: note }) : null);

  $('stats').replaceChildren(
    tile('Inbound messages', s.last24h.inbound, 'last 24 hours'),
    tile('New leads', s.last24h.newLeads, 'last 24 hours', 'accent'),
    tile('Auto-replies sent', s.last24h.autoReplies, s.last24h.aiReplies ? `${s.last24h.aiReplies} by AI, last 24 hours` : 'last 24 hours'),
    tile('Campaign messages', s.last24h.campaign, 'last 24 hours'),
    tile('Unread chats', s.totals.unreadChats, s.totals.unreadChats ? 'waiting for you' : 'all caught up', s.totals.unreadChats ? 'warn' : null),
    tile('Business hours', s.open ? 'Open' : 'Closed', s.open ? 'auto-replies use open rules' : 'away message active', s.open ? null : 'muted')
  );

  const count = $('inbox-count');
  count.textContent = String(s.totals.unreadChats);
  count.hidden = !s.totals.unreadChats;

  // AI tab badge: chats where the AI needs a human or a draft is waiting.
  const aiCount = $('ai-count');
  const waiting = (s.totals.aiDrafts || 0) + (s.totals.aiFlagged || 0);
  aiCount.textContent = String(waiting);
  aiCount.hidden = !waiting;
}

// ---------- Sessions ----------
async function refreshWebhookStatus() {
  try {
    local.webhookStatus = await api('/webhooks/status');
  } catch {
    return;
  }
  const banner = $('webhook-banner');
  if (!local.webhookStatus.configured) {
    banner.textContent =
      'Inbox and auto-replies are off because WEBHOOK_SECRET is not set on the server. Add it to .env (at least 16 characters) and restart.';
    banner.hidden = false;
  } else banner.hidden = true;
  const hint = $('inbox-setup-hint');
  if (hint) hint.textContent = local.webhookStatus.configured ? '' : 'Set WEBHOOK_SECRET on the server to start receiving messages here.';
}

export async function refreshSessions() {
  try {
    await refreshWebhookStatus();
    const list = normalizeList(await api('/sessions')).filter((s) => s && typeof s === 'object' && typeof s.id === 'string');
    state.sessions = list;
    state.readySessions = list.filter((s) => statusOf(s) === 'ready');
    setSessionsError('', 0);
    renderSessions(list);
    renderSendSelect();
    $('sessions-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    emit('sessions', list);
  } catch (err) {
    setSessionsError(err.message, err.status);
  }
  await refreshQr();
}

function setSessionsError(message, status) {
  const banner = $('sessions-error');
  banner.textContent = message;
  banner.hidden = !message;
  if (message && message !== local.sessionsError && status !== 502) toast(message);
  local.sessionsError = message;
}

function webhookCell(s) {
  if (!local.webhookStatus.configured) return el('span', { class: 'muted small', text: 'Off' });
  const st = local.webhookStatus.sessions[s.id];
  if (!st) return el('span', { class: 'muted small', text: 'Checking...' });
  if (st.state === 'active') return el('span', { class: 'ok-text small', text: 'Connected' });
  return el('span', { class: 'err-text small', title: st.error || '', text: 'Not connected' });
}

function renderSessions(list) {
  const sig = JSON.stringify([list.map((s) => [s.id, s.name, s.status, phoneOf(s), s.pushName]), local.webhookStatus]);
  if (sig === local.sessionsSig) return;
  local.sessionsSig = sig;
  $('sessions-body').replaceChildren(...list.map(sessionRow));
  $('sessions-table-wrap').hidden = list.length === 0;
  $('sessions-empty').hidden = list.length > 0;
}

function sessionRow(s) {
  const status = statusOf(s);
  const phone = phoneOf(s);
  const startBlocked = ['ready', 'initializing', 'qr_ready', 'authenticating'].includes(status);
  const wh = local.webhookStatus.sessions[s.id];

  return el(
    'tr',
    {},
    el('td', {}, el('div', { class: 'session-name', text: nameOf(s) }), el('div', { class: 'session-id', text: s.id })),
    el('td', {}, badge(status)),
    el(
      'td',
      {},
      el('div', { class: phone ? 'mono' : 'muted', text: phone || 'Not linked' }),
      s.pushName ? el('div', { class: 'muted small', text: String(s.pushName) }) : null
    ),
    el('td', {}, webhookCell(s)),
    el(
      'td',
      { class: 'actions' },
      el('button', {
        type: 'button',
        class: 'btn small',
        text: 'Start',
        disabled: startBlocked,
        title: startBlocked ? 'Session is already running' : 'Start this session',
        onclick: (ev) => startSession(s, ev.currentTarget),
      }),
      el('button', { type: 'button', class: 'btn small ghost', text: 'Show QR', disabled: status === 'ready', onclick: () => openQr(s) }),
      local.webhookStatus.configured && (!wh || wh.state !== 'active')
        ? el('button', { type: 'button', class: 'btn small ghost', text: 'Connect inbox', onclick: (ev) => connectInbox(s, ev.currentTarget) })
        : null
    )
  );
}

async function connectInbox(s, btn) {
  setBusy(btn, true, 'Connecting...');
  try {
    const st = await api(`/sessions/${enc(s.id)}/webhook`, { method: 'POST' });
    if (st.state === 'active') toast(`Inbox connected for "${nameOf(s)}".`, 'success');
    else toast(`Could not connect inbox: ${st.error || st.state}`);
  } catch (err) {
    toast(err.message);
  } finally {
    local.sessionsSig = '';
    await refreshSessions();
  }
}

async function createSession(ev) {
  ev.preventDefault();
  const input = $('session-name');
  const name = input.value.trim();
  if (!NAME_RE.test(name)) {
    input.classList.add('invalid');
    toast('Session name must be 3 to 50 characters using letters, digits and hyphens.');
    input.focus();
    return;
  }
  input.classList.remove('invalid');
  const btn = $('create-btn');
  setBusy(btn, true, 'Creating...');
  try {
    const created = await api('/sessions', { method: 'POST', body: { name } });
    toast(`Session "${(created && created.name) || name}" created. Press Start to link a phone.`, 'success');
    input.value = '';
    local.sessionsSig = '';
    await refreshSessions();
  } catch (err) {
    toast(err.status === 409 ? `A session named "${name}" already exists.` : `Could not create session: ${err.message}`);
  } finally {
    setBusy(btn, false);
  }
}

async function startSession(s, btn) {
  setBusy(btn, true, 'Starting...');
  try {
    await api(`/sessions/${enc(s.id)}/start`, { method: 'POST' });
    toast(`Starting "${nameOf(s)}". The QR code will appear shortly.`, 'success');
    openQr(s);
    local.sessionsSig = '';
    await refreshSessions();
  } catch (err) {
    toast(`Could not start "${nameOf(s)}": ${err.message}`);
    setBusy(btn, false);
  }
}

// ---------- QR ----------
function openQr(s) {
  local.qrSessionId = s.id;
  $('qr-session-name').textContent = nameOf(s);
  $('qr-img').hidden = true;
  $('qr-img').removeAttribute('src');
  $('qr-status').textContent = 'Loading QR code...';
  $('qr-card').hidden = false;
  $('qr-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  refreshQr();
}

function hideQr() {
  local.qrSessionId = null;
  $('qr-card').hidden = true;
  $('qr-img').removeAttribute('src');
}

function markConnected(id) {
  const s = state.sessions.find((x) => x.id === id);
  hideQr();
  toast(`"${s ? nameOf(s) : 'Session'}" is connected and ready.`, 'success');
}

async function refreshQr() {
  const id = local.qrSessionId;
  if (!id) return;
  const session = state.sessions.find((x) => x.id === id);
  if (session && statusOf(session) === 'ready') return markConnected(id);

  const img = $('qr-img');
  const status = $('qr-status');
  try {
    const data = await api(`/sessions/${enc(id)}/qr`);
    if (local.qrSessionId !== id) return;
    if (data && String(data.status).toLowerCase() === 'ready') return markConnected(id);
    const src = data && (data.qrCode || data.qr);
    if (typeof src === 'string' && QR_SRC_RE.test(src)) {
      if (img.getAttribute('src') !== src) img.src = src;
      img.hidden = false;
      status.textContent = 'The code refreshes automatically every 5 seconds.';
    } else {
      img.hidden = true;
      status.textContent = 'No QR code yet. Waiting for the gateway...';
    }
  } catch (err) {
    if (local.qrSessionId !== id) return;
    img.hidden = true;
    status.textContent =
      err.status === 400 ? 'No QR code available yet. If the session is not running, press Start. Waiting...' : err.message;
  }
}

// ---------- Test message ----------
function renderSendSelect() {
  const ready = state.readySessions;
  const sig = JSON.stringify(ready.map((s) => [s.id, s.name, phoneOf(s)]));
  if (sig === local.readySig) return;
  local.readySig = sig;
  const select = $('send-session');
  const previous = select.value;
  if (!ready.length) {
    select.replaceChildren(el('option', { value: '', text: 'No ready sessions. Start one and scan its QR code.' }));
    select.disabled = true;
  } else {
    select.replaceChildren(...ready.map((s) => el('option', { value: s.id, text: phoneOf(s) ? `${nameOf(s)} (${phoneOf(s)})` : nameOf(s) })));
    select.disabled = false;
    if (ready.some((s) => s.id === previous)) select.value = previous;
  }
  updateSendButtons();
}

function updateSendButtons() {
  const select = $('send-session');
  const enabled = !select.disabled && Boolean(select.value);
  for (const id of ['check-btn', 'send-btn']) {
    const btn = $(id);
    if (!btn.dataset.busy) btn.disabled = !enabled;
  }
}

function readPhone() {
  const input = $('send-phone');
  const digits = input.value.replace(/[\s()+.-]/g, '');
  if (!PHONE_RE.test(digits)) {
    input.classList.add('invalid');
    showResult('error', 'Enter 7 to 15 digits in international format, for example 919876543210.');
    input.focus();
    return null;
  }
  input.classList.remove('invalid');
  return digits;
}

function showResult(kind, title, data, actions = []) {
  const box = $('send-result');
  const children = [el('div', { class: 'result-title', text: title })];
  if (actions.length) children.push(el('div', { class: 'result-actions' }, ...actions));
  if (data !== null && data !== undefined) children.push(el('pre', { class: 'result-json', text: JSON.stringify(data, null, 2) }));
  box.className = `result result-${kind}`;
  box.replaceChildren(...children);
  box.hidden = false;
}

function findBool(obj, keys) {
  for (const src of [obj, obj && obj.data, obj && obj.result]) {
    if (!src || typeof src !== 'object') continue;
    for (const key of keys) if (typeof src[key] === 'boolean') return src[key];
  }
  return null;
}

async function withButton(btnId, busyLabel, fn) {
  const btn = $(btnId);
  btn.dataset.busy = '1';
  setBusy(btn, true, busyLabel);
  try {
    await fn();
  } finally {
    delete btn.dataset.busy;
    setBusy(btn, false);
    updateSendButtons();
  }
}

async function checkNumber() {
  const sessionId = $('send-session').value;
  const phone = readPhone();
  if (!sessionId || !phone) return;
  await withButton('check-btn', 'Checking...', async () => {
    try {
      const data = await api(`/sessions/${enc(sessionId)}/contacts/check/${phone}`);
      const exists = findBool(data, ['exists', 'isRegistered', 'registered', 'numberExists', 'onWhatsApp', 'isOnWhatsApp']);
      if (exists === true) showResult('ok', `${phone} is on WhatsApp.`, data);
      else if (exists === false) showResult('warn', `${phone} is not on WhatsApp.`, data);
      else showResult('ok', 'Check completed. See the response below.', data);
    } catch (err) {
      showResult('error', `Check failed: ${err.message}`);
      toast(err.message);
    }
  });
}

async function sendMessage(ev) {
  if (ev) ev.preventDefault();
  const sessionId = $('send-session').value;
  if (!sessionId) return;
  const phone = readPhone();
  if (!phone) return;
  const textarea = $('send-text');
  const text = textarea.value;
  if (!text.trim()) {
    textarea.classList.add('invalid');
    showResult('error', 'Type a message first.');
    textarea.focus();
    return;
  }
  textarea.classList.remove('invalid');

  await withButton('send-btn', 'Sending...', async () => {
    try {
      const data = await api(`/sessions/${enc(sessionId)}/send-text`, { method: 'POST', body: { phone, text } });
      showResult('ok', data && data.messageId ? `Message sent. ID: ${data.messageId}` : 'Message sent.', data);
      toast('Message sent.', 'success', 3000);
    } catch (err) {
      if (err.status === 409) {
        showResult('warn', 'The WhatsApp engine is reconnecting. Wait a few seconds, then retry.', null, [
          el('button', { type: 'button', class: 'btn small', text: 'Retry now', onclick: () => sendMessage() }),
        ]);
        toast('Engine is reconnecting. You can retry in a moment.', 'info');
      } else {
        showResult('error', `Send failed: ${err.message}`);
        toast(err.message);
      }
    }
  });
}

export function initOverview() {
  $('create-form').addEventListener('submit', createSession);
  $('session-name').addEventListener('input', (e) => e.target.classList.remove('invalid'));
  $('qr-close').addEventListener('click', hideQr);
  $('send-form').addEventListener('submit', sendMessage);
  $('check-btn').addEventListener('click', checkNumber);
  $('send-session').addEventListener('change', updateSendButtons);
  $('send-phone').addEventListener('input', (e) => e.target.classList.remove('invalid'));
  $('send-text').addEventListener('input', (e) => e.target.classList.remove('invalid'));

  on('live:session', () => refreshSessions());
  on('live:message', () => refreshStats());
  on('live:contact', () => refreshStats());
}

