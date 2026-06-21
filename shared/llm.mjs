/**
 * Shared LLM utilities for all Netlify Functions.
 * Centralizes API key resolution and model selection.
 */

export function getLLMConfig(options = {}) {
  const apiKey = (typeof Netlify !== 'undefined' && Netlify.env?.get('OPENAI_API_KEY'))
    ? Netlify.env.get('OPENAI_API_KEY')
    : (process.env.OPENAI_API_KEY || '');
  const apiBase = (typeof Netlify !== 'undefined' && Netlify.env?.get('OPENAI_API_BASE'))
    ? Netlify.env.get('OPENAI_API_BASE')
    : (process.env.OPENAI_API_BASE || 'https://api.manus.im/api/llm-proxy/v1');
  // Default model: claude-haiku-4-5 for speed (fits within Netlify timeout)
  const model = options.model
    || ((typeof Netlify !== 'undefined' && Netlify.env?.get('LLM_MODEL'))
      ? Netlify.env.get('LLM_MODEL')
      : (process.env.LLM_MODEL || 'claude-haiku-4-5'));
  return { apiKey, apiBase, model };
}

export function cleanLLMJson(content) {
  return content.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
}

export async function callLLM(messages, options = {}) {
  const { apiKey, apiBase, model } = getLLMConfig(options);
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens ?? 2000;

  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
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
