// Campaigns tab: scheduled and bulk sends with throttling.
import {
  $, api, el, toast, withBusy, on, state, openDialog, confirmDialog, field, emptyState,
  STAGES, STAGE_LABELS, formatDate, rowsToRecipients, sessionLabel,
} from './core.js';

const STATUS_LABELS = {
  scheduled: 'Scheduled',
  running: 'Sending',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const local = { items: [], settings: null, active: false };

async function load() {
  try {
    const [list, settings] = await Promise.all([api('/campaigns'), api('/settings')]);
    local.items = list.items;
    local.settings = settings.settings;
    render();
  } catch (err) {
    toast(err.message);
  }
}

function progress(c) {
  const done = c.sent + c.failed + c.skipped;
  const pct = c.total ? Math.round((done / c.total) * 100) : 0;
  // Widths are set through the style object: the CSP blocks inline style attributes.
  const sentBar = el('span', { class: 'progress-sent' });
  const failedBar = el('span', { class: 'progress-failed' });
  sentBar.style.width = `${c.total ? (c.sent / c.total) * 100 : 0}%`;
  failedBar.style.width = `${c.total ? ((c.failed + c.skipped) / c.total) * 100 : 0}%`;
  return el(
    'div',
    { class: 'progress-wrap' },
    el(
      'div',
      { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `${pct}% done` },
      sentBar,
      failedBar
    ),
    el(
      'div',
      { class: 'progress-legend small' },
      el('span', { text: `${c.sent} sent` }),
      c.failed ? el('span', { class: 'err-text', text: `${c.failed} failed` }) : null,
      c.skipped ? el('span', { class: 'muted', text: `${c.skipped} skipped` }) : null,
      el('span', { class: 'muted', text: `${c.pending} left of ${c.total}` })
    )
  );
}

function campaignCard(c) {
  const session = state.sessions.find((s) => s.id === c.sessionId);
  const act = (label, path, opts = {}) =>
    el('button', {
      type: 'button',
      class: `btn small ${opts.primary ? 'primary' : 'ghost'} ${opts.danger ? 'danger-text' : ''}`,
      text: label,
      onclick: async (e) => {
        if (opts.confirm && !(await confirmDialog(opts.confirm.title, opts.confirm.text, { confirmLabel: label, danger: true }))) return;
        const res = await withBusy(e.currentTarget, 'Working...', () => api(`/campaigns/${c.id}${path}`, { method: opts.method || 'POST' }));
        if (res) load();
      },
    });

  const actions = [];
  if (c.status === 'running' || c.status === 'scheduled') actions.push(act('Pause', '/pause'));
  if (c.status === 'paused') actions.push(act('Resume', '/resume', { primary: true }));
  if (['running', 'scheduled', 'paused'].includes(c.status)) {
    actions.push(act('Cancel', '/cancel', { danger: true, confirm: { title: 'Cancel campaign', text: `Stop "${c.name}" for good? Messages already sent stay sent.` } }));
  }
  if (c.failed && c.status !== 'running') actions.push(act('Retry failed', '/retry-failed'));
  actions.push(el('button', { type: 'button', class: 'btn small ghost', text: 'Recipients', onclick: () => openDetails(c) }));
  if (['completed', 'cancelled', 'paused'].includes(c.status)) {
    actions.push(act('Delete', '', { method: 'DELETE', danger: true, confirm: { title: 'Delete campaign', text: `Delete "${c.name}" and its recipient list?` } }));
  }

  let when = `Created ${formatDate(c.createdAt)}`;
  if (c.status === 'scheduled' && c.scheduledAt) when = `Starts ${formatDate(c.scheduledAt)}`;
  else if (c.startedAt) when = `Started ${formatDate(c.startedAt)}`;
  if (c.finishedAt) when += `, finished ${formatDate(c.finishedAt)}`;

  return el(
    'article',
    { class: 'campaign' },
    el(
      'div',
      { class: 'campaign-head' },
      el('div', {}, el('h3', { text: c.name }), el('p', { class: 'muted small', text: `${session ? sessionLabel(session) : 'Unknown session'}. ${when}` })),
      el('span', { class: `badge campaign-${c.status}`, text: STATUS_LABELS[c.status] || c.status })
    ),
    el('div', { class: 'campaign-msg' }, el('span', { class: 'clamp', text: c.message })),
    progress(c),
    c.lastError && c.status !== 'completed' ? el('p', { class: 'small warn-text', text: c.lastError }) : null,
    el('div', { class: 'row tight' }, ...actions)
  );
}

function render() {
  const view = $('view-campaigns');
  const cap = local.settings ? local.settings.campaigns.dailyCap : 0;
  view.replaceChildren(
    el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('h2', { text: 'Campaigns' }),
        el('button', { type: 'button', class: 'btn primary', text: 'New campaign', onclick: openCreate })
      ),
      el(
        'p',
        { class: 'banner banner-info slim' },
        `Messages go out one at a time with a random pause between them, and at most ${cap || 'unlimited'} campaign messages per number per 24 hours. Only message people who expect to hear from you: unsolicited bulk messages get WhatsApp numbers banned.`
      ),
      local.items.length ? el('div', { class: 'campaign-list' }, ...local.items.map(campaignCard)) : emptyState('No campaigns yet. Create one to send a scheduled message to a list or a tag.')
    )
  );
}

