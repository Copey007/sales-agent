// Claude 5.5 / Anthropic-compat request shaping. Fetch is fully mocked — no real provider calls.
import './helpers/env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetFetch, route, req, calls, SB, INTERNAL } from './helpers/env.mjs';
import {
  modelAcceptsSampling,
  parseClaudeModelId,
  isClaude5Family,
  resolveChatMaxTokens,
  chatCompletionBody,
  getLLMConfig,
  callLLM,
  isLlmConfigIncompleteError,
  requireNonEmptyLlmText,
  isLlmEmptyReplyError,
  CLAUDE_5X_MIN_MAX_TOKENS,
} from '../netlify/functions/_llm.mjs';
import { initConnectors, invoke } from '../netlify/functions/_mcp-connectors.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const concierge = (await import('../netlify/functions/concierge.mjs')).default;
const gapEmail = (await import('../netlify/functions/generate-gap-email.mjs')).default;
const gapPipeline = (await import('../netlify/functions/gap-email-pipeline.mjs')).default;
const loopEngine = (await import('../netlify/functions/loop-engine.mjs')).default;

const DEMO_AGENT = {
  slug: 'demo',
  status: 'active',
  name: 'Demo',
  system_prompt: 'You are the public demo agent.',
  knowledge: 'Public demo knowledge',
};

beforeEach(() => {
  resetFetch();
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_API_BASE;
  delete process.env.LLM_MODEL;
  delete process.env.OPENAI_API_BASE;
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
});

function bearer(call) {
  return call?.headers?.get?.('Authorization') || '';
}
function chatCalls() {
  return calls.filter((c) => c.url.includes('/chat/completions'));
}
function embedCalls() {
  return calls.filter((c) => c.url.includes('/embeddings'));
}

test('modelAcceptsSampling is false for Claude 4.7+, 5.x, and Mythos Preview', () => {
  assert.equal(modelAcceptsSampling('claude-haiku-5-5'), false);
  assert.equal(modelAcceptsSampling('claude-opus-5-5'), false);
  assert.equal(modelAcceptsSampling('claude-sonnet-5-5'), false);
  assert.equal(modelAcceptsSampling('claude-fable-5-2'), false);
  assert.equal(modelAcceptsSampling('claude-opus-4-7'), false);
  assert.equal(modelAcceptsSampling('claude-opus-4-8'), false);
  assert.equal(modelAcceptsSampling('claude-mythos-preview'), false);
  assert.equal(modelAcceptsSampling('claude-haiku-4-5'), true);
  assert.equal(modelAcceptsSampling('claude-haiku-4-5-20251001'), true);
  assert.equal(modelAcceptsSampling('claude-sonnet-4-6'), true);
  assert.equal(modelAcceptsSampling('gpt-5-mini'), true);
  assert.equal(modelAcceptsSampling(''), true);
  assert.deepEqual(parseClaudeModelId('claude-opus-4-20250514'), { family: 'opus', major: 4, minor: 0 });
  assert.equal(modelAcceptsSampling('claude-opus-4-20250514'), true);
  assert.deepEqual(parseClaudeModelId('claude-haiku-4-5-20251001'), { family: 'haiku', major: 4, minor: 5 });
  assert.equal(modelAcceptsSampling('claude-haiku-4-5-20251001'), true);
});

test('Claude 5.x floors max_tokens at 2000; 4.5 keeps the caller value', () => {
  assert.equal(isClaude5Family('claude-haiku-5-5'), true);
  assert.equal(isClaude5Family('claude-haiku-4-5'), false);
  assert.equal(isClaude5Family('claude-opus-4-7'), false);
  assert.equal(resolveChatMaxTokens('claude-haiku-5-5', 300), CLAUDE_5X_MIN_MAX_TOKENS);
  assert.equal(resolveChatMaxTokens('claude-haiku-5-5', 4000), 4000);
  assert.equal(resolveChatMaxTokens('claude-haiku-4-5', 300), 300);
  const five = chatCompletionBody({ model: 'claude-haiku-5-5', messages: [], temperature: 0.7, maxTokens: 300, top_p: 0.9 });
  assert.equal('temperature' in five, false);
  assert.equal('top_p' in five, false);
  assert.equal(five.max_tokens, 2000);
  const four = chatCompletionBody({ model: 'claude-haiku-4-5', messages: [], temperature: 0.7, maxTokens: 300, top_p: 0.9 });
  assert.equal(four.temperature, 0.7);
  assert.equal(four.top_p, 0.9);
  assert.equal(four.max_tokens, 300);
});

