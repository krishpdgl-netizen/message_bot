// App entry: tab routing, polling, live event stream.
import { $, on, connectEvents } from './core.js';
import { initOverview, pollHealth, refreshSessions, refreshStats } from './overview.js';
import { initInbox, showInbox, hideInbox, openConversation } from './inbox.js';
import { initLeads, showLeads, hideLeads } from './leads.js';
import { showRules, hideRules } from './rules.js';
import { initCampaigns, showCampaigns, hideCampaigns } from './campaigns.js';
import { showSettings } from './settings.js';
import { initAi, showAi, hideAi } from './aitab.js';

const POLL_MS = 5000;
const TABS = {
  overview: { show: refreshStats },
  inbox: { show: showInbox, hide: hideInbox },
  ai: { show: showAi, hide: hideAi },
  leads: { show: showLeads, hide: hideLeads },
  automation: { show: showRules, hide: hideRules },
  campaigns: { show: showCampaigns, hide: hideCampaigns },
  settings: { show: showSettings },
};
let current = null;

function route() {
  const name = (location.hash || '#overview').slice(1);
  const tab = TABS[name] ? name : 'overview';
  if (tab === current) return;
  if (current && TABS[current].hide) TABS[current].hide();
  current = tab;
  for (const key of Object.keys(TABS)) $(`view-${key}`).hidden = key !== tab;
  for (const a of document.querySelectorAll('#tabs a')) {
    const active = a.dataset.tab === tab;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  TABS[tab].show();
}

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

initOverview();
initInbox();
initLeads();
initCampaigns();
initAi();

on('open-chat', (chatId) => {
  location.hash = '#inbox';
  openConversation(chatId);
});
on('open-chat-followup', (chatId) => {
  location.hash = '#inbox';
  openConversation(chatId, { followup: true });
});

const live = $('live');
on('live:open', () => {
  live.className = 'live on';
  live.title = 'Live updates connected';
});
on('live:error', () => {
  live.className = 'live off';
  live.title = 'Live updates reconnecting';
});

window.addEventListener('hashchange', route);
route();
connectEvents();
poll(pollHealth);
poll(refreshSessions);
setInterval(() => !document.hidden && refreshStats(), 30000);
// Keep the unread and AI badges fresh when the agent acts.
let statsTimer = null;
on('live:ai', () => {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(refreshStats, 1500);
});