function openCreate() {
  const defaults = local.settings.campaigns;
  const name = el('input', { type: 'text', maxlength: '80', placeholder: 'e.g. Diwali offer follow-up' });
  const session = el('select', {});
  const ready = state.readySessions.length ? state.readySessions : state.sessions;
  session.replaceChildren(...ready.map((s) => el('option', { value: s.id, text: sessionLabel(s) })));
  if (!ready.length) session.append(el('option', { value: '', text: 'No sessions available' }));

  const message = el('textarea', { rows: '5', maxlength: '4096', placeholder: 'Hi {{first_name}}, ...' });
  const preview = el('div', { class: 'wa-preview' }, el('p', { class: 'bubble out', text: 'Your message preview appears here.' }));
  message.addEventListener('input', () => {
    preview.firstChild.textContent = (message.value || 'Your message preview appears here.')
      .replace(/\{\{\s*name\s*\}\}/gi, 'Priya Shah')
      .replace(/\{\{\s*first_name\s*\}\}/gi, 'Priya')
      .replace(/\{\{\s*phone\s*\}\}/gi, '919876543210');
  });

  // AI copywriter: describe the goal, get a ready message.
  const goal = el('input', { type: 'text', maxlength: '600', placeholder: 'Goal, e.g. "20% off sofas this weekend, invite to showroom"' });
  const tone = el('select', { 'aria-label': 'Tone', class: 'auto-width' }, ...['friendly', 'professional', 'excited', 'short and direct'].map((t) => el('option', { value: t, text: t })));
  const writeBtn = el('button', { type: 'button', class: 'btn small ai-btn', text: '✨ Write with AI' });
  writeBtn.addEventListener('click', async () => {
    if (!goal.value.trim()) return toast('Describe the goal of the campaign first.');
    const res = await withBusy(writeBtn, 'Writing...', () => api('/ai/write-campaign', { method: 'POST', body: { goal: goal.value, tone: tone.value } }));
    if (res) {
      message.value = res.text;
      message.dispatchEvent(new Event('input'));
    }
    return undefined;
  });
  const aiWriter = el('div', { class: 'ai-writer' }, goal, tone, writeBtn);

  // Audience
  const numbers = el('textarea', { rows: '5', placeholder: '919876543210,Priya Shah\n919812345678,Amit Patel' });
  const file = el('input', { type: 'file', accept: '.csv,text/csv,text/plain' });
  const tag = el('select', {}, el('option', { value: '', text: 'No tag filter' }));
  const stage = el('select', {}, el('option', { value: '', text: 'No stage filter' }), ...STAGES.map((s) => el('option', { value: s, text: STAGE_LABELS[s] })));
  const audienceNote = el('p', { class: 'muted small', text: '' });
  api('/tags')
    .then((t) => tag.append(...t.items.map((x) => el('option', { value: x.tag, text: `${x.tag} (${x.count})` }))))
    .catch(() => {});

  const updateAudience = () => {
    const rows = rowsToRecipients(numbers.value);
    const parts = [];
    if (rows.length) parts.push(`${rows.length} pasted number${rows.length === 1 ? '' : 's'}`);
    if (tag.value) parts.push(`leads tagged "${tag.value}"`);
    if (stage.value) parts.push(`leads in stage ${STAGE_LABELS[stage.value]}`);
    audienceNote.textContent = parts.length
      ? `Sending to: ${parts.join(' plus ')}${tag.value && stage.value ? ' (tag and stage must both match)' : ''}. Opted-out contacts are always excluded.`
      : 'Add numbers, choose a tag or a stage.';
    updateEstimate(rows.length);
  };
  numbers.addEventListener('input', updateAudience);
  tag.addEventListener('change', updateAudience);
  stage.addEventListener('change', updateAudience);
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('File is larger than 5 MB.');
    numbers.value = await f.text();
    updateAudience();
  });

  // Timing
  const when = el('select', {}, el('option', { value: 'now', text: 'Start now' }), el('option', { value: 'later', text: 'Schedule for later' }), el('option', { value: 'draft', text: 'Save as paused draft' }));
  const at = el('input', { type: 'datetime-local' });
  const atField = field('Send at (your local time)', at);
  atField.hidden = true;
  when.addEventListener('change', () => {
    atField.hidden = when.value !== 'later';
  });
  const minDelay = el('input', { type: 'number', min: '3', max: '3600', value: String(defaults.minDelay) });
  const maxDelay = el('input', { type: 'number', min: '3', max: '3600', value: String(defaults.maxDelay) });
  const bizOnly = el('input', { type: 'checkbox' });
  const skipUnreg = el('input', { type: 'checkbox', checked: true });
  const estimate = el('p', { class: 'muted small' });
  function updateEstimate(count) {
    const avg = (Number(minDelay.value) + Number(maxDelay.value)) / 2 || 0;
    if (!count) {
      estimate.textContent = '';
      return;
    }
    const mins = Math.ceil((count * avg) / 60);
    estimate.textContent = `About ${mins} minute${mins === 1 ? '' : 's'} for ${count} pasted numbers, plus any daily cap pauses.`;
  }
  minDelay.addEventListener('input', () => updateEstimate(rowsToRecipients(numbers.value).length));
  maxDelay.addEventListener('input', () => updateEstimate(rowsToRecipients(numbers.value).length));
  updateAudience();

  openDialog({
    title: 'New campaign',
    wide: true,
    body: el(
      'div',
      { class: 'form-grid' },
      field('Campaign name', name),
      field('Send from', session),
      el('div', {}, field('Message', message, 'Variables: {{name}}, {{first_name}}, {{phone}}'), aiWriter),
      el('div', {}, el('span', { class: 'field-label', text: 'Preview' }), preview),
      el('h3', { class: 'span-all form-section', text: 'Audience' }),
      el('div', {}, field('Numbers (one per line, optional name after a comma)', numbers), field('Or load a CSV', file)),
      el('div', {}, field('Leads with tag', tag), field('Leads in stage', stage)),
      el('div', { class: 'span-all' }, audienceNote),
      el('h3', { class: 'span-all form-section', text: 'Timing and safety' }),
      field('When', when),
      atField,
      field('Minimum pause between messages (seconds)', minDelay),
      field('Maximum pause between messages (seconds)', maxDelay),
      el('label', { class: 'check' }, bizOnly, el('span', { text: 'Only send during business hours' })),
      el('label', { class: 'check' }, skipUnreg, el('span', { text: 'Skip numbers that are not on WhatsApp' })),
      el('div', { class: 'span-all' }, estimate)
    ),
    actions: [
      {
        label: 'Create campaign',
        primary: true,
        onClick: async (close, btn) => {
          const recipients = rowsToRecipients(numbers.value).map(({ phone, name: n }) => ({ phone, name: n }));
          let scheduledAt = null;
          if (when.value === 'later') {
            if (!at.value) return toast('Pick a date and time.');
            scheduledAt = new Date(at.value).toISOString();
          }
          const body = {
            name: name.value,
            sessionId: session.value,
            message: message.value,
            recipients,
            audience: tag.value || stage.value ? { tag: tag.value || undefined, stage: stage.value || undefined } : undefined,
            scheduledAt,
            draft: when.value === 'draft',
            minDelay: minDelay.value,
            maxDelay: maxDelay.value,
            businessHoursOnly: bizOnly.checked,
            skipUnregistered: skipUnreg.checked,
          };
          const res = await withBusy(btn, 'Creating...', () => api('/campaigns', { method: 'POST', body }));
          if (!res) return;
          close();
          const notes = [];
          if (res.invalid.length) notes.push(`${res.invalid.length} invalid number(s) left out`);
          if (res.excludedOptedOut) notes.push(`${res.excludedOptedOut} opted-out contact(s) excluded`);
          toast(`Campaign created with ${res.campaign.total} recipients.${notes.length ? ` ${notes.join(', ')}.` : ''}`, 'success', 7000);
          load();
        },
      },
    ],
  });
}

