'use strict';

const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  openwaUrl: (env.OPENWA_URL || 'http://openwa:2785').replace(/\/+$/, ''),
  openwaApiKey: env.OPENWA_API_KEY || '',
  dashboardUser: env.DASHBOARD_USER || '',
  dashboardPass: env.DASHBOARD_PASS || '',
  // Shared secret OpenWA uses to sign webhook deliveries (min 16 chars, OpenWA rule).
  webhookSecret: env.WEBHOOK_SECRET || '',
  // URL OpenWA calls. Inside the compose network the dashboard is reachable as "dashboard".
  webhookUrl: env.WEBHOOK_URL || 'http://dashboard:3000/webhooks/openwa',
  autoRegisterWebhooks: env.AUTO_REGISTER_WEBHOOKS !== 'false',
  dataDir: env.DATA_DIR || '/app/data',
  defaultTimezone: env.TZ || 'Asia/Kolkata',
  upstreamTimeoutMs: 15000,
};

function assertConfig() {
  const missing = [];
  if (!config.openwaApiKey) missing.push('OPENWA_API_KEY');
  if (!config.dashboardUser) missing.push('DASHBOARD_USER');
  if (!config.dashboardPass) missing.push('DASHBOARD_PASS');
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (config.webhookSecret && config.webhookSecret.length < 16) {
    console.error('WEBHOOK_SECRET must be at least 16 characters (OpenWA requirement).');
    process.exit(1);
  }
  if (!config.webhookSecret) {
    console.warn('WEBHOOK_SECRET is not set: inbox, auto-replies and delivery receipts are disabled.');
  }
}

module.exports = { config, assertConfig };