test('when the LLM pair is complete, chat uses only LLM_API_BASE and not OPENAI_API_BASE', () => {
  process.env.LLM_API_KEY = 'llm-only-test-key';
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1/';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1';
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
  assert.equal(getLLMConfig().apiBase, 'https://api.anthropic.com/v1');
  assert.equal(getLLMConfig().apiKey, 'llm-only-test-key');
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_API_BASE;
  assert.equal(getLLMConfig().apiBase, 'https://api.openai.com/v1');
  assert.equal(getLLMConfig().apiKey, 'openai-only-test-key');
});

test('chat completions for claude-haiku-5-5 omit temperature and raise max_tokens', async () => {
  initConnectors();
  process.env.LLM_MODEL = 'claude-haiku-5-5';
  process.env.LLM_API_KEY = 'llm-only-test-key';
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1';
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'Hello from Haiku 5.5' }, finish_reason: 'stop' }] } }));
  const out = await invoke('llm', 'chat', {
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.7,
    maxTokens: 300,
  });
  assert.equal(out.content, 'Hello from Haiku 5.5');
  assert.equal(chatCalls().length, 1);
  assert.equal(chatCalls()[0].url, 'https://api.anthropic.com/v1/chat/completions');
  assert.equal(bearer(chatCalls()[0]), 'Bearer llm-only-test-key');
  const body = JSON.parse(chatCalls()[0].body);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal('temperature' in body, false);
  assert.equal('top_p' in body, false);
  assert.equal(body.max_tokens, 2000);
});

test('chat completions for claude-haiku-4-5 still send temperature', async () => {
  initConnectors();
  process.env.LLM_MODEL = 'claude-haiku-4-5';
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } }));
  await invoke('llm', 'chat', { messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, maxTokens: 300 });
  const body = JSON.parse(chatCalls()[0].body);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_tokens, 300);
});

test('empty content with finish_reason=length is 502 and the log names length', async () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => { warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try {
    requireNonEmptyLlmText({
      content: '',
      shape: { keys: ['choices'], choices: 1, finish_reason: 'length', model: 'claude-haiku-5-5', usage: { completion_tokens: 2000 } },
    }, 'concierge');
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(isLlmEmptyReplyError(e), true);
  } finally {
    console.warn = orig;
  }
  const blob = warns.join('\n');
  assert.match(blob, /finish_reason=length/);
  assert.match(blob, /max_tokens/);
});

test('a demo chat with finish_reason=length and empty content returns 502 llm_empty_reply', async () => {
  process.env.LLM_MODEL = 'claude-haiku-5-5';
  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [DEMO_AGENT] }));
  route('/chat/completions', () => ({
    body: {
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
      model: 'claude-haiku-5-5',
      usage: { prompt_tokens: 20, completion_tokens: 2000, total_tokens: 2020 },
    },
  }));
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => { warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try {
    const res = await concierge(req('https://aisdr.example.test/api/concierge', {
      method: 'POST',
      body: { action: 'chat', slug: 'demo', messages: [{ role: 'user', content: 'Hi' }], speak: false },
    }));
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'llm_empty_reply');
  } finally {
    console.warn = orig;
  }
  assert.match(warns.join('\n'), /finish_reason=length/);
});

test('concierge does not expose provider error text to the client', async () => {
  process.env.LLM_MODEL = 'claude-haiku-5-5';
  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [DEMO_AGENT] }));
  route('/chat/completions', () => ({
    status: 400,
    body: { error: { message: 'temperature below 1 is rejected SECRET_SHOULD_NOT_LEAK sk-test-secret-should-not-appear' } },
  }));
  const errors = [];
  const orig = console.error;
  console.error = (...args) => { errors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try {
    const res = await concierge(req('https://aisdr.example.test/api/concierge', {
      method: 'POST',
      body: { action: 'chat', slug: 'demo', messages: [{ role: 'user', content: 'Hi' }], speak: false },
    }));
    assert.equal(res.status, 500);
    const body = await res.json();
    const dumped = JSON.stringify(body);
    assert.equal(body.error, 'internal_error');
    assert.equal(dumped.includes('temperature below 1'), false);
    assert.equal(dumped.includes('SECRET_SHOULD_NOT_LEAK'), false);
    assert.equal(dumped.includes('sk-test-secret-should-not-appear'), false);
    assert.equal(dumped.includes('LLM error'), false);
  } finally {
    console.error = orig;
  }
  const log = errors.join('\n');
  assert.equal(log.includes('sk-test-secret-should-not-appear'), false);
});

test('embeddings go only to api.openai.com, never LLM_API_BASE or OPENAI_API_BASE', async () => {
  initConnectors();
  process.env.LLM_API_KEY = 'llm-only-test-key';
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1';
  process.env.OPENAI_API_BASE = 'https://api.manus.im/api/llm-proxy/v1';
  route('/embeddings', (url) => {
    if (url.includes('api.openai.com')) {
      return { body: { data: [{ embedding: [0.1, 0.2] }], model: 'text-embedding-3-small' } };
    }
    return { status: 500, body: { error: 'should-not-be-called' } };
  });
  const out = await invoke('llm', 'embed', { text: 'hello' });
  assert.deepEqual(out.embedding, [0.1, 0.2]);
  assert.equal(embedCalls().length, 1);
  assert.equal(embedCalls()[0].url, 'https://api.openai.com/v1/embeddings');
  assert.equal(bearer(embedCalls()[0]), 'Bearer openai-only-test-key');
  assert.equal(embedCalls().some((c) => c.url.includes('anthropic.com') || c.url.includes('manus.im')), false);
});

