// Settings tab: business hours, welcome / away messages, opt-out, safety limits.
import { $, api, el, toast, withBusy, field } from './core.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

const local = { settings: null, open: true };

async function load() {
  try {
    const data = await api('/settings');
    local.settings = data.settings;
    local.open = data.open;
    render();
  } catch (err) {
    toast(err.message);
  }
}

// One card per setting key, each with its own Save button.
function card(title, description, key, controls, collect) {
  const btn = el('button', { type: 'button', class: 'btn primary', text: 'Save' });
  btn.addEventListener('click', async () => {
    const res = await withBusy(btn, 'Saving...', () => api(`/settings/${key}`, { method: 'PUT', body: collect() }));
    if (res) {
      local.settings[key] = res.value;
      local.open = res.open;
      toast(`${title} saved.`, 'success', 2500);
      if (key === 'businessHours') render();
    }
  });
  return el(
    'section',
    { class: 'card settings-card' },
    el('div', { class: 'card-head' }, el('h2', { text: title })),
    description ? el('p', { class: 'muted small', text: description }) : null,
    el('div', { class: 'form-grid' }, ...controls),
    el('div', { class: 'card-foot' }, btn)
  );
}

const toggle = (label, checked) => {
  const input = el('input', { type: 'checkbox', class: 'switch', checked });
  return { input, node: el('label', { class: 'check span-all' }, input, el('span', { text: label })) };
};

function render() {
  const s = local.settings;

  // Business hours
  const bh = s.businessHours;
  const bhOn = toggle('Use business hours', bh.enabled);
  const tz = el('input', { type: 'text', list: 'tz-list', value: bh.timezone });
  const tzList = el('datalist', { id: 'tz-list' }, ...ZONES.map((z) => el('option', { value: z })));
  const start = el('input', { type: 'time', value: bh.start });
  const end = el('input', { type: 'time', value: bh.end });
  const dayBoxes = DAYS.map((d, i) => {
    const box = el('input', { type: 'checkbox', checked: bh.days.includes(i), value: String(i) });
    return { box, node: el('label', { class: 'day' }, box, el('span', { text: d })) };
  });

  const businessCard = card(
    'Business hours',
    `Right now you are ${local.open ? 'open' : 'closed'}. Rules can run only in or outside these hours, the away message goes out when closed, and campaigns can wait for opening time.`,
    'businessHours',
    [
      bhOn.node,
      field('Time zone', el('span', {}, tz, tzList)),
      el('div', { class: 'row tight' }, field('Opens', start), field('Closes', end)),
      el('div', { class: 'span-all' }, el('span', { class: 'field-label', text: 'Open on' }), el('div', { class: 'days' }, ...dayBoxes.map((d) => d.node))),
    ],
    () => ({ enabled: bhOn.input.checked, timezone: tz.value.trim(), start: start.value, end: end.value, days: dayBoxes.filter((d) => d.box.checked).map((d) => Number(d.box.value)) })
  );

  // Welcome
  const wOn = toggle('Send a welcome message to new contacts', s.welcome.enabled);
  const wText = el('textarea', { rows: '3', maxlength: '4096', value: s.welcome.text });
  const welcomeCard = card(
    'Welcome message',
    'Sent once, to people messaging you for the first time, when no rule matched their message.',
    'welcome',
    [wOn.node, el('div', { class: 'span-all' }, field('Message', wText, 'Variables: {{name}}, {{first_name}}'))],
    () => ({ enabled: wOn.input.checked, text: wText.value })
  );

  // Away
  const aOn = toggle('Send an away message outside business hours', s.away.enabled);
  const aText = el('textarea', { rows: '3', maxlength: '4096', value: s.away.text });
  const aCool = el('input', { type: 'number', min: '1', max: '168', value: String(s.away.cooldownHours) });
  const awayCard = card(
    'Away message',
    'Needs business hours turned on. Sent at most once per contact within the cooldown.',
    'away',
    [aOn.node, el('div', { class: 'span-all' }, field('Message', aText)), field('Cooldown (hours)', aCool)],
    () => ({ enabled: aOn.input.checked, text: aText.value, cooldownHours: aCool.value })
  );

  // Opt-out
  const oOn = toggle('Handle STOP and START keywords', s.optOut.enabled);
  const oKeys = el('input', { type: 'text', value: s.optOut.keywords.join(', ') });
  const oInKeys = el('input', { type: 'text', value: s.optOut.optInKeywords.join(', ') });
  const oReply = el('textarea', { rows: '2', maxlength: '4096', value: s.optOut.reply });
  const oInReply = el('textarea', { rows: '2', maxlength: '4096', value: s.optOut.optInReply });
  const optCard = card(
    'Opt-out',
    'A message that is exactly one of these words marks the contact as opted out. Opted-out contacts never get auto-replies or campaigns.',
    'optOut',
    [oOn.node, field('Opt-out keywords', oKeys, 'Comma separated'), field('Opt-in keywords', oInKeys, 'Comma separated'), field('Opt-out confirmation', oReply), field('Opt-in confirmation', oInReply)],
    () => ({ enabled: oOn.input.checked, keywords: oKeys.value, optInKeywords: oInKeys.value, reply: oReply.value, optInReply: oInReply.value })
  );

  // Takeover
  const pause = el('input', { type: 'number', min: '0', max: '10080', value: String(s.humanTakeover.pauseMinutes) });
  const takeoverCard = card(
    'Human takeover',
    'When you reply to a chat from the inbox, the bot stays quiet in that chat for this long so it does not talk over you. 0 turns this off.',
    'humanTakeover',
    [field('Pause bot after a manual reply (minutes)', pause)],
    () => ({ pauseMinutes: pause.value })
  );

  // Safety
  const maxAuto = el('input', { type: 'number', min: '1', max: '50', value: String(s.safety.maxAutoRepliesPerHour) });
  const safetyCard = card(
    'Auto-reply safety',
    'Stops reply loops with other bots and keeps the number looking human.',
    'safety',
    [field('Max auto-replies per contact per hour', maxAuto)],
    () => ({ maxAutoRepliesPerHour: maxAuto.value })
  );

  // Campaign limits
  const cap = el('input', { type: 'number', min: '0', max: '10000', value: String(s.campaigns.dailyCap) });
  const minD = el('input', { type: 'number', min: '3', max: '3600', value: String(s.campaigns.minDelay) });
  const maxD = el('input', { type: 'number', min: '3', max: '3600', value: String(s.campaigns.maxDelay) });
  const campaignCard = card(
    'Campaign limits',
    'New and older numbers should start low (50 to 100 a day) and increase slowly. 0 removes the daily cap.',
    'campaigns',
    [field('Daily cap per number', cap), field('Default minimum pause (seconds)', minD), field('Default maximum pause (seconds)', maxD)],
    () => ({ dailyCap: cap.value, minDelay: minD.value, maxDelay: maxD.value })
  );

  $('view-settings').replaceChildren(el('div', { class: 'grid' }, businessCard, welcomeCard, awayCard, optCard, takeoverCard, safetyCard, campaignCard));
}

export function showSettings() {
  load();
}
