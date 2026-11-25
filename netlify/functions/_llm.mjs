/**
 * Shared LLM utilities for all Netlify Functions.
 * Centralizes API key resolution and model selection.
 */

export const LLM_EMPTY_REPLY = 'llm_empty_reply';

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

export function getLLMConfig(options = {}) {
  const apiKey = resolveLlmApiKey();
  const rawBase = readNetlifyOrProcessEnv('OPENAI_API_BASE') || 'https://api.manus.im/api/llm-proxy/v1';
  const apiBase = normalizeLlmApiBase(rawBase);
  // Default model: claude-haiku-4-5 for speed (fits within Netlify timeout)
  const model = options.model
    || readNetlifyOrProcessEnv('LLM_MODEL')
    || 'claude-haiku-4-5';
  return { apiKey, apiBase, model };
}

/**
 * Headers for an OpenAI-compatible chat/completions call.
 * Authorization: Bearer is required. If ANTHROPIC_WORKSPACE_ID is set, also
 * send anthropic-workspace-id (needed for some unscoped Anthropic keys).
 * Never log the returned headers; they can contain the key.
 */
export function llmAuthHeaders(apiKey, envSource = process.env) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  const workspace = (typeof Netlify !== 'undefined' && Netlify.env?.get?.('ANTHROPIC_WORKSPACE_ID'))
    ? Netlify.env.get('ANTHROPIC_WORKSPACE_ID')
    : (envSource?.ANTHROPIC_WORKSPACE_ID || '');
  if (workspace) headers['anthropic-workspace-id'] = String(workspace);
  return headers;
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
  console.warn(`[${label}] empty_reply`, shape);
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
    headers: llmAuthHeaders(apiKey),
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

export function parseLLMJson(content) {
  const cleaned = cleanLLMJson(content);
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  throw new Error('No valid JSON found in LLM response');
}