test('callLLM uses LLM_API_BASE and omits temperature for claude-haiku-5-5', async () => {
  process.env.LLM_MODEL = 'claude-haiku-5-5';
  process.env.LLM_API_KEY = 'llm-only-test-key';
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1';
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: '{"ok":true}' } }] } }));
  const content = await callLLM([{ role: 'user', content: 'hi' }], { temperature: 0.7, maxTokens: 800 });
  assert.equal(content, '{"ok":true}');
  const body = JSON.parse(chatCalls()[0].body);
  assert.equal(chatCalls()[0].url, 'https://api.anthropic.com/v1/chat/completions');
  assert.equal('temperature' in body, false);
  assert.equal(body.max_tokens, 2000);
  assert.equal(bearer(chatCalls()[0]), 'Bearer llm-only-test-key');
});

test('gap-email and loop-engine route chat through shared _llm.mjs and do not fetch completions themselves', () => {
  for (const rel of [
    'netlify/functions/generate-gap-email.mjs',
    'netlify/functions/gap-email-pipeline.mjs',
    'netlify/functions/loop-engine.mjs',
  ]) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /from '\.\/_llm\.mjs'/, rel);
    assert.equal(src.includes('/chat/completions'), false, rel);
    assert.equal(src.includes("env.get('OPENAI_API_BASE')"), false, rel);
  }
});

function noChatCalls() {
  assert.equal(chatCalls().length, 0);
}

function assertNoLeak(text, ...secrets) {
  const dumped = typeof text === 'string' ? text : JSON.stringify(text);
  for (const s of secrets) {
    if (s) assert.equal(dumped.includes(s), false, `leaked ${s}`);
  }
  assert.equal(/Bearer\s+\S+/i.test(dumped), false);
}

const SECRETS = ['llm-only-test-key', 'openai-only-test-key', 'sk-test-secret-should-not-appear'];

test('LLM pair complete: callLLM and concierge use only LLM_API_KEY and LLM_API_BASE', async () => {
  process.env.LLM_API_KEY = 'llm-only-test-key';
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1';
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1';
  process.env.LLM_MODEL = 'claude-haiku-5-5';
  const cfg = getLLMConfig();
  assert.equal(cfg.apiKey, 'llm-only-test-key');
  assert.equal(cfg.apiBase, 'https://api.anthropic.com/v1');

  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'paired-ok' } }] } }));
  const text = await callLLM([{ role: 'user', content: 'hi' }], { temperature: 0.7, maxTokens: 300 });
  assert.equal(text, 'paired-ok');
  assert.equal(chatCalls()[0].url, 'https://api.anthropic.com/v1/chat/completions');
  assert.equal(bearer(chatCalls()[0]), 'Bearer llm-only-test-key');
  assert.equal(bearer(chatCalls()[0]).includes('openai-only-test-key'), false);

  resetFetch();
  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [DEMO_AGENT] }));
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'Hello from Anthropic' } }] } }));
  const res = await concierge(req('https://aisdr.example.test/api/concierge', {
    method: 'POST',
    body: { action: 'chat', slug: 'demo', messages: [{ role: 'user', content: 'Hi' }], speak: false },
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reply, 'Hello from Anthropic');
  assert.equal(chatCalls()[0].url, 'https://api.anthropic.com/v1/chat/completions');
  assert.equal(bearer(chatCalls()[0]), 'Bearer llm-only-test-key');
});

