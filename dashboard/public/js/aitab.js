// AI tab: what needs attention, daily digest, follow-ups, agent settings, knowledge, tester, media library.
import {
  $, api, el, toast, withBusy, field, emit, on, relativeTime, formatBytes, readFileAsBase64,
  aiFlagTag, scoreMeter, stageBadge, confirmDialog, emptyState,
} from './core.js';

const local = { overview: null, settings: null, library: [], active: false, digestHours: 24 };

const MODES = [
  ['off', 'Off', 'The AI never writes to customers. Summaries and writing help still work.'],
  ['suggest', 'Suggest', 'The AI drafts a reply for every message no rule answered. You approve, edit or discard it in the inbox.'],
  ['auto', 'Auto-pilot', 'The AI answers on its own when it is confident, hands off to you when it is not, and drafts the rest.'],
];
const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'], url: 'https://api.anthropic.com' },
  openai: { label: 'OpenAI or compatible (OpenRouter, Groq, Ollama...)', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'], url: 'https://api.openai.com/v1' },
};
const EVENT_LABELS = {
  replied: 'Replied',
  drafted: 'Drafted',
  approved: 'Draft sent',
  handoff: 'Handed off',
  no_reply: 'Stayed quiet',
  stage: 'Stage',
  error: 'Error',
  digest: 'Digest',
};

