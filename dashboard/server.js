'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');

const {
  OPENWA_URL = 'http://openwa:2785',
  OPENWA_API_KEY,
  DASHBOARD_USER,
  DASHBOARD_PASS,
  PORT = '3000',
} = process.env;

for (const [name, value] of Object.entries({ OPENWA_API_KEY, DASHBOARD_USER, DASHBOARD_PASS })) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const UPSTREAM = OPENWA_URL.replace(/\/+$/, '');
const UPSTREAM_TIMEOUT_MS = 15000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9-]{3,50}$/;
const PHONE_RE = /^\d{7,15}$/;
const MAX_TEXT_LENGTH = 4096;

const app = express();
app.disable('x-powered-by');

// ---------- Security headers ----------
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// Unauthenticated liveness check for the Docker healthcheck. Reveals nothing.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- HTTP Basic auth (timing safe) ----------
// Hashing both sides gives equal-length buffers, so timingSafeEqual never throws
// and the comparison does not leak the length of the secret.
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const USER_HASH = sha256(DASHBOARD_USER);
const PASS_HASH = sha256(DASHBOARD_PASS);

function basicAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  let user = '';
  let pass = '';

  if (scheme && scheme.toLowerCase() === 'basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep >= 0) {
      user = decoded.slice(0, sep);
      pass = decoded.slice(sep + 1);
    }
  }

  const userOk = crypto.timingSafeEqual(sha256(user), USER_HASH);
  const passOk = crypto.timingSafeEqual(sha256(pass), PASS_HASH);
  if (userOk && passOk) return next();

  res.set('WWW-Authenticate', 'Basic realm="WhatsApp Dashboard", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

app.use(basicAuth);

// ---------- Validation helpers ----------
class ValidationError extends Error {}

function sessionId(req) {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) throw new ValidationError('Invalid session id.');
  return id.toLowerCase();
}

function sessionName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!NAME_RE.test(name)) {
    throw new ValidationError('Session name must be 3 to 50 characters: letters, digits and hyphens only.');
  }
  return name;
}

function phoneNumber(value) {
  // Accept common formatting (spaces, +, dashes, brackets) but forward digits only.
  const digits = String(value ?? '').replace(/[\s()+-]/g, '');
  if (!PHONE_RE.test(digits)) {
    throw new ValidationError(
      'Phone must be 7 to 15 digits in international format without +, for example 919876543210.'
    );
  }
  return digits;
}

function messageText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('Message text is required.');
  if (value.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`Message is too long (max ${MAX_TEXT_LENGTH} characters).`);
  }
  return value;
}

// ---------- Upstream calls ----------
async function callOpenWA(method, apiPath, body) {
  const headers = { 'X-API-Key': OPENWA_API_KEY, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(UPSTREAM + apiPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw.slice(0, 500) };
    }
  }
  return { status: res.status, data };
}

function upstreamMessage(data, status) {
  const m = data && (data.message ?? data.error);
  if (Array.isArray(m)) return m.map(String).join('; ').slice(0, 300);
  if (typeof m === 'string' && m.trim()) return m.slice(0, 300);
  if (m && typeof m === 'object' && typeof m.message === 'string') return m.message.slice(0, 300);
  return `Gateway returned HTTP ${status}.`;
}

// Builds a route handler: validate input, call OpenWA, translate the result.
function relay(method, buildPath, buildBody) {
  return async (req, res) => {
    let upstreamPath;
    let body;
    try {
      upstreamPath = buildPath(req);
      body = buildBody ? buildBody(req) : undefined;
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }

    let result;
    try {
      result = await callOpenWA(method, upstreamPath, body);
    } catch (err) {
      // Network failure or timeout. Log the error type only.
      console.warn(`[proxy] ${method} ${req.baseUrl}${req.route.path} failed upstream: ${err.name}`);
      return res
        .status(502)
        .json({ error: 'WhatsApp gateway is unreachable. Check that the openwa container is running.' });
    }

    const { status, data } = result;

    if (status === 401 || status === 403) {
      return res.status(502).json({ error: 'The gateway rejected the API key. Check OPENWA_API_KEY on the server.' });
    }
    if (status >= 500) {
      return res.status(502).json({ error: `Gateway error: ${upstreamMessage(data, status)}` });
    }
    if (status >= 400) {
      return res.status(status).json({ error: upstreamMessage(data, status) });
    }
    if (method !== 'GET') console.log(`[proxy] ${method} ${req.baseUrl}${req.route.path} -> ${status}`);
    return res.status(status).json(data ?? {});
  };
}

// ---------- API routes (browser talks only to these) ----------
const api = express.Router();
api.use(express.json({ limit: '32kb' }));

api.get('/health', relay('GET', () => '/api/health'));

api.get('/sessions', relay('GET', () => '/api/sessions'));

api.post('/sessions', relay('POST', () => '/api/sessions', (req) => ({ name: sessionName(req.body?.name) })));

api.get('/sessions/:id', relay('GET', (req) => `/api/sessions/${sessionId(req)}`));

api.post('/sessions/:id/start', relay('POST', (req) => `/api/sessions/${sessionId(req)}/start`));

api.get('/sessions/:id/qr', relay('GET', (req) => `/api/sessions/${sessionId(req)}/qr`));

api.post(
  '/sessions/:id/send-text',
  relay(
    'POST',
    (req) => `/api/sessions/${sessionId(req)}/messages/send-text`,
    (req) => ({
      chatId: `${phoneNumber(req.body?.phone)}@c.us`,
      text: messageText(req.body?.text),
    })
  )
);

api.get(
  '/sessions/:id/contacts/check/:number',
  relay('GET', (req) => `/api/sessions/${sessionId(req)}/contacts/check/${phoneNumber(req.params.number)}`)
);

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  console.error('[api] unexpected error:', err.message);
  return res.status(500).json({ error: 'Internal server error.' });
});

app.use('/api', api);

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '5m' }));

const server = app.listen(Number(PORT), () => {
  console.log(`Dashboard listening on port ${PORT}`);
});

// Clean shutdown so "docker compose down" is fast.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