async function openDetails(c) {
  const list = el('div', { class: 'recipients' });
  const filter = el(
    'select',
    { 'aria-label': 'Filter recipients' },
    ...[['', 'All'], ['pending', 'Pending'], ['sent', 'Sent'], ['failed', 'Failed'], ['skipped', 'Skipped']].map(([v, l]) => el('option', { value: v, text: l }))
  );
  const fill = async () => {
    try {
      const data = await api(`/campaigns/${c.id}${filter.value ? `?status=${filter.value}` : ''}`);
      list.replaceChildren(
        data.recipients.length
          ? el(
              'table',
              {},
              el('thead', {}, el('tr', {}, ...['Number', 'Name', 'Status', 'Detail'].map((h) => el('th', { text: h })))),
              el(
                'tbody',
                {},
                ...data.recipients.map((r) =>
                  el(
                    'tr',
                    {},
                    el('td', { class: 'mono small', text: `+${r.phone}` }),
                    el('td', { text: r.name || '' }),
                    el('td', {}, el('span', { class: `mini-tag r-${r.status}`, text: r.status })),
                    el('td', { class: 'small muted', text: r.error || (r.sent_at ? formatDate(r.sent_at) : '') })
                  )
                )
              )
            )
          : emptyState('Nobody in this list.')
      );
    } catch (err) {
      toast(err.message);
    }
  };
  filter.addEventListener('change', fill);
  openDialog({ title: `Recipients: ${c.name}`, wide: true, body: el('div', {}, field('Show', filter), el('div', { class: 'table-wrap' }, list)), actions: [] });
  fill();
}

let timer;
export function initCampaigns() {
  on('live:campaign', () => {
    if (!local.active) return;
    clearTimeout(timer);
    timer = setTimeout(load, 400);
  });
}

export function showCampaigns() {
  local.active = true;
  load();
}

export function hideCampaigns() {
  local.active = false;
}
