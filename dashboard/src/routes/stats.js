'use strict';

const express = require('express');
const store = require('../db');
const { isOpen } = require('../schedule');

const { db } = store;
const router = express.Router();

router.get('/stats', (req, res) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;

  const bySource = Object.fromEntries(
    db
      .prepare('SELECT source, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY source')
      .all(since)
      .map((r) => [r.source, r.n])
  );

  // Messages per day for the last 14 days (UTC days), inbound vs outbound.
  const fortnight = new Date(Date.now() - 13 * 24 * 3600 * 1000);
  fortnight.setUTCHours(0, 0, 0, 0);
  const daily = db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(direction = 'in') AS inbound,
              SUM(direction = 'out') AS outbound
       FROM messages WHERE created_at >= ? GROUP BY day ORDER BY day`
    )
    .all(fortnight.toISOString());

  res.json({
    open: isOpen(),
    last24h: {
      inbound: bySource.contact || 0,
      autoReplies: (bySource.auto || 0) + (bySource.ai || 0),
      aiReplies: bySource.ai || 0,
      manual: (bySource.manual || 0) + (bySource.phone || 0),
      campaign: bySource.campaign || 0,
      newLeads: count("SELECT COUNT(*) AS n FROM contacts WHERE created_at >= ? AND source = 'inbound'", since),
    },
    totals: {
      contacts: count('SELECT COUNT(*) AS n FROM contacts'),
      unreadChats: count('SELECT COUNT(*) AS n FROM contacts WHERE unread > 0'),
      optedOut: count('SELECT COUNT(*) AS n FROM contacts WHERE opted_out = 1'),
      activeRules: count('SELECT COUNT(*) AS n FROM rules WHERE enabled = 1'),
      runningCampaigns: count("SELECT COUNT(*) AS n FROM campaigns WHERE status IN ('running', 'scheduled')"),
      aiDrafts: count("SELECT COUNT(DISTINCT chat_id) AS n FROM ai_drafts WHERE status = 'pending'"),
      aiFlagged: count("SELECT COUNT(*) AS n FROM contacts WHERE ai_flag IN ('needs_human', 'unhappy') AND opted_out = 0"),
    },
    stages: db.prepare('SELECT stage, COUNT(*) AS n FROM contacts GROUP BY stage').all(),
    daily,
  });
});

module.exports = router;
