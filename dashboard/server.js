'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { config, assertConfig } = require('./src/config');

assertConfig();

const v = require('./src/validate');
const { UpstreamError } = require('./src/openwa');
const { AiError } = require('./src/llm');
const ai = require('./src/ai');
const events = require('./src/events');
const webhooks = require('./src/webhooks');
const campaigns = require('./src/campaigns');

const app = express();
app.disable('x-powered-by');
// Caddy sits in front on the private Docker network.
app.set('trust proxy', 'uniquelocal');

// ---------- Security headers ----------
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// Unauthenticated liveness check for the Docker healthcheck.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// OpenWA webhook receiver. Authenticated by HMAC signature, not Basic auth.
app.use('/webhooks', webhooks.router);

// ---------- HTTP Basic auth (timing safe, with lockout) ----------
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const USER_HASH = sha256(config.dashboardUser);
const PASS_HASH = sha256(config.dashboardPass);
const failures = new Map(); // ip -> { count, first }
const LOCK_AFTER = 10;
const WINDOW_MS = 15 * 60 * 1000;

function basicAuth(req, res, next) {
  const ip = req.ip || 'unknown';
  const record = failures.get(ip);
  if (record && record.count >= LOCK_AFTER && Date.now() - record.first < WINDOW_MS) {
    return res.status(429).send('Too many failed logins. Try again in 15 minutes.');
  }

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
  if (userOk && passOk) {
    failures.delete(ip);
    return next();
  }

  if (header) {
    const fresh = !record || Date.now() - record.first >= WINDOW_MS;
    failures.set(ip, fresh ? { count: 1, first: Date.now() } : { count: record.count + 1, first: record.first });
  }
  res.set('WWW-Authenticate', 'Basic realm="WhatsApp Dashboard", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, r] of failures) if (r.first < cutoff) failures.delete(ip);
}, WINDOW_MS).unref();

app.use(basicAuth);

// ---------- API ----------
const api = express.Router();
// File uploads (attachments, media library) are sent as base64 JSON and need a larger limit.
const smallJson = express.json({ limit: '2mb' });
const uploadJson = express.json({ limit: '24mb' });
api.use((req, res, next) => (/\/(send-media|library)$/.test(req.path) ? uploadJson : smallJson)(req, res, next));

api.get('/events', events.handleStream);
api.use(require('./src/routes/gateway'));
api.use(require('./src/routes/inbox'));
api.use(require('./src/routes/contacts'));
api.use(require('./src/routes/automation'));
api.use(require('./src/routes/campaigns'));
api.use(require('./src/routes/stats'));
api.use(require('./src/routes/ai'));

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err instanceof v.ValidationError) return res.status(err.status || 400).json({ error: err.message });
  if (err instanceof UpstreamError) {
    if (err.status === 0) {
      return res.status(502).json({ error: 'WhatsApp gateway is unreachable. Check that the openwa container is running.' });
    }
    if (err.status === 401 || err.status === 403) {
      return res.status(502).json({ error: 'The gateway rejected the API key. Check OPENWA_API_KEY on the server.' });
    }
    if (err.status >= 500) return res.status(502).json({ error: `Gateway error: ${err.message}` });
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof AiError) return res.status(err.status || 502).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  console.error('[api] unexpected error:', err.message);
  return res.status(500).json({ error: 'Internal server error.' });
});

app.use('/api', api);

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '5m' }));

const server = app.listen(config.port, () => {
  console.log(`Dashboard listening on port ${config.port}`);
  webhooks.startRegistrationLoop();
  campaigns.startWorker();
  ai.startMaintenance();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