async function load() {
  try {
    const [overview, settings, library] = await Promise.all([api('/ai/overview'), api('/settings'), api('/library')]);
    local.overview = overview;
    local.settings = settings.settings.ai;
    local.library = library.items;
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function refreshOverview() {
  try {
    local.overview = await api('/ai/overview');
    renderDynamic();
  } catch {
    /* keep the last view */
  }
}

// ---------- Static layout (settings forms are not rebuilt on live updates) ----------
function render() {
  const view = $('view-ai');
  view.replaceChildren(
    el('div', { id: 'ai-banner' }),
    el('div', { class: 'stats', id: 'ai-stats' }),
    el(
      'div',
      { class: 'grid' },
      el('section', { class: 'card', id: 'ai-attention' }),
      el('section', { class: 'card', id: 'ai-digest' }),
      el('section', { class: 'card', id: 'ai-quiet' }),
      el('section', { class: 'card', id: 'ai-activity' }),
      settingsCard(),
      testerCard(),
      libraryCard()
    )
  );
  renderDynamic();
}

function renderDynamic() {
  const o = local.overview;
  if (!o || !$('ai-stats')) return;

  $('ai-banner').replaceChildren(
    !o.configured
      ? el('div', { class: 'banner banner-warn', text: 'AI is not set up yet. Choose a provider and add an API key in "AI agent" below to turn on summaries, drafts and auto-replies.' })
      : o.mode === 'off'
        ? el('div', { class: 'banner banner-info', text: 'The agent is off: it will not reply or draft. Chat summaries and writing help in the inbox still work. Switch the mode below to Suggest or Auto-pilot.' })
        : ''
  );

  const modeLabel = (MODES.find((m) => m[0] === o.mode) || MODES[0])[1];
  const stat = (label, value, note, cls = '') =>
    el('div', { class: `stat ${cls}` }, el('span', { class: 'stat-label', text: label }), el('strong', { text: String(value) }), note ? el('span', { class: 'stat-note', text: note }) : null);
  $('ai-stats').replaceChildren(
    stat('Agent', modeLabel, o.configured ? 'AI connected' : 'No API key', o.mode === 'off' ? 'stat-muted' : 'stat-accent'),
    stat('AI replies', o.stats.aiReplies, 'last 24 hours'),
    stat('Drafts waiting', o.stats.drafts, 'need your approval', o.stats.drafts ? 'stat-warn' : ''),
    stat('Hand-offs', o.stats.handoffs, 'last 24 hours', o.stats.handoffs ? 'stat-warn' : ''),
    stat('Hot leads', o.stats.hotLeads, 'score 70+ or flagged'),
    stat('Need attention', o.attention.length, 'chats', o.attention.length ? 'stat-warn' : '')
  );

  // Needs attention
  $('ai-attention').replaceChildren(
    el('div', { class: 'card-head' }, el('h2', { text: 'Needs attention' }), el('span', { class: 'muted small', text: 'Hand-offs, unhappy customers, hot leads, drafts and unanswered chats' })),
    o.attention.length
      ? el(
          'ul',
          { class: 'ai-list' },
          ...o.attention.map((c) =>
            el(
              'li',
              {},
              el(
                'button',
                { type: 'button', class: 'ai-row', onclick: () => emit('open-chat', c.chatId) },
                el(
                  'span',
                  { class: 'ai-row-main' },
                  el('span', { class: 'ai-row-top' }, el('strong', { text: c.displayName }), aiFlagTag(c.ai.flag), stageBadge(c.stage)),
                  el('span', { class: 'muted small clamp', text: c.ai.intent || c.lastMessage || '' }),
                  el('span', { class: 'chips' }, ...c.reasons.map((r) => el('span', { class: 'chip', text: r })))
                ),
                el('span', { class: 'ai-row-side' }, scoreMeter(c.ai.score), el('span', { class: 'muted small', text: relativeTime(c.lastMessageAt) }))
              )
            )
          )
        )
      : emptyState('All clear. Nothing is waiting for you.')
  );

  renderDigest();

  // Gone quiet
  $('ai-quiet').replaceChildren(
    el('div', { class: 'card-head' }, el('h2', { text: 'Gone quiet: follow up' }), el('span', { class: 'muted small', text: 'Leads in the pipeline with no messages for 2 to 21 days' })),
    o.quiet.length
      ? el(
          'ul',
          { class: 'ai-list' },
          ...o.quiet.map((c) =>
            el(
              'li',
              { class: 'ai-row static' },
              el(
                'span',
                { class: 'ai-row-main' },
                el('span', { class: 'ai-row-top' }, el('strong', { text: c.displayName }), stageBadge(c.stage)),
                el('span', { class: 'muted small clamp', text: c.ai.intent || c.lastMessage || '' })
              ),
              el(
                'span',
                { class: 'ai-row-side' },
                scoreMeter(c.ai.score),
                el('span', { class: 'muted small', text: `${relativeTime(c.lastMessageAt)} ago` }),
                o.configured
                  ? el('button', { type: 'button', class: 'btn small ai-btn', text: '✨ Draft follow-up', onclick: () => emit('open-chat-followup', c.chatId) })
                  : null
              )
            )
          )
        )
      : emptyState('No quiet leads right now.')
  );

  // Activity
  $('ai-activity').replaceChildren(
    el('div', { class: 'card-head' }, el('h2', { text: 'AI activity' }), el('span', { class: 'muted small', text: 'Every decision the agent made' })),
    o.events.length
      ? el(
          'ul',
          { class: 'activity' },
          ...o.events.map((e) =>
            el(
              'li',
              {},
              el('span', { class: `act act-${e.action}`, text: EVENT_LABELS[e.action] || e.action }),
              el(
                'span',
                { class: 'act-main' },
                e.chatId
                  ? el('button', { type: 'button', class: 'link', text: e.who ? (/^\d+$/.test(e.who) ? `+${e.who}` : e.who) : 'Chat', onclick: () => emit('open-chat', e.chatId) })
                  : null,
                el('span', { class: 'muted small', text: e.detail || '' })
              ),
              el('span', { class: 'muted small nowrap', text: relativeTime(e.createdAt) })
            )
          )
        )
      : emptyState('Nothing yet. Decisions appear here as the agent works.')
  );
}

function renderDigest() {
  const o = local.overview;
  const d = o.digest;
  const hours = el(
    'select',
    { 'aria-label': 'Period', class: 'auto-width', onchange: (e) => { local.digestHours = Number(e.target.value); } },
    ...[[24, 'Last 24 hours'], [72, 'Last 3 days'], [168, 'Last 7 days']].map(([h, l]) => el('option', { value: String(h), text: l, selected: h === local.digestHours }))
  );
  const btn = el('button', { type: 'button', class: 'btn primary small', text: d ? 'Regenerate' : 'Generate', disabled: !o.configured });
  btn.addEventListener('click', async () => {
    const res = await withBusy(btn, 'Reading chats...', () => api('/ai/digest', { method: 'POST', body: { hours: local.digestHours } }));
    if (res) {
      local.overview.digest = res.digest;
      renderDigest();
    }
  });

  const people = (title, list) =>
    list && list.length
      ? el(
          'div',
          { class: 'digest-block' },
          el('span', { class: 'field-label', text: title }),
          el('ul', {}, ...list.map((p) => el('li', {}, el('button', { type: 'button', class: 'link', text: p.name || 'Chat', onclick: () => emit('open-chat', p.chatId) }), ` ${p.why}`)))
        )
      : null;
  const bullets = (title, list) =>
    list && list.length ? el('div', { class: 'digest-block' }, el('span', { class: 'field-label', text: title }), el('ul', {}, ...list.map((x) => el('li', { text: x })))) : null;

  $('ai-digest').replaceChildren(
    el('div', { class: 'card-head' }, el('h2', { text: 'Inbox digest' }), el('div', { class: 'row tight' }, hours, btn)),
    d
      ? el(
          'div',
          { class: 'digest' },
          el('p', { class: 'digest-headline', text: d.headline }),
          el('p', { class: 'muted small', text: `${d.chats} chats, last ${d.hours} hours, generated ${relativeTime(d.generatedAt)} ago` }),
          bullets('Highlights', d.highlights),
          people('Hot leads', d.hotLeads),
          people('Needs attention', d.needsAttention),
          bullets('Common questions', d.questions),
          bullets('Suggestions', d.suggestions)
        )
      : emptyState('The AI reads every recent conversation and tells you what happened, who is ready to buy and what needs you.')
  );
}

// ---------- Agent settings ----------
function settingsCard() {
  const s = local.settings;
  const o = local.overview;

  let mode = s.mode;
  const modeHint = el('p', { class: 'hint' });
  const modeButtons = MODES.map(([value, label]) =>
    el('button', {
      type: 'button',
      class: value === mode ? 'active' : '',
      text: label,
      onclick: (e) => {
        mode = value;
        for (const b of e.currentTarget.parentElement.children) b.classList.toggle('active', b === e.currentTarget);
        modeHint.textContent = MODES.find((m) => m[0] === mode)[2];
      },
    })
  );
  modeHint.textContent = MODES.find((m) => m[0] === mode)[2];

  const provider = el('select', {}, ...Object.entries(PROVIDERS).map(([k, p]) => el('option', { value: k, text: p.label, selected: k === s.provider })));
  const modelList = el('datalist', { id: 'ai-models' });
  const model = el('input', { type: 'text', list: 'ai-models', value: s.model, maxlength: '100' });
  const fastModel = el('input', { type: 'text', list: 'ai-models', value: s.fastModel, maxlength: '100' });
  const baseUrl = el('input', { type: 'url', value: s.baseUrl, maxlength: '300' });
  const fillModels = () => {
    const p = PROVIDERS[provider.value];
    modelList.replaceChildren(...p.models.map((m) => el('option', { value: m })));
    baseUrl.placeholder = p.url;
  };
  provider.addEventListener('change', () => {
    const p = PROVIDERS[provider.value];
    model.value = p.models[0];
    fastModel.value = p.models[1] || p.models[0];
    fillModels();
  });
  fillModels();

  const keyInput = el('input', { type: 'password', autocomplete: 'off', placeholder: o.keySource ? '•••••••• (saved)' : 'Paste your API key', maxlength: '400' });
  const keyStatus = el('span', { class: 'muted small' });
  const setKeyStatus = (source) => {
    keyStatus.textContent =
      source === 'env' ? 'Using AI_API_KEY from the server environment.' : source === 'dashboard' ? 'A key is saved on the server. It is never shown again.' : 'No key saved yet.';
  };
  setKeyStatus(o.keySource);
  const saveKey = el('button', { type: 'button', class: 'btn small', text: 'Save key' });
  saveKey.addEventListener('click', async () => {
    if (!keyInput.value.trim()) return toast('Paste a key first.');
    const res = await withBusy(saveKey, 'Saving...', () => api('/ai/key', { method: 'PUT', body: { apiKey: keyInput.value.trim() } }));
    if (res) {
      keyInput.value = '';
      keyInput.placeholder = '•••••••• (saved)';
      setKeyStatus(res.keySource);
      toast('API key saved.', 'success', 2500);
      refreshOverview();
    }
    return undefined;
  });
  const removeKey = el('button', { type: 'button', class: 'btn small ghost', text: 'Remove' });
  removeKey.addEventListener('click', async () => {
    const res = await withBusy(removeKey, '...', () => api('/ai/key', { method: 'DELETE' }));
    if (res) {
      keyInput.placeholder = 'Paste your API key';
      setKeyStatus(res.keySource);
      refreshOverview();
    }
  });

  const businessName = el('input', { type: 'text', value: s.businessName, maxlength: '100', placeholder: 'e.g. Sharma Furniture' });
  const instructions = el('textarea', { rows: '5', maxlength: '4000', value: s.instructions });
  const knowledge = el('textarea', {
    rows: '12',
    maxlength: '30000',
    value: s.knowledge,
    class: 'knowledge',
    placeholder:
      'Everything the AI may tell customers. For example:\n\nProducts and prices:\n- Sofa set 3+1+1: Rs 45,000 (fabric), Rs 62,000 (leather)\n\nDelivery: free within Pune, 5-7 days. Outside Pune Rs 1,500.\nPayment: UPI, card, cash on delivery. 50% advance on custom orders.\nShowroom: 12 MG Road, open 10am-8pm, closed Tuesday.\nReturns: 7 days for damaged items.\n\nFAQ:\nQ: Do you do custom sizes? A: Yes, takes 3 weeks.',
  });
  const knowledgeCount = el('span', { class: 'muted small' });
  const countKnowledge = () => { knowledgeCount.textContent = `${knowledge.value.length.toLocaleString()} / 30,000 characters`; };
  knowledge.addEventListener('input', countKnowledge);
  countKnowledge();

  const schedule = el(
    'select',
    {},
    ...[['always', 'Any time'], ['business_hours', 'Only during business hours'], ['after_hours', 'Only outside business hours']].map(([v, l]) =>
      el('option', { value: v, text: l, selected: v === s.schedule })
    )
  );
  const delay = el('input', { type: 'number', min: '0', max: '120', value: String(s.replyDelaySeconds) });
  const confidence = el('input', { type: 'number', min: '0', max: '100', step: '5', value: String(Math.round((s.minConfidence ?? 0.7) * 100)) });
  const context = el('input', { type: 'number', min: '5', max: '80', value: String(s.contextMessages) });
  const handoff = el('textarea', { rows: '2', maxlength: '1000', value: s.handoffMessage });
  const toggle = (label, checked) => {
    const input = el('input', { type: 'checkbox', class: 'switch', checked });
    return { input, node: el('label', { class: 'check span-all' }, input, el('span', { text: label })) };
  };
  const autoLead = toggle('Let the AI update lead stage, tags and score', s.autoUpdateLead);
  const vision = toggle('Let the AI look at photos customers send', s.vision);
  const autoSummary = toggle('Summarise a chat automatically when I open it', s.autoSummary);

  const save = el('button', { type: 'button', class: 'btn primary', text: 'Save AI settings' });
  save.addEventListener('click', async () => {
    const res = await withBusy(save, 'Saving...', () =>
      api('/settings/ai', {
        method: 'PUT',
        body: {
          mode,
          provider: provider.value,
          model: model.value,
          fastModel: fastModel.value,
          baseUrl: baseUrl.value,
          businessName: businessName.value,
          instructions: instructions.value,
          knowledge: knowledge.value,
          schedule: schedule.value,
          replyDelaySeconds: delay.value,
          minConfidence: Number(confidence.value) / 100,
          contextMessages: context.value,
          handoffMessage: handoff.value,
          autoUpdateLead: autoLead.input.checked,
          vision: vision.input.checked,
          autoSummary: autoSummary.input.checked,
        },
      })
    );
    if (res) {
      local.settings = res.value;
      toast('AI settings saved.', 'success', 2500);
      refreshOverview();
    }
  });

  const writeBtn = el('button', { type: 'button', class: 'btn small ghost', text: '✨ Tidy up with AI', title: 'Rewrite the knowledge into a clear, structured fact sheet' });
  writeBtn.addEventListener('click', async () => {
    if (!knowledge.value.trim()) return toast('Write or paste some business information first.');
    const res = await withBusy(writeBtn, 'Tidying...', () =>
      api('/ai/write-snippet', {
        method: 'POST',
        body: {
          purpose:
            'Reorganise this business information into a clear fact sheet for a sales assistant: sections for products and prices, delivery, payment, location and hours, policies, and FAQ. Keep every fact, add nothing, plain text with dashes, no markdown headings.',
          draft: knowledge.value.slice(0, 4000),
        },
      })
    );
    if (res) {
      knowledge.value = res.text;
      countKnowledge();
      toast('Check the result, then save.', 'info', 3500);
    }
    return undefined;
  });

  return el(
    'section',
    { class: 'card span-2 settings-card', id: 'ai-settings' },
    el('div', { class: 'card-head' }, el('h2', { text: 'AI agent' })),
    el(
      'p',
      { class: 'muted small', text: 'The agent reads every incoming message that no auto-reply rule answered, looks at the whole chat, your knowledge and the lead details, then decides to reply, hand off to you, or stay quiet. Opt-outs, paused chats, human takeover and the hourly auto-reply limit always apply.' }
    ),
    el('div', { class: 'form-grid' },
      el('div', { class: 'span-all' }, el('span', { class: 'field-label', text: 'Mode' }), el('div', { class: 'seg seg-lg', role: 'group', 'aria-label': 'Agent mode' }, ...modeButtons), modeHint),
      el('h3', { class: 'form-section span-all', text: 'Provider' }),
      field('Provider', provider),
      field('API URL (optional)', baseUrl, 'Leave empty for the default. For OpenRouter, Groq or Ollama use their OpenAI-compatible URL.'),
      field('Main model', el('span', {}, model, modelList), 'Used to decide and write replies to customers.'),
      field('Fast model', fastModel, 'Used for summaries and rewrites. Can be the same.'),
      el('div', { class: 'span-all' },
        el('span', { class: 'field-label', text: 'API key' }),
        el('div', { class: 'row tight' }, keyInput, saveKey, o.keySource === 'dashboard' ? removeKey : null),
        keyStatus
      ),
      el('h3', { class: 'form-section span-all', text: 'What the AI knows' }),
      field('Business name', businessName),
      field('When may it reply on its own', schedule, 'Outside this window it only drafts, and your away message goes out as usual.'),
      el('div', { class: 'span-all' }, field('Instructions and tone', instructions, 'How the assistant should behave. Example: "Always ask for the city before quoting delivery."')),
      el('div', { class: 'span-all' },
        el('div', { class: 'row tight between' }, el('span', { class: 'field-label', text: 'Business knowledge' }), writeBtn),
        knowledge,
        knowledgeCount,
        el('p', { class: 'hint', text: 'Products, prices, delivery, payment, address, hours, policies and FAQ. The AI only promises what is written here. Files in the media library below can be sent by the AI too.' })
      ),
      el('h3', { class: 'form-section span-all', text: 'Behaviour' }),
      field('Wait before answering (seconds)', delay, 'Lets the customer finish a burst of messages so the AI answers once.'),
      field('Auto-send only when at least this sure (%)', confidence, 'Below this, Auto-pilot saves a draft for you instead.'),
      el('div', { class: 'span-all' }, field('Hand-off message', handoff, 'Sent (or drafted) when the AI passes a chat to a person. The bot then stays paused in that chat.')),
      field('Messages of history the AI reads', context),
      el('span', {}),
      autoLead.node,
      vision.node,
      autoSummary.node
    ),
    el('div', { class: 'card-foot' }, save)
  );
}

// ---------- Tester ----------
function testerCard() {
  const input = el('textarea', { rows: '3', maxlength: '1000', placeholder: 'e.g. Hi, how much is the 3 seater sofa and can you deliver to Mumbai?' });
  const out = el('div', { class: 'test-result', hidden: true });
  const btn = el('button', { type: 'button', class: 'btn primary', text: 'Ask the agent' });
  btn.addEventListener('click', async () => {
    if (!input.value.trim()) return;
    const res = await withBusy(btn, 'Thinking...', () => api('/ai/test', { method: 'POST', body: { message: input.value } }));
    if (!res) return;
    const d = res.decision;
    const files = d.attachments.map((id) => local.library.find((f) => f.id === id)).filter(Boolean);
    out.hidden = false;
    out.replaceChildren(
      el('div', { class: 'row tight' },
        el('span', { class: `act act-${d.action === 'reply' ? 'replied' : d.action}`, text: { reply: 'Would reply', handoff: 'Would hand off', no_reply: 'Would stay quiet' }[d.action] }),
        el('span', { class: 'muted small', text: `${Math.round(d.confidence * 100)}% sure` }),
        aiFlagTag(d.flag)
      ),
      d.reply ? el('div', { class: 'wa-preview slim' }, el('p', { class: 'bubble out ai', text: d.reply })) : null,
      files.length ? el('div', { class: 'chips' }, ...files.map((f) => el('span', { class: 'chip', text: `📎 ${f.title}` }))) : null,
      d.reason ? el('p', { class: 'muted small', text: `Why: ${d.reason}` }) : null,
      el('p', { class: 'muted small', text: `Lead: score ${d.lead.score ?? '-'}, ${d.lead.intent || 'no intent'}, ${d.lead.sentiment || ''}${d.lead.stage ? `, stage ${d.lead.stage}` : ''}` })
    );
  });
  return el(
    'section',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Try the agent' })),
    el('p', { class: 'muted small', text: 'Type a message as if you were a customer. Uses your saved settings and knowledge; nothing is sent.' }),
    input,
    el('div', { class: 'card-foot' }, btn),
    out
  );
}

// ---------- Media library ----------
function libraryCard() {
  const card = el('section', { class: 'card', id: 'ai-library' });
  const renderLib = () => {
    const fileInput = el('input', { type: 'file' });
    const title = el('input', { type: 'text', maxlength: '80', placeholder: 'e.g. Catalogue 2026' });
    const desc = el('input', { type: 'text', maxlength: '500', placeholder: 'When to send it, e.g. "full product list with prices"' });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f && !title.value) title.value = f.name.replace(/\.[^.]+$/, '').slice(0, 80);
    });
    const upload = el('button', { type: 'button', class: 'btn primary small', text: 'Upload' });
    upload.addEventListener('click', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return toast('Choose a file first.');
      const res = await withBusy(upload, 'Uploading...', async () => {
        const read = await readFileAsBase64(f);
        return api('/library', { method: 'POST', body: { ...read, title: title.value || f.name, description: desc.value } });
      });
      if (res) {
        local.library.push(res.item);
        local.library.sort((a, b) => a.title.localeCompare(b.title));
        emit('library');
        renderLib();
        toast('File added to the library.', 'success', 2500);
      }
      return undefined;
    });
    card.replaceChildren(
      el('div', { class: 'card-head' }, el('h2', { text: 'Media library' })),
      el('p', { class: 'muted small', text: 'Catalogues, price lists, menus, photos. Send them from the inbox in one click, and the AI sends them when a customer asks.' }),
      local.library.length
        ? el(
            'ul',
            { class: 'saved-list' },
            ...local.library.map((f) =>
              el(
                'li',
                {},
                el('div', {},
                  el('a', { href: f.url, target: '_blank', rel: 'noopener', class: 'strong-link', text: f.title }),
                  el('p', { class: 'muted small', text: `${f.filename} · ${formatBytes(f.size)}${f.description ? ` · ${f.description}` : ''}` })
                ),
                el('button', {
                  type: 'button',
                  class: 'btn small ghost danger-text',
                  text: 'Delete',
                  onclick: async () => {
                    if (!(await confirmDialog('Delete file', `Delete "${f.title}" from the library?`, { confirmLabel: 'Delete', danger: true }))) return;
                    try {
                      await api(`/library/${f.id}`, { method: 'DELETE' });
                      local.library = local.library.filter((x) => x.id !== f.id);
                      emit('library');
                      renderLib();
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                })
              )
            )
          )
        : emptyState('No files yet.'),
      el('h3', { class: 'form-section', text: 'Add a file' }),
      field('File (max 16 MB)', fileInput),
      field('Title', title),
      field('Description for the AI', desc),
      el('div', { class: 'card-foot' }, upload)
    );
  };
  renderLib();
  return card;
}

// ---------- Tab lifecycle ----------
let timer = null;
export function initAi() {
  on('live:ai', () => {
    if (!local.active) return;
    clearTimeout(timer);
    timer = setTimeout(refreshOverview, 500);
  });
  on('live:contact', () => {
    if (!local.active) return;
    clearTimeout(timer);
    timer = setTimeout(refreshOverview, 1000);
  });
}

export function showAi() {
  local.active = true;
  load();
}

export function hideAi() {
  local.active = false;
}
