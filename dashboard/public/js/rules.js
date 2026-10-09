// Auto-replies tab: keyword rules, rule tester, starter templates, saved replies.
import {
  $, api, el, toast, withBusy, emit, state, openDialog, confirmDialog, field, emptyState,
  STAGES, STAGE_LABELS, tagChips, sessionLabel,
} from './core.js';

const MATCH_LABELS = {
  contains: 'Message contains',
  exact: 'Message is exactly',
  starts_with: 'Message starts with',
  regex: 'Matches regex',
  any: 'Any message',
};
const SCHEDULE_LABELS = { always: 'Always', business_hours: 'During business hours', after_hours: 'Outside business hours' };

// Starter rules for a sales number. Created disabled-free but easy to edit or delete.
const STARTER_RULES = [
  {
    name: 'Pricing enquiry',
    matchType: 'contains',
    pattern: 'price, pricing, cost, rate, charges, how much, quotation, quote',
    reply: 'Hi {{first_name}}! Thanks for asking about pricing. Could you tell us what you are looking for and the quantity you need? We will share the best quote right away.',
    addTags: ['pricing'],
    setStage: 'contacted',
    priority: 20,
  },
  {
    name: 'Catalogue request',
    matchType: 'contains',
    pattern: 'catalog, catalogue, brochure, products, menu, details',
    reply: 'Here is what we offer, {{first_name}}: [add your catalogue link here]. Tell us which item interests you and we will send full details.',
    addTags: ['catalogue'],
    priority: 30,
  },
  {
    name: 'Location and hours',
    matchType: 'contains',
    pattern: 'address, location, where are you, timing, open, hours',
    reply: 'We are at [your address]. Open Monday to Saturday, 9 AM to 7 PM. Map: [your Google Maps link]',
    priority: 40,
  },
  {
    name: 'Talk to a person',
    matchType: 'contains',
    pattern: 'agent, human, person, call me, callback, talk to someone, speak to',
    reply: 'Sure {{first_name}}, a team member will reply to you here shortly.',
    addTags: ['needs-human'],
    setStage: 'qualified',
    pauseBot: true,
    priority: 10,
  },
  {
    name: 'Ready to buy',
    matchType: 'contains',
    pattern: 'buy, order, book, purchase, interested, want to',
    reply: 'Great to hear, {{first_name}}! Please share your name, city and what you would like to order, and we will confirm it for you.',
    addTags: ['hot'],
    setStage: 'qualified',
    priority: 15,
  },
];

const local = { rules: [], saved: [], active: false };

async function load() {
  try {
    const [rules, saved] = await Promise.all([api('/rules'), api('/saved-replies')]);
    local.rules = rules.items;
    local.saved = saved.items;
    render();
  } catch (err) {
    toast(err.message);
  }
}

function describeTrigger(r) {
  if (r.matchType === 'any') return 'Any message';
  return `${MATCH_LABELS[r.matchType]}: ${r.pattern}`;
}

