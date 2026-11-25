// /api/avatar-token is POST-only; the reaper stops LiveAvatar sessions.
// Fetch is fully mocked — no real HeyGen or LiveAvatar calls.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, req, calls, SB } from './helpers/env.mjs';

process.env.LIVEAVATAR_API_KEY = 'test-liveavatar-key';

const token = (await import('../netlify/functions/avatar-token.mjs')).default;
const reaper = (await import('../netlify/functions/avatar-reaper.mjs')).default;

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

function heygenCalls() {
  return calls.filter((c) =>
    /api\.liveavatar\.com|api\.heygen\.com/i.test(c.url),
  );
}

function setupTokenPostMocks() {
  resetFetch();
  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [DEMO_AGENT] }));
  route(`${SB}/rest/v1/avatar_sessions`, (_url, init) => {
    if ((init.method || 'GET') === 'POST') return { body: [{ id: 'row-1' }] };
    return { body: [] };
  });
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_test', session_id: 'sess-la-1' } },
  }));
}

test('GET /api/avatar-token returns 405 and does not call HeyGen or LiveAvatar', async () => {
  resetFetch();
  const res = await token(req('https://aisdr.example.test/api/avatar-token', { method: 'GET' }));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
  const body = await res.json();
  assert.equal(body.error, 'method_not_allowed');
  assert.equal(calls.length, 0);
  assert.equal(heygenCalls().length, 0);
});

test('HEAD and PUT /api/avatar-token also return 405 with no HeyGen call', async () => {
  for (const method of ['HEAD', 'PUT', 'PATCH', 'DELETE']) {
    resetFetch();
    const res = await token(req('https://aisdr.example.test/api/avatar-token', { method }));
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST', method);
    assert.equal(heygenCalls().length, 0, method);
    assert.equal(calls.length, 0, method);
  }
});

test('OPTIONS /api/avatar-token is a 204 preflight and does not call HeyGen', async () => {
  resetFetch();
  const res = await token(req('https://aisdr.example.test/api/avatar-token', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(heygenCalls().length, 0);
});

test('POST /api/avatar-token still mints a token via the mocked LiveAvatar API', async () => {
  setupTokenPostMocks();
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.session_token, 'tok_test');
  assert.equal(body.session_id, 'sess-la-1');
  assert.equal(body.session_row, 'row-1');
  assert.equal(body.mode, 'FULL');
  const minted = heygenCalls().filter((c) => c.url.includes('/v1/sessions/token'));
  assert.equal(minted.length, 1);
  assert.equal(minted[0].method, 'POST');
  const sent = JSON.parse(minted[0].body);
  assert.equal(sent.avatar_id, DEMO_AGENT.avatar_id);
  assert.equal(sent.mode, 'FULL');
  assert.equal(sent.avatar_persona.voice_id, DEMO_AGENT.voice_id);
  assert.equal(heygenCalls().filter((c) => c.url.includes('api.heygen.com')).length, 0);
});

test('reaper POSTs /v1/sessions/stop for each stale LiveAvatar session, then closes the local row', async () => {
  resetFetch();
  const stale = [
    { id: 'r1', liveavatar_session_id: 'la-1', started_at: '2020-01-01T00:00:00Z', last_heartbeat: '2020-01-01T00:00:00Z', duration_seconds: 10 },
    { id: 'r2', liveavatar_session_id: 'la-2', started_at: '2020-01-01T00:00:00Z', last_heartbeat: '2020-01-01T00:00:00Z', duration_seconds: 20 },
  ];
  const patched = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'PATCH') {
      patched.push({ url, body: init.body });
      return { body: [{ id: 'ok' }] };
    }
    return { body: stale };
  });
  const stopped = [];
  route(`${LA}/v1/sessions/stop`, (_url, init) => {
    stopped.push(JSON.parse(init.body || '{}'));
    return { body: { success: true } };
  });

  const res = await reaper();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stopped, 2);
  assert.equal(body.reaped, 2);
  assert.equal(stopped.length, 2);
  assert.deepEqual(stopped.map((s) => s.session_id).sort(), ['la-1', 'la-2']);
  assert.equal(heygenCalls().length, 2);
  assert.ok(heygenCalls().every((c) => c.method === 'POST' && c.url === `${LA}/v1/sessions/stop`));
  assert.equal(patched.length, 2);
});

test('reaper still closes the local row when a LiveAvatar stop fails', async () => {
  resetFetch();
  const stale = [
    { id: 'r3', liveavatar_session_id: 'la-bad', started_at: '2020-01-01T00:00:00Z', last_heartbeat: '2020-01-01T00:00:00Z', duration_seconds: 5 },
  ];
  let patched = 0;
  route(`${SB}/rest/v1/avatar_sessions`, (_url, init) => {
    if ((init.method || 'GET') === 'PATCH') { patched++; return { body: [{ id: 'r3' }] }; }
    return { body: stale };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ status: 502, body: { error: 'upstream' } }));

  const res = await reaper();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stopped, 0);
  assert.equal(body.reaped, 1);
  assert.equal(patched, 1);
  assert.equal(heygenCalls().length, 1);
});