test('LLM_API_KEY set without LLM_API_BASE: refuse 502, no fallback fetch, no leak', async () => {
  process.env.LLM_API_KEY = 'llm-only-test-key';
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1';
  delete process.env.LLM_API_BASE;

  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => { warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try {
    assert.throws(() => getLLMConfig(), (e) => isLlmConfigIncompleteError(e));
    await assert.rejects(() => callLLM([{ role: 'user', content: 'hi' }]), (e) => isLlmConfigIncompleteError(e));
  } finally {
    console.warn = orig;
  }
  noChatCalls();
  assert.match(warns.join('\n'), /llm_config_incomplete/);
  assertNoLeak(warns.join('\n'), ...SECRETS);

  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [DEMO_AGENT] }));
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'should-not-run' } }] } }));
  const res = await concierge(req('https://aisdr.example.test/api/concierge', {
    method: 'POST',
    body: { action: 'chat', slug: 'demo', messages: [{ role: 'user', content: 'Hi' }], speak: false },
  }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'llm_config_incomplete');
  assertNoLeak(body, ...SECRETS);
  noChatCalls();

  const gap = await gapEmail(req('https://aisdr.example.test/api/generate-gap-email', {
    method: 'POST',
    headers: INTERNAL,
    body: { prospect: { contact_name: 'Pat', company_name: 'Acme' }, signals: [] },
  }));
  assert.equal(gap.status, 502);
  const gapBody = await gap.json();
  assert.equal(gapBody.error, 'llm_config_incomplete');
  assertNoLeak(gapBody, ...SECRETS);
  noChatCalls();

  const pipe = await gapPipeline(req('https://aisdr.example.test/api/gap-email-pipeline', {
    method: 'POST',
    headers: INTERNAL,
    body: { prospect: { contact_name: 'Pat', company_name: 'Acme' }, skip_signals: true },
  }));
  assert.equal(pipe.status, 502);
  const pipeBody = await pipe.json();
  assert.equal(pipeBody.error, 'llm_config_incomplete');
  assert.equal(pipeBody.hint, undefined);
  assertNoLeak(pipeBody, ...SECRETS);
  noChatCalls();

  const loop = await loopEngine(req('https://aisdr.example.test/api/loop-engine', {
    method: 'POST',
    body: { action: 'run' },
  }));
  assert.equal(loop.status, 502);
  const loopBody = await loop.json();
  assert.equal(loopBody.error, 'llm_config_incomplete');
  assert.equal(loopBody.stack, undefined);
  assertNoLeak(loopBody, ...SECRETS);
  noChatCalls();
});

test('LLM_API_BASE set without LLM_API_KEY: refuse 502, never send OPENAI_API_KEY to that base, no leak', async () => {
  delete process.env.LLM_API_KEY;
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1';
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1';

  assert.throws(() => getLLMConfig(), (e) => isLlmConfigIncompleteError(e));
  await assert.rejects(() => callLLM([{ role: 'user', content: 'hi' }]), (e) => isLlmConfigIncompleteError(e));
  noChatCalls();

  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [DEMO_AGENT] }));
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'should-not-run' } }] } }));
  const res = await concierge(req('https://aisdr.example.test/api/concierge', {
    method: 'POST',
    body: { action: 'chat', slug: 'demo', messages: [{ role: 'user', content: 'Hi' }], speak: false },
  }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'llm_config_incomplete');
  assertNoLeak(body, ...SECRETS);
  noChatCalls();

  const gap = await gapEmail(req('https://aisdr.example.test/api/generate-gap-email', {
    method: 'POST',
    headers: INTERNAL,
    body: { prospect: { contact_name: 'Pat', company_name: 'Acme' }, signals: [] },
  }));
  assert.equal(gap.status, 502);
  assert.equal((await gap.json()).error, 'llm_config_incomplete');
  noChatCalls();

  const pipe = await gapPipeline(req('https://aisdr.example.test/api/gap-email-pipeline', {
    method: 'POST',
    headers: INTERNAL,
    body: { prospect: { contact_name: 'Pat', company_name: 'Acme' }, skip_signals: true },
  }));
  assert.equal(pipe.status, 502);
  const pipeBody = await pipe.json();
  assert.equal(pipeBody.error, 'llm_config_incomplete');
  assert.equal(pipeBody.hint, undefined);
  assertNoLeak(pipeBody, ...SECRETS);
  noChatCalls();

  const loop = await loopEngine(req('https://aisdr.example.test/api/loop-engine', {
    method: 'POST',
    body: { action: 'run' },
  }));
  assert.equal(loop.status, 502);
  const loopBody = await loop.json();
  assert.equal(loopBody.error, 'llm_config_incomplete');
  assert.equal(loopBody.stack, undefined);
  assertNoLeak(loopBody, ...SECRETS);
  noChatCalls();
});

test('neither LLM_API_KEY nor LLM_API_BASE: keep OPENAI_API_KEY with OPENAI_API_BASE or Manus', async () => {
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_API_BASE;
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1/';
  const cfg = getLLMConfig();
  assert.equal(cfg.apiKey, 'openai-only-test-key');
  assert.equal(cfg.apiBase, 'https://api.openai.com/v1');

  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'fallback-ok' } }] } }));
  const text = await callLLM([{ role: 'user', content: 'hi' }]);
  assert.equal(text, 'fallback-ok');
  assert.equal(chatCalls()[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(bearer(chatCalls()[0]), 'Bearer openai-only-test-key');

  delete process.env.OPENAI_API_BASE;
  const manus = getLLMConfig();
  assert.equal(manus.apiKey, 'openai-only-test-key');
  assert.equal(manus.apiBase, 'https://api.manus.im/api/llm-proxy/v1');
});
