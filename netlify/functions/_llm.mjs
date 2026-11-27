/**
 * Shared LLM utilities for all Netlify Functions.
 * Centralizes API key resolution and model selection.
 */

export const LLM_EMPTY_REPLY = 'llm_empty_reply';
export const LLM_CONFIG_INCOMPLETE = 'llm_config_incomplete';

/** Strip trailing slashes so `${apiBase}/chat/completions` is correct for either form of a provider base URL. */
export function normalizeLlmApiBase(apiBase) {
  return String(apiBase || '').replace(/\/+$/, '');
}

/** Read a named env var from Netlify.env first, then process.env. Empty is treated as unset. */
export function readNetlifyOrProcessEnv(name, envSource = process.env) {
  const fromNetlify = (typeof Netlify !== 'undefined' && Netlify.env?.get?.(name))
    ? Netlify.env.get(name)
    : '';
  return String(fromNetlify || envSource?.[name] || '');
}

/**
 * Chat/completions key only. Prefers LLM_API_KEY so a Claude/Anthropic key can
 * be set without overwriting OPENAI_API_KEY (used by TTS and embeddings).
 */
export function resolveLlmApiKey(envSource = process.env) {
  return readNetlifyOrProcessEnv('LLM_API_KEY', envSource) || readNetlifyOrProcessEnv('OPENAI_API_KEY', envSource);
}

/** OpenAI-only paths (TTS, embeddings). Ignores LLM_API_KEY. */
export function resolveOpenAiApiKey(envSource = process.env) {
  return readNetlifyOrProcessEnv('OPENAI_API_KEY', envSource);
}

/** Chat-only base: LLM_API_BASE first, then OPENAI_API_BASE, then the Manus proxy default. */
export function resolveLlmApiBase(envSource = process.env) {
  const raw = readNetlifyOrProcessEnv('LLM_API_BASE', envSource)
    || readNetlifyOrProcessEnv('OPENAI_API_BASE', envSource)
    || 'https://api.manus.im/api/llm-proxy/v1';
  return normalizeLlmApiBase(raw);
}

/**
 * Parse a Claude model id like claude-haiku-5-5 or claude-opus-4-7-20250401.
 * Returns { family, major, minor } or null.
 */
export function parseClaudeModelId(model) {
  const id = String(model || '').toLowerCase();
  // Prefer an 8-digit date suffix (e.g. claude-opus-4-20250514) over treating
  // the date as a minor version. Minor versions are 1-2 digits (4-5, 4-7, 5-2).
  const m = id.match(/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{8})|(?:-(\d{1,2})(?:-(\d{8}))?))?/);
  if (!m) return null;
  return { family: m[1], major: Number(m[2]), minor: m[4] != null ? Number(m[4]) : 0 };
}

/**
 * Whether the model accepts temperature / top_p on Anthropic's OpenAI-compat
 * layer and the native API. Claude 4.7+, all Claude 5.x, and Mythos Preview
 * reject non-default (or any) sampling params with HTTP 400, so omit them.
 */
export function modelAcceptsSampling(model) {
  const id = String(model || '').toLowerCase();
  if (!id.includes('claude')) return true;
  if (id.includes('mythos-preview')) return false;
  const parsed = parseClaudeModelId(id);
  if (!parsed) return true;
  if (parsed.major > 4) return false;
  if (parsed.major === 4 && parsed.minor >= 7) return false;
  return true;
}

/** Claude 5 family (Haiku 5.5, Opus 5, Fable 5.x, ...). Thinking is on by default. */
export function isClaude5Family(model) {
  const parsed = parseClaudeModelId(model);
  return Boolean(parsed && parsed.major >= 5);
}

/** Floor max_tokens for Claude 5.x so adaptive thinking does not exhaust the budget. */
export const CLAUDE_5X_MIN_MAX_TOKENS = 2000;

export function resolveChatMaxTokens(model, requested) {
  const n = Number(requested);
  const req = Number.isFinite(n) && n > 0 ? n : CLAUDE_5X_MIN_MAX_TOKENS;
  if (isClaude5Family(model)) return Math.max(req, CLAUDE_5X_MIN_MAX_TOKENS);
  return req;
}

/** OpenAI-compat chat/completions body. Omits temperature/top_p when the model rejects them. */
export function chatCompletionBody({ model, messages, temperature, maxTokens, top_p }) {
  const body = {
    model,
    messages,
    max_tokens: resolveChatMaxTokens(model, maxTokens),
  };
  if (modelAcceptsSampling(model)) {
    if (temperature != null) body.temperature = temperature;
    if (top_p != null) body.top_p = top_p;
  }
  return body;
}

