'use strict';

// Minimal client for the AI model. Supports Anthropic (Claude) and any OpenAI-compatible
// chat completions API (OpenAI, OpenRouter, Groq, Together, a local Ollama, ...).
const store = require('./db');

class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_BASE = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai', // Gemini's OpenAI-compatible endpoint
};

// The key comes from the AI_API_KEY environment variable, or is saved from the dashboard.
// It is never sent to the browser.
function apiKey() {
  if (process.env.AI_API_KEY) return { key: process.env.AI_API_KEY, source: 'env' };
  const saved = store.getSetting('aiSecret');
  if (saved && typeof saved.key === 'string' && saved.key) return { key: saved.key, source: 'dashboard' };
  return { key: '', source: null };
}

function isConfigured() {
  const s = store.getSetting('ai');
  // A local OpenAI-compatible server (Ollama, LM Studio) can work without a key.
  return Boolean(apiKey().key || (s.provider === 'openai' && s.baseUrl));
}

/**
 * complete({ system, text, images: [{ mime, data(base64) }], maxTokens, fast })
 * Returns the model's text answer.
 */
async function complete({ system, text, images = [], maxTokens = 800, fast = false, temperature = 0.4 }) {
  const s = store.getSetting('ai');
  const { key } = apiKey();
  if (!isConfigured()) throw new AiError('AI is not set up yet. Add an API key in the AI tab.', 400);
  // A fast model left over from another provider (e.g. claude-haiku while using Gemini) is ignored.
  const family = { anthropic: /^claude/i, gemini: /^(models\/)?gemini/i }[s.provider];
  const fastOk = s.fastModel && (!family || family.test(s.fastModel));
  const model = (fast && fastOk && s.fastModel) || s.model;
  if (!model) throw new AiError('Choose an AI model in the AI tab.', 400);
  const base = (s.baseUrl || DEFAULT_BASE[s.provider] || DEFAULT_BASE.openai).replace(/\/+$/, '');

  let url;
  let headers;
  let body;
  if (s.provider === 'anthropic') {
    url = `${base}/v1/messages`;
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    body = {
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [
        {
          role: 'user',
          content: [
            ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })),
            { type: 'text', text },
          ],
        },
      ],
    };
  } else {
    url = `${base}/chat/completions`;
    headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    body = {
      model,
      // Gemini models think before answering and that counts against the output budget, so allow more room.
      max_tokens: s.provider === 'gemini' ? maxTokens + 4000 : maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: images.length
            ? [
                ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })),
                { type: 'text', text },
              ]
            : text,
        },
      ],
    };
    if (s.provider === 'gemini') body.reasoning_effort = 'low'; // fast, cheap answers; enough for chat replies
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  } catch (err) {
    throw new AiError(err.name === 'TimeoutError' ? 'The AI provider took too long to answer.' : 'Cannot reach the AI provider.', 502);
  }
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    // Gemini returns errors as [{ error: {...} }], the others as { error: {...} }.
    const errObj = Array.isArray(data) ? data[0] && data[0].error : data && data.error;
    const detail = (errObj && (errObj.message || (typeof errObj === 'string' ? errObj : ''))) || raw.slice(0, 200) || `HTTP ${res.status}`;
    console.warn(`[ai] ${s.provider} ${model} -> HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) throw new AiError(`The AI provider rejected the API key: ${String(detail).slice(0, 200)}`, 502);
    if (res.status === 404) throw new AiError(`Model "${model}" was not found at ${s.provider}. Check the model names in the Assistant tab. (${String(detail).slice(0, 150)})`, 502);
    if (res.status === 429) throw new AiError(`AI quota or rate limit reached: ${String(detail).slice(0, 200)}`, 502);
    const msg = detail;
    throw new AiError(`AI provider error: ${String(msg).slice(0, 300)}`, 502);
  }

  let out = '';
  if (s.provider === 'anthropic') {
    out = Array.isArray(data?.content) ? data.content.filter((c) => c.type === 'text').map((c) => c.text).join('') : '';
  } else {
    const content = data?.choices?.[0]?.message?.content;
    out = Array.isArray(content) ? content.map((c) => c.text || '').join('') : String(content || '');
  }
  if (!out.trim()) throw new AiError('The AI returned an empty answer.', 502);
  return out.trim();
}

// Models sometimes wrap JSON in code fences or add a sentence around it.
function parseJsonAnswer(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('The AI answer was not in the expected format.', 502);
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new AiError('The AI answer was not in the expected format.', 502);
  }
}

async function completeJson(opts) {
  const text = await complete({ ...opts, temperature: opts.temperature ?? 0.2 });
  return parseJsonAnswer(text);
}

module.exports = { AiError, apiKey, isConfigured, complete, completeJson, parseJsonAnswer };
