// LLM_API_KEY is for chat only; TTS and embeddings keep OPENAI_API_KEY.
import './helpers/env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, calls } from './helpers/env.mjs';
import { resolveLlmApiKey, resolveOpenAiApiKey, getLLMConfig } from '../netlify/functions/_llm.mjs';
import { initConnectors, invoke } from '../netlify/functions/_mcp-connectors.mjs';

const LLM_KEY = 'llm-only-test-key';
const OPENAI_KEY = 'openai-only-test-key';

function bearer(call) {
  return call?.headers?.get?.('Authorization') || '';
}

function chatCalls() {
  return calls.filter((c) => c.url.includes('/chat/completions'));
}
function ttsCalls() {
  return calls.filter((c) => c.url.includes('/audio/speech') || c.url.includes('api.openai.com/v1/audio'));
}
function embedCalls() {
  return calls.filter((c) => c.url.includes('/embeddings'));
}

beforeEach(() => {
  resetFetch();
  delete process.env.LLM_API_KEY;
  process.env.OPENAI_API_KEY = OPENAI_KEY;
});

test('resolveLlmApiKey prefers LLM_API_KEY over OPENAI_API_KEY', () => {
  assert.equal(resolveLlmApiKey({ LLM_API_KEY: LLM_KEY, OPENAI_API_KEY: OPENAI_KEY }), LLM_KEY);
});

test('resolveLlmApiKey falls back to OPENAI_API_KEY when LLM_API_KEY is unset or empty', () => {
  assert.equal(resolveLlmApiKey({ OPENAI_API_KEY: OPENAI_KEY }), OPENAI_KEY);
  assert.equal(resolveLlmApiKey({ LLM_API_KEY: '', OPENAI_API_KEY: OPENAI_KEY }), OPENAI_KEY);
  assert.equal(resolveLlmApiKey({}), '');
});

test('resolveOpenAiApiKey ignores LLM_API_KEY', () => {
  assert.equal(resolveOpenAiApiKey({ LLM_API_KEY: LLM_KEY, OPENAI_API_KEY: OPENAI_KEY }), OPENAI_KEY);
  assert.equal(resolveOpenAiApiKey({ LLM_API_KEY: LLM_KEY }), '');
});

test('getLLMConfig uses LLM_API_KEY first and falls back to OPENAI_API_KEY', () => {
  process.env.LLM_API_KEY = LLM_KEY;
  process.env.OPENAI_API_KEY = OPENAI_KEY;
  assert.equal(getLLMConfig().apiKey, LLM_KEY);
  delete process.env.LLM_API_KEY;
  assert.equal(getLLMConfig().apiKey, OPENAI_KEY);
});

test('chat completions send LLM_API_KEY when both keys are set', async () => {
  initConnectors();
  process.env.LLM_API_KEY = LLM_KEY;
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'hi' } }] } }));
  const out = await invoke('llm', 'chat', { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(out.content, 'hi');
  assert.equal(chatCalls().length, 1);
  assert.equal(bearer(chatCalls()[0]), `Bearer ${LLM_KEY}`);
  assert.equal(bearer(chatCalls()[0]).includes(OPENAI_KEY), false);
});

test('chat completions fall back to OPENAI_API_KEY when LLM_API_KEY is unset', async () => {
  initConnectors();
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'hi' } }] } }));
  await invoke('llm', 'chat', { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(chatCalls().length, 1);
  assert.equal(bearer(chatCalls()[0]), `Bearer ${OPENAI_KEY}`);
});

test('TTS speak uses only OPENAI_API_KEY and never LLM_API_KEY', async () => {
  initConnectors();
  process.env.LLM_API_KEY = LLM_KEY;
  route('api.openai.com/v1/audio/speech', () => new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  }));
  const out = await invoke('tts', 'speak', { text: 'Hello there' });
  assert.ok(out.audio.startsWith('data:audio/mpeg;base64,'));
  assert.equal(ttsCalls().length, 1);
  assert.equal(bearer(ttsCalls()[0]), `Bearer ${OPENAI_KEY}`);
  assert.equal(bearer(ttsCalls()[0]).includes(LLM_KEY), false);
});

test('embeddings use only OPENAI_API_KEY, including the OpenAI fallback', async () => {
  initConnectors();
  process.env.LLM_API_KEY = LLM_KEY;
  route('/embeddings', (url) => {
    if (url.includes('api.openai.com')) {
      return { body: { data: [{ embedding: [0.1, 0.2] }], model: 'text-embedding-3-small' } };
    }
    return { status: 404, body: { error: 'no embeddings on this base' } };
  });
  const out = await invoke('llm', 'embed', { text: 'hello' });
  assert.deepEqual(out.embedding, [0.1, 0.2]);
  assert.ok(embedCalls().length >= 1);
  for (const c of embedCalls()) {
    assert.equal(bearer(c), `Bearer ${OPENAI_KEY}`, c.url);
    assert.equal(bearer(c).includes(LLM_KEY), false, c.url);
  }
  assert.ok(embedCalls().some((c) => c.url.includes('api.openai.com/v1/embeddings')));
});

test('TTS does not send LLM_API_KEY when OPENAI_API_KEY is missing', async () => {
  initConnectors();
  process.env.LLM_API_KEY = LLM_KEY;
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(() => invoke('tts', 'speak', { text: 'Hello' }), /OPENAI_API_KEY not set for TTS/);
  assert.equal(ttsCalls().length, 0);
});