/** Redact key-like substrings before logging. Never log the raw return value's secrets. */
export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9_\-]+/g, '[redacted-key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_\-]+=*/g, '[redacted-jwt]');
}

export class LlmConfigIncompleteError extends Error {
  constructor(detail = LLM_CONFIG_INCOMPLETE) {
    super(LLM_CONFIG_INCOMPLETE);
    this.name = 'LlmConfigIncompleteError';
    this.code = LLM_CONFIG_INCOMPLETE;
    this.detail = detail;
  }
}

export function isLlmConfigIncompleteError(err) {
  return Boolean(err && (
    err.code === LLM_CONFIG_INCOMPLETE
    || err.name === 'LlmConfigIncompleteError'
    || err.message === LLM_CONFIG_INCOMPLETE
  ));
}

/**
 * Pair LLM_API_KEY with LLM_API_BASE. A partial pair is a hard failure so a
 * Claude key is never sent to OpenAI/Manus, and an OpenAI key is never sent
 * to the Anthropic base. When neither is set, fall back to OPENAI_API_KEY
 * plus OPENAI_API_BASE or the Manus default.
 */
export function getLLMConfig(options = {}) {
  const llmKey = readNetlifyOrProcessEnv('LLM_API_KEY').trim();
  const llmBase = readNetlifyOrProcessEnv('LLM_API_BASE').trim();
  const hasKey = Boolean(llmKey);
  const hasBase = Boolean(llmBase);

  if (hasKey !== hasBase) {
    const detail = hasKey ? 'LLM_API_BASE missing' : 'LLM_API_KEY missing';
    console.warn('[llm] llm_config_incomplete', detail);
    throw new LlmConfigIncompleteError(detail);
  }

  const apiKey = hasKey ? llmKey : resolveOpenAiApiKey();
  const apiBase = hasBase
    ? normalizeLlmApiBase(llmBase)
    : normalizeLlmApiBase(readNetlifyOrProcessEnv('OPENAI_API_BASE') || 'https://api.manus.im/api/llm-proxy/v1');

  // Default stays claude-haiku-4-5 (still Active, and the Manus-default stopgap).
  // Set LLM_MODEL=claude-haiku-5-5 in env to use the current recommended Haiku.
  const model = options.model
    || readNetlifyOrProcessEnv('LLM_MODEL')
    || 'claude-haiku-4-5';
  return { apiKey, apiBase, model };
}

/** Current first-party Claude API version for raw (non-SDK) HTTP calls. */
export const ANTHROPIC_API_VERSION = '2026-10-21';

/** True when the LLM base URL is Anthropic's first-party API. */
export function isAnthropicApiBase(apiBase) {
  const raw = normalizeLlmApiBase(apiBase);
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return /(?:^https?:\/\/)?(?:[\w-]+\.)?anthropic\.com(?:[\/:?]|$)/i.test(raw);
  }
}

/**
 * Headers for an OpenAI-compatible chat/completions call.
 * Authorization: Bearer is required (Anthropic's OpenAI-compat layer supports it).
 * When the resolved base is api.anthropic.com, also send anthropic-version
 * (required on raw Claude API HTTP calls; official SDKs add it automatically).
 * If ANTHROPIC_WORKSPACE_ID is set, also send anthropic-workspace-id
 * (required for personal/service keys that are not scoped to a workspace).
 * Never log the returned headers; they can contain the key.
 *
 * @param {string} apiKey
 * @param {object} [envSource]
 * @param {{ apiBase?: string }} [options]  Pass the resolved base when known.
 */
export function llmAuthHeaders(apiKey, envSource = process.env, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  const apiBase = options.apiBase
    || readNetlifyOrProcessEnv('LLM_API_BASE', envSource)
    || readNetlifyOrProcessEnv('OPENAI_API_BASE', envSource);
  if (isAnthropicApiBase(apiBase)) {
    headers['anthropic-version'] = ANTHROPIC_API_VERSION;
  }
  const workspace = (typeof Netlify !== 'undefined' && Netlify.env?.get?.('ANTHROPIC_WORKSPACE_ID'))
    ? Netlify.env.get('ANTHROPIC_WORKSPACE_ID')
    : (envSource?.ANTHROPIC_WORKSPACE_ID || '');
  if (workspace) headers['anthropic-workspace-id'] = String(workspace);
  return headers;
}

