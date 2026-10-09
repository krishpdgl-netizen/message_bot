'use strict';

// Thin, validated proxy to the OpenWA endpoints the dashboard uses directly.
const express = require('express');
const v = require('../validate');
const openwa = require('../openwa');
const webhooks = require('../webhooks');
const { sendAndRecord } = require('../messaging');
const { config } = require('../config');

const router = express.Router();

function relay(method, buildPath, buildBody) {
  return async (req, res) => {
    const upstreamPath = buildPath(req);
    const body = buildBody ? buildBody(req) : undefined;
    let result;
    try {
      result = await openwa.call(method, upstreamPath, body);
    } catch (err) {
      throw new openwa.UpstreamError('WhatsApp gateway is unreachable.', 0, { cause: err.name });
    }
    if (result.status >= 400) {
      throw new openwa.UpstreamError(openwa.upstreamMessage(result.data, result.status), result.status, result.data);
    }
    res.status(result.status).json(result.data ?? {});
  };
}

const sid = (req) => v.uuid(req.params.id, 'session id');

router.get('/health', relay('GET', () => '/api/health'));
router.get('/sessions', relay('GET', () => '/api/sessions'));
router.post('/sessions', relay('POST', () => '/api/sessions', (req) => ({ name: v.sessionName(req.body?.name) })));
router.get('/sessions/:id', relay('GET', (req) => `/api/sessions/${sid(req)}`));
router.post('/sessions/:id/start', relay('POST', (req) => `/api/sessions/${sid(req)}/start`));
router.get('/sessions/:id/qr', relay('GET', (req) => `/api/sessions/${sid(req)}/qr`));
router.get(
  '/sessions/:id/contacts/check/:number',
  relay('GET', (req) => `/api/sessions/${sid(req)}/contacts/check/${v.phone(req.params.number)}`)
);

// Test send from the overview page. Recorded in the inbox like any other outbound message.
router.post('/sessions/:id/send-text', async (req, res) => {
  const sessionId = sid(req);
  const chatId = `${v.phone(req.body?.phone)}@c.us`;
  const text = v.text(req.body?.text);
  const { messageId } = await sendAndRecord({ sessionId, chatId, text, source: 'manual' });
  res.json({ messageId, chatId });
});

// Webhook (inbox) connection status per session, and a manual re-check.
router.get('/webhooks/status', (req, res) => {
  res.json({
    configured: Boolean(config.webhookSecret),
    autoRegister: config.autoRegisterWebhooks,
    sessions: webhooks.getStatus(),
  });
});

router.post('/sessions/:id/webhook', async (req, res) => {
  res.json(await webhooks.ensureForSession(sid(req)));
});

module.exports = router;
