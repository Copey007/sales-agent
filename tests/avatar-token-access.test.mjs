// Public slugs may mint anonymously; private slugs need a tenant member.
// Fetch is fully mocked — no real LiveAvatar calls.
import './helpers/env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetFetch, route, req, calls, SB, mockAuth } from './helpers/env.mjs';

process.env.LIVEAVATAR_API_KEY = 'test-liveavatar-key';

const token = (await import('../netlify/functions/avatar-token.mjs')).default;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LA = 'https://api.liveavatar.com';
const DEMO_AGENT = {
  slug: 'demo',
  tenant_id: 't-1',
  status: 'active',
  mode: 'FULL',
  avatar_id: '65cca4cf-b7c8-4619-871f-84e2cf8b21d4',
  voice_id: '864a26b8-bfba-4435-9cc5-1dd593de5ca7',
  max_concurrent: 3,
  monthly_minute_cap: 500,
};
const AGENT_AGENT = { ...DEMO_AGENT, slug: 'a-gent', tenant_id: null };
const PRIVATE_AGENT = {
  ...DEMO_AGENT,
  slug: 'acme-secret',
  tenant_id: 't-secret',
  system_prompt: 'SECRET PROMPT T9',
};

function heygenCalls() {
  return calls.filter((c) => /api\.liveavatar\.com|api\.heygen\.com/i.test(c.url));
}

function setupAgents(agents = [DEMO_AGENT, AGENT_AGENT, PRIVATE_AGENT]) {
  route(`${SB}/rest/v1/avatar_agents`, (url) => {
    const m = /slug=eq\.([^&]+)/.exec(url);
    const slug = m ? decodeURIComponent(m[1]) : null;
    return { body: agents.filter((a) => !slug || a.slug === slug) };
  });
  let reserved = null;
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const method = init.method || 'GET';
    if (method === 'POST') {
      reserved = {
        id: 'row-1',
        status: 'pending',
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      };
      return { body: [reserved] };
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body || '{}');
      reserved = { ...(reserved || { id: 'row-1' }), ...patch };
      return { body: [reserved] };
    }
    if (url.includes('select=duration_seconds')) return { body: [] };
    if (url.includes('status=in.(active,pending)')) return { body: reserved ? [reserved] : [] };
    return { body: [] };
  });
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_test', session_id: 'sess-la-1' } },
  }));
}

const confirmed = '2026-01-01T00:00:00Z';
function authMember({ tenant = 't-secret', tokenVal = 'mem' } = {}) {
  mockAuth(
    { [tokenVal]: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed } },
    { 'u-mem': [{ role: 'member', tenant_id: tenant, tenants: { id: tenant, slug: 'acme', name: 'Acme' } }] },
  );
}

beforeEach(() => resetFetch());

const post = (body, headers = {}) =>
  token(req('https://aisdr.example.test/api/avatar-token', { method: 'POST', headers, body }));

test('anonymous POST /api/avatar-token still mints for public slugs demo and a-gent', async () => {
  for (const slug of ['demo', 'a-gent']) {
    resetFetch();
    setupAgents();
    const res = await post({ slug });
    assert.equal(res.status, 200, slug);
    assert.equal((await res.json()).session_token, 'tok_test');
    assert.equal(heygenCalls().filter((c) => c.url.includes('/v1/sessions/token')).length, 1, slug);
  }
});

test('anonymous POST /api/avatar-token does not mint for a private tenant slug', async () => {
  setupAgents();
  const res = await post({ slug: 'acme-secret' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
  assert.equal(heygenCalls().length, 0);
  assert.equal(calls.filter((c) => c.url.includes('/rest/v1/avatar_agents')).length, 0);
});

test('a tenant member can mint their own private slug', async () => {
  setupAgents();
  authMember({ tenant: 't-secret' });
  const res = await post({ slug: 'acme-secret' }, { Authorization: 'Bearer mem' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).session_token, 'tok_test');
  assert.equal(heygenCalls().filter((c) => c.url.includes('/v1/sessions/token')).length, 1);
});

test('a signed-in outsider cannot mint another tenant slug, and no session is minted', async () => {
  setupAgents();
  authMember({ tenant: 't-other' });
  const res = await post({ slug: 'acme-secret' }, { Authorization: 'Bearer mem' });
  assert.equal(res.status, 404);
  assert.equal(heygenCalls().length, 0);
});

test('/agent.html, /a/demo and /a/a-gent still mint via public slugs', () => {
  const html = readFileSync(join(ROOT, 'agent.html'), 'utf8');
  assert.match(html, /params\.get\('slug'\) \|\| 'demo'/);
  assert.match(html, /fetch\('\/api\/avatar-token'/);
  assert.match(html, /body: JSON\.stringify\(\{ slug: SLUG \}\)/);
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(toml, /from = "\/a\/:slug"/);
  assert.match(toml, /to = "\/agent\.html\?slug=:slug"/);
});

test('the side-panel README no longer says both transcript sides come from SDK transcription events', () => {
  const readme = readFileSync(join(ROOT, 'avatar-side-panel/README.md'), 'utf8');
  assert.doesNotMatch(readme, /User and avatar turns are captured from SDK transcription events/);
  assert.match(readme, /\/api\/avatar-chat/ );
  assert.match(readme, /avatar\.transcription/ );
});
