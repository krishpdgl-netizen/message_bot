'use strict';

(() => {
  const POLL_MS = 5000;
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

  const $ = (id) => document.getElementById(id);

  const state = {
    sessions: [],
    sessionsSig: '',
    readySig: '',
    sessionsError: '',
    qrSessionId: null,
    healthOk: null,
  };

  // ---------- API ----------
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
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

  // ---------- DOM helpers (no innerHTML anywhere) ----------
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function setBusy(btn, busy, busyLabel) {
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.textContent = busyLabel;
      btn.disabled = true;
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      btn.disabled = false;
    }
  }

  function toast(message, type = 'error', ms = 5000) {
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

  function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  // ---------- Session data helpers ----------
  function normalizeList(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const key of ['data', 'sessions', 'items', 'results']) {
        if (Array.isArray(data[key])) return data[key];
        if (data[key] && typeof data[key] === 'object' && Array.isArray(data[key].sessions)) return data[key].sessions;
      }
    }
    return [];
  }

  const statusOf = (s) => String(s.status || 'unknown').toLowerCase();
  const phoneOf = (s) => String(s.phone || s.phoneNumber || '');
  const nameOf = (s) => String(s.name || 'unnamed');

  function badge(status) {
    const cls = KNOWN_STATUSES.includes(status) ? status : 'error';
    const label = STATUS_LABELS[status] || status.replace(/_/g, ' ');
    return el('span', { class: `badge badge-${cls}`, text: label });
  }

  // ---------- Health ----------
  async function pollHealth() {
    let ok = true;
    try {
      const data = await api('/health');
      if (data && typeof data.status === 'string' && /^(error|down|unhealthy|fail)/i.test(data.status)) ok = false;
    } catch {
      ok = false;
    }

    $('health').className = `pill ${ok ? 'pill-ok' : 'pill-bad'}`;
    $('health-text').textContent = ok ? 'Gateway online' : 'Gateway offline';

    if (state.healthOk === null && !ok) {
      toast('The WhatsApp gateway is unreachable. Check that the openwa container is running.');
    } else if (state.healthOk !== null && state.healthOk !== ok) {
      toast(ok ? 'Gateway is back online.' : 'Lost connection to the WhatsApp gateway.', ok ? 'success' : 'error');
    }
    state.healthOk = ok;
  }

  // ---------- Sessions ----------
  async function refreshSessions() {
    try {
      const data = await api('/sessions');
      const list = normalizeList(data).filter((s) => s && typeof s === 'object' && typeof s.id === 'string');
      state.sessions = list;
      setSessionsError('', 0);
      renderSessions(list);
      renderSessionSelect(list);
      $('sessions-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      setSessionsError(err.message, err.status);
    }
    await refreshQr();
  }

  function setSessionsError(message, status) {
    const banner = $('sessions-error');
    banner.textContent = message;
    banner.hidden = !message;
    // The health pill already reports 502s, so avoid a duplicate toast.
    if (message && message !== state.sessionsError && status !== 502) toast(message);
    state.sessionsError = message;
  }

  function renderSessions(list) {
    const sig = JSON.stringify(list.map((s) => [s.id, s.name, s.status, phoneOf(s), s.pushName, s.createdAt]));
    if (sig === state.sessionsSig) return; // avoid rebuilding buttons under the cursor
    state.sessionsSig = sig;

    $('sessions-body').replaceChildren(...list.map(sessionRow));
    $('sessions-table-wrap').hidden = list.length === 0;
    $('sessions-empty').hidden = list.length > 0;
  }

  function sessionRow(s) {
    const status = statusOf(s);
    const phone = phoneOf(s);
    const startBlocked = ['ready', 'initializing', 'qr_ready', 'authenticating'].includes(status);

    const startBtn = el('button', {
      type: 'button',
      class: 'btn small',
      text: 'Start',
      disabled: startBlocked,
      title: startBlocked ? 'Session is already running' : 'Start this session',
      onclick: (ev) => startSession(s, ev.currentTarget),
    });
    const qrBtn = el('button', {
      type: 'button',
      class: 'btn small ghost',
      text: 'Show QR',
      disabled: status === 'ready',
      onclick: () => openQr(s),
    });

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
      el('td', { class: 'muted small', text: formatDate(s.createdAt) }),
      el('td', { class: 'actions' }, startBtn, qrBtn)
    );
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
      state.sessionsSig = '';
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
      await api(`/sessions/${encodeURIComponent(s.id)}/start`, { method: 'POST' });
      toast(`Starting "${nameOf(s)}". The QR code will appear shortly.`, 'success');
      openQr(s);
      state.sessionsSig = '';
      await refreshSessions();
    } catch (err) {
      toast(`Could not start "${nameOf(s)}": ${err.message}`);
      setBusy(btn, false);
    }
  }

  // ---------- QR ----------
  function openQr(s) {
    state.qrSessionId = s.id;
    $('qr-session-name').textContent = nameOf(s);
    $('qr-img').hidden = true;
    $('qr-img').removeAttribute('src');
    $('qr-status').textContent = 'Loading QR code...';
    $('qr-card').hidden = false;
    $('qr-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    refreshQr();
  }

  function hideQr() {
    state.qrSessionId = null;
    $('qr-card').hidden = true;
    $('qr-img').removeAttribute('src');
  }

  function markConnected(id) {
    const s = state.sessions.find((x) => x.id === id);
    hideQr();
    toast(`"${s ? nameOf(s) : 'Session'}" is connected and ready.`, 'success');
  }

  async function refreshQr() {
    const id = state.qrSessionId;
    if (!id) return;

    const session = state.sessions.find((x) => x.id === id);
    if (session && statusOf(session) === 'ready') return markConnected(id);

    const img = $('qr-img');
    const status = $('qr-status');
    try {
      const data = await api(`/sessions/${encodeURIComponent(id)}/qr`);
      if (state.qrSessionId !== id) return; // card was closed or switched meanwhile

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
      if (state.qrSessionId !== id) return;
      img.hidden = true;
      status.textContent =
        err.status === 400
          ? 'No QR code available yet. If the session is not running, press Start. Waiting...'
          : err.message;
    }
  }

  // ---------- Send test message ----------
  function renderSessionSelect(list) {
    const ready = list.filter((s) => statusOf(s) === 'ready');
    const sig = JSON.stringify(ready.map((s) => [s.id, s.name, phoneOf(s)]));
    if (sig === state.readySig) return;
    state.readySig = sig;

    const select = $('send-session');
    const previous = select.value;

    if (ready.length === 0) {
      select.replaceChildren(el('option', { value: '', text: 'No ready sessions. Start one and scan its QR code.' }));
      select.disabled = true;
    } else {
      select.replaceChildren(
        ...ready.map((s) =>
          el('option', { value: s.id, text: phoneOf(s) ? `${nameOf(s)} (${phoneOf(s)})` : nameOf(s) })
        )
      );
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
    const digits = input.value.replace(/[\s()+-]/g, '');
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
    if (data !== null && data !== undefined) {
      children.push(el('pre', { class: 'result-json', text: JSON.stringify(data, null, 2) }));
    }
    box.className = `result result-${kind}`;
    box.replaceChildren(...children);
    box.hidden = false;
  }

  function findBool(obj, keys) {
    const sources = [obj, obj && obj.data, obj && obj.result];
    for (const src of sources) {
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
        const data = await api(`/sessions/${encodeURIComponent(sessionId)}/contacts/check/${phone}`);
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
        const data = await api(`/sessions/${encodeURIComponent(sessionId)}/send-text`, {
          method: 'POST',
          body: { phone, text },
        });
        const messageId = data && (data.messageId || data.id);
        showResult('ok', messageId ? `Message sent. ID: ${messageId}` : 'Message sent.', data);
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

  // ---------- Polling ----------
  function poll(fn) {
    let timer = null;
    let running = false;
    const run = async () => {
      if (running) return;
      clearTimeout(timer);
      running = true;
      try {
        if (!document.hidden) await fn();
      } catch (err) {
        console.error(err);
      } finally {
        running = false;
        timer = setTimeout(run, POLL_MS);
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) run();
    });
    run();
  }

  // ---------- Wire up ----------
  $('create-form').addEventListener('submit', createSession);
  $('session-name').addEventListener('input', (e) => e.target.classList.remove('invalid'));
  $('qr-close').addEventListener('click', hideQr);
  $('send-form').addEventListener('submit', sendMessage);
  $('check-btn').addEventListener('click', checkNumber);
  $('send-session').addEventListener('change', updateSendButtons);
  $('send-phone').addEventListener('input', (e) => e.target.classList.remove('invalid'));
  $('send-text').addEventListener('input', (e) => {
    e.target.classList.remove('invalid');
    $('send-count').textContent = `${e.target.value.length} / 4096`;
  });

  poll(pollHealth);
  poll(refreshSessions);
})();