function ruleRow(r) {
  const toggle = el('input', {
    type: 'checkbox',
    class: 'switch',
    checked: r.enabled,
    'aria-label': `Enable ${r.name}`,
    onchange: async (e) => {
      try {
        await api(`/rules/${r.id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
        r.enabled = e.target.checked;
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(err.message);
      }
    },
  });

  const actions = [];
  if (r.setStage) actions.push(el('span', { class: 'mini-tag', text: `Stage: ${STAGE_LABELS[r.setStage]}` }));
  if (r.pauseBot) actions.push(el('span', { class: 'mini-tag warn', text: 'Hands off to human' }));

  return el(
    'tr',
    { class: r.enabled ? '' : 'row-muted' },
    el('td', {}, toggle),
    el('td', { class: 'mono small', text: String(r.priority) }),
    el(
      'td',
      {},
      el('div', { class: 'session-name', text: r.name }),
      el('div', { class: 'muted small clamp', text: describeTrigger(r) })
    ),
    el('td', { class: 'reply-preview' }, el('div', { class: 'small clamp', text: r.reply })),
    el('td', {}, tagChips(r.addTags), ...actions),
    el('td', { class: 'small muted', text: SCHEDULE_LABELS[r.schedule] }),
    el('td', { class: 'mono small', text: String(r.hits) }),
    el(
      'td',
      { class: 'actions' },
      el('button', { type: 'button', class: 'btn small ghost', text: 'Edit', onclick: () => openEditor(r) }),
      el('button', { type: 'button', class: 'btn small ghost danger-text', text: 'Delete', onclick: () => removeRule(r) })
    )
  );
}

function tester() {
  const input = el('input', { type: 'text', placeholder: 'Type a message a customer might send', maxlength: '1000' });
  const out = el('p', { class: 'muted small', text: 'Shows which rule would answer right now, based on priority and business hours.' });
  const btn = el('button', { type: 'submit', class: 'btn' , text: 'Test' });
  const form = el('form', { class: 'row tester', novalidate: true }, el('label', { class: 'field grow' }, el('span', { text: 'Try a message' }), input), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    const res = await withBusy(btn, 'Testing...', () => api('/rules/test', { method: 'POST', body: { text: input.value } }));
    if (!res) return;
    out.className = 'test-result';
    out.replaceChildren(
      res.rule
        ? el('span', {}, 'Matched ', el('strong', { text: res.rule.name }), '. Reply: ', el('em', { text: res.rule.reply }))
        : el('span', { text: `No rule matches. ${res.open ? 'The welcome message goes to brand new contacts only.' : 'Outside business hours, the away message is sent if enabled.'}` })
    );
  });
  return el('div', {}, form, out);
}

function render() {
  const view = $('view-automation');
  const rulesTable = local.rules.length
    ? el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, ...['On', 'Priority', 'Rule', 'Reply', 'Actions', 'When', 'Hits', ''].map((h) => el('th', { text: h })))),
          el('tbody', {}, ...local.rules.map(ruleRow))
        )
      )
    : el(
        'div',
        { class: 'empty-cta' },
        el('p', { text: 'No auto-reply rules yet.' }),
        el('button', { type: 'button', class: 'btn primary', text: 'Add starter sales rules', onclick: (e) => addStarters(e.currentTarget) })
      );

  const savedList = local.saved.length
    ? el(
        'ul',
        { class: 'saved-list' },
        ...local.saved.map((s) =>
          el(
            'li',
            {},
            el('div', {}, el('strong', { text: s.title }), el('p', { class: 'muted small clamp', text: s.body })),
            el('button', { type: 'button', class: 'btn small ghost danger-text', text: 'Delete', onclick: () => removeSaved(s) })
          )
        )
      )
    : emptyState('No saved replies yet. They appear as one-click answers in the inbox.');

  const savedTitle = el('input', { type: 'text', maxlength: '60', placeholder: 'e.g. Bank details' });
  const savedBody = el('textarea', { rows: '3', maxlength: '4096', placeholder: 'Reply text. You can use {{name}} and {{first_name}}.' });
  const savedBtn = el('button', { type: 'submit', class: 'btn', text: 'Add saved reply' });
  const savedForm = el('form', { class: 'saved-form', novalidate: true }, field('Title', savedTitle), field('Text', savedBody), savedBtn);
  savedForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await withBusy(savedBtn, 'Saving...', () => api('/saved-replies', { method: 'POST', body: { title: savedTitle.value, body: savedBody.value } }));
    if (res) {
      toast('Saved reply added.', 'success', 2500);
      emit('saved-replies');
      load();
    }
  });

  view.replaceChildren(
    el(
      'div',
      { class: 'grid' },
      el(
        'section',
        { class: 'card span-2' },
        el(
          'div',
          { class: 'card-head' },
          el('h2', { text: 'Auto-reply rules' }),
          el('div', { class: 'row tight' },
            local.rules.length ? el('button', { type: 'button', class: 'btn ghost', text: 'Add starter rules', onclick: (e) => addStarters(e.currentTarget) }) : null,
            el('button', { type: 'button', class: 'btn primary', text: 'New rule', onclick: () => openEditor() }))
        ),
        el(
          'ol',
          { class: 'flow' },
          el('li', { text: 'STOP / START keywords are handled first.' }),
          el('li', { text: 'Opted-out contacts and chats with the bot paused get no auto-replies.' }),
          el('li', { text: 'The first matching rule (lowest priority number) replies.' }),
          el('li', { text: 'No match: brand new contacts get the welcome message; outside business hours the away message is sent.' })
        ),
        rulesTable,
        tester()
      ),
      el('section', { class: 'card span-2' }, el('div', { class: 'card-head' }, el('h2', { text: 'Saved replies' })), el('div', { class: 'saved-grid' }, savedList, savedForm))
    )
  );
}

function openEditor(r = null) {
  const name = el('input', { type: 'text', maxlength: '80', value: r ? r.name : '', placeholder: 'e.g. Pricing enquiry' });
  const matchType = el('select', {}, ...Object.entries(MATCH_LABELS).map(([k, label]) => el('option', { value: k, text: label, selected: r ? r.matchType === k : k === 'contains' })));
  const pattern = el('input', { type: 'text', maxlength: '500', value: r ? r.pattern : '', placeholder: 'price, cost, rate' });
  const patternField = field('Keywords', pattern, 'Separate alternatives with commas. Not case sensitive.');
  const reply = el('textarea', { rows: '4', maxlength: '4096', value: r ? r.reply : '', placeholder: 'Hi {{first_name}}! ...' });
  const schedule = el('select', {}, ...Object.entries(SCHEDULE_LABELS).map(([k, label]) => el('option', { value: k, text: label, selected: r ? r.schedule === k : k === 'always' })));
  const priority = el('input', { type: 'number', min: '0', max: '10000', value: String(r ? r.priority : 100) });
  const cooldown = el('input', { type: 'number', min: '0', max: '43200', value: String(r ? r.cooldownMinutes : 60) });
  const tags = el('input', { type: 'text', value: r ? r.addTags.join(', ') : '', placeholder: 'pricing, hot' });
  const stage = el('select', {}, el('option', { value: '', text: 'Do not change' }), ...STAGES.map((s) => el('option', { value: s, text: STAGE_LABELS[s], selected: r ? r.setStage === s : false })));
  const pauseBot = el('input', { type: 'checkbox', checked: r ? r.pauseBot : false });
  const session = el('select', {}, el('option', { value: '', text: 'All sessions' }), ...state.sessions.map((s) => el('option', { value: s.id, text: sessionLabel(s), selected: r ? r.sessionId === s.id : false })));

  const syncPattern = () => {
    patternField.hidden = matchType.value === 'any';
    patternField.querySelector('span').textContent = matchType.value === 'regex' ? 'Regular expression' : 'Keywords';
    pattern.placeholder = matchType.value === 'regex' ? '^(hi|hello)\\b' : 'price, cost, rate';
  };
  matchType.addEventListener('change', syncPattern);
  syncPattern();

  openDialog({
    title: r ? 'Edit rule' : 'New rule',
    wide: true,
    body: el(
      'div',
      { class: 'form-grid' },
      field('Rule name', name),
      field('Trigger', matchType),
      el('div', { class: 'span-all' }, patternField),
      el('div', { class: 'span-all' }, field('Reply', reply, 'Variables: {{name}}, {{first_name}}, {{phone}}')),
      field('When', schedule),
      field('Session', session),
      field('Priority', priority, 'Lower runs first'),
      field('Cooldown (minutes)', cooldown, 'Do not repeat this reply to the same person within this time'),
      field('Add tags', tags, 'Comma separated'),
      field('Set stage', stage),
      el('label', { class: 'check span-all' }, pauseBot, el('span', { text: 'Hand off to a human: pause the bot for this chat after replying' }))
    ),
    actions: [
      {
        label: r ? 'Save rule' : 'Create rule',
        primary: true,
        onClick: async (close, btn) => {
          const body = {
            name: name.value,
            matchType: matchType.value,
            pattern: pattern.value,
            reply: reply.value,
            schedule: schedule.value,
            sessionId: session.value || null,
            priority: priority.value,
            cooldownMinutes: cooldown.value,
            addTags: tags.value,
            setStage: stage.value || null,
            pauseBot: pauseBot.checked,
            enabled: r ? r.enabled : true,
          };
          const res = await withBusy(btn, 'Saving...', () => (r ? api(`/rules/${r.id}`, { method: 'PATCH', body }) : api('/rules', { method: 'POST', body })));
          if (res) {
            close();
            toast(r ? 'Rule saved.' : 'Rule created.', 'success', 2500);
            load();
          }
        },
      },
    ],
  });
}

async function addStarters(btn) {
  const existing = new Set(local.rules.map((r) => r.name));
  const toAdd = STARTER_RULES.filter((r) => !existing.has(r.name));
  if (!toAdd.length) return toast('Starter rules are already added.', 'info');
  await withBusy(btn, 'Adding...', async () => {
    for (const rule of toAdd) await api('/rules', { method: 'POST', body: { ...rule, enabled: true, schedule: 'always', cooldownMinutes: 60 } });
    toast(`Added ${toAdd.length} starter rules. Edit the replies to add your own links and address.`, 'success', 7000);
  });
  load();
}

async function removeRule(r) {
  if (!(await confirmDialog('Delete rule', `Delete the rule "${r.name}"?`, { confirmLabel: 'Delete', danger: true }))) return;
  try {
    await api(`/rules/${r.id}`, { method: 'DELETE' });
    load();
  } catch (err) {
    toast(err.message);
  }
}

async function removeSaved(s) {
  if (!(await confirmDialog('Delete saved reply', `Delete "${s.title}"?`, { confirmLabel: 'Delete', danger: true }))) return;
  try {
    await api(`/saved-replies/${s.id}`, { method: 'DELETE' });
    emit('saved-replies');
    load();
  } catch (err) {
    toast(err.message);
  }
}

export function showRules() {
  local.active = true;
  load();
}

export function hideRules() {
  local.active = false;
}