export const LLM_UPSTREAM_ERROR = 'llm_upstream_error';

/**
 * Allowlisted, secret-free view of an upstream LLM error.
 * Keeps only HTTP status and short error type/code tokens. Drops message,
 * request ids, headers, and any body text that might contain key material.
 */
export function parseLlmUpstreamError(status, bodyText) {
  let type = null;
  let code = null;
  try {
    const parsed = JSON.parse(String(bodyText || ''));
    const err = (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object')
      ? parsed.error
      : parsed;
    const t = err && typeof err === 'object' ? err.type : null;
    const c = err && typeof err === 'object' ? err.code : null;
    if (typeof t === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(t)) type = t;
    if (typeof c === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(c)) code = c;
  } catch {
    // Non-JSON bodies are ignored; never return raw text.
  }
  const statusNum = Number(status);
  return {
    status: Number.isFinite(statusNum) ? statusNum : 0,
    type,
    code,
  };
}

export class LlmUpstreamError extends Error {
  constructor({ status, type, code } = {}) {
    super(LLM_UPSTREAM_ERROR);
    this.name = 'LlmUpstreamError';
    this.code = LLM_UPSTREAM_ERROR;
    this.status = status ?? 0;
    this.upstreamType = type ?? null;
    this.upstreamCode = code ?? null;
  }
}

export function isLlmUpstreamError(err) {
  return Boolean(err && (
    err.code === LLM_UPSTREAM_ERROR
    || err.name === 'LlmUpstreamError'
    || err.message === LLM_UPSTREAM_ERROR
  ));
}

/** Log only allowlisted fields. Never pass the raw upstream body here. */
export function logLlmUpstreamError(label, info) {
  console.error(`[${label}] ${LLM_UPSTREAM_ERROR}`, {
    status: info?.status ?? 0,
    type: info?.type ?? null,
    code: info?.code ?? null,
  });
}

export async function throwIfLlmResponseNotOk(res, label = 'llm') {
  if (res.ok) return;
  const info = parseLlmUpstreamError(res.status, await res.text());
  logLlmUpstreamError(label, info);
  throw new LlmUpstreamError(info);
}

/** Allowlisted, redacted view of an OpenAI-compatible chat completion body. No content, keys, or headers. */
export function llmResponseShape(data) {
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const first = choices[0] || {};
  const usage = data?.usage && typeof data.usage === 'object' ? data.usage : null;
  return {
    keys,
    choices: choices.length,
    finish_reason: first.finish_reason ?? null,
    model: data?.model ?? null,
    usage: usage ? {
      prompt_tokens: usage.prompt_tokens ?? null,
      completion_tokens: usage.completion_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
    } : null,
  };
}

export class LlmEmptyReplyError extends Error {
  constructor(shape = null) {
    super(LLM_EMPTY_REPLY);
    this.name = 'LlmEmptyReplyError';
    this.code = LLM_EMPTY_REPLY;
    this.shape = shape;
  }
}

export function isLlmEmptyReplyError(err) {
  return Boolean(err && (err.code === LLM_EMPTY_REPLY || err.name === 'LlmEmptyReplyError' || err.message === LLM_EMPTY_REPLY));
}

/**
 * Require non-empty (non-whitespace) text from an invoke('llm','chat') result.
 * Logs a redacted response shape when empty. Throws LlmEmptyReplyError.
 */
export function requireNonEmptyLlmText(response, label = 'llm') {
  const text = String(response?.content ?? '').trim();
  if (text) return text;
  const shape = response?.shape || llmResponseShape(null);
  if (shape.finish_reason === 'length') {
    console.warn(`[${label}] empty_reply finish_reason=length (thinking or output may have exhausted max_tokens)`, shape);
  } else {
    console.warn(`[${label}] empty_reply`, shape);
  }
  throw new LlmEmptyReplyError(shape);
}

export function cleanLLMJson(content) {
  return content.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
}

export async function callLLM(messages, options = {}) {
  const { apiKey, apiBase, model } = getLLMConfig(options);
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens ?? 2000;

  if (!apiKey) throw new Error('LLM_API_KEY or OPENAI_API_KEY not configured');

  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: llmAuthHeaders(apiKey, process.env, { apiBase }),
    body: JSON.stringify(chatCompletionBody({ model, messages, temperature, maxTokens })),
  });

  await throwIfLlmResponseNotOk(response, 'llm');

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

export function parseLLMJson(content) {
  const cleaned = cleanLLMJson(content);
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  throw new Error('No valid JSON found in LLM response');
}
