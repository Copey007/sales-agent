// Pilot caps fail closed; session-end / heartbeat stop LiveAvatar.
// Fetch is fully mocked — no real HeyGen or LiveAvatar calls.
import './helpers/env.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, req, calls, SB } from './helpers/env.mjs';
import { getAvatarCaps, sessionOverMax, DEFAULT_MONTHLY_MINUTE_CAP, DEFAULT_MAX_SESSION_SECONDS } from '../netlify/functions/_avatar-caps.mjs';

process.env.LIVEAVATAR_API_KEY = 'test-liveavatar-key';

const token = (await import('../netlify/functions/avatar-token.mjs')).default;
const sessionEnd = (await import('../netlify/functions/avatar-session-end.mjs')).default;
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

const savedEnv = {};
function setEnv(name, value) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = String(value);
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
}
beforeEach(() => resetFetch());
afterEach(() => restoreEnv());

test('default caps are the conservative Starter-safe values', () => {
  restoreEnv();
  delete process.env.AVATAR_MONTHLY_MINUTE_CAP;
  delete process.env.AVATAR_MAX_SESSION_SECONDS;
  delete process.env.AVATAR_HEARTBEAT_TIMEOUT_SECONDS;
  const caps = getAvatarCaps({ monthly_minute_cap: 2000 });
  assert.equal(caps.monthlyMinuteCap, DEFAULT_MONTHLY_MINUTE_CAP);
  assert.equal(caps.maxSessionSeconds, DEFAULT_MAX_SESSION_SECONDS);
  assert.equal(caps.monthlyMinuteCap, 60);
  assert.equal(caps.maxSessionSeconds, 180);
});

test('platform env cap wins when it is lower than the agent cap; agent cap can only tighten', () => {
  setEnv('AVATAR_MONTHLY_MINUTE_CAP', 60);
  assert.equal(getAvatarCaps({ monthly_minute_cap: 500 }).monthlyMinuteCap, 60);
  assert.equal(getAvatarCaps({ monthly_minute_cap: 20 }).monthlyMinuteCap, 20);
  setEnv('AVATAR_MAX_SESSION_SECONDS', 90);
  assert.equal(getAvatarCaps().maxSessionSeconds, 90);
});

test('sessionOverMax uses recorded duration or elapsed wall time', () => {
  assert.equal(sessionOverMax({ durationSeconds: 180, maxSessionSeconds: 180 }), true);
  assert.equal(sessionOverMax({ durationSeconds: 179, maxSessionSeconds: 180 }), false);
  const startedAt = new Date(Date.now() - 200 * 1000).toISOString();
  assert.equal(sessionOverMax({ startedAt, durationSeconds: 0, maxSessionSeconds: 180 }), true);
});

function routeAgents() {
  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [DEMO_AGENT] }));
}

test('POST /api/avatar-token returns 503 and does not mint when the usage store fails', async () => {
  routeAgents();
  route(`${SB}/rest/v1/avatar_sessions`, () => ({ status: 500, body: { error: 'db down' } }));
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_should_not_mint', session_id: 'sess-nope' } },
  }));
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'usage_store_unavailable');
  assert.equal(heygenCalls().length, 0);
});

test('POST /api/avatar-token returns 402 when the platform monthly cap is reached, without minting', async () => {
  setEnv('AVATAR_MONTHLY_MINUTE_CAP', 60);
  routeAgents();
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'POST') return { body: [{ id: 'row-1' }] };
    // usage query
    return { body: [{ duration_seconds: 60 * 60 }] };
  });
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_should_not_mint', session_id: 'sess-nope' } },
  }));
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(heygenCalls().length, 0);
});

test('POST /api/avatar-token does not mint when the reservation insert fails', async () => {
  routeAgents();
  route(`${SB}/rest/v1/avatar_sessions`, (_url, init) => {
    if ((init.method || 'GET') === 'POST') return { status: 500, body: { error: 'insert failed' } };
    return { body: [] };
  });
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_tmp', session_id: 'sess-untracked' } },
  }));
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'usage_store_unavailable');
  assert.equal(heygenCalls().length, 0);
});

test('POST /api/avatar-token stops the minted LiveAvatar session and returns 503 if the row attach throws', async () => {
  let reserved = null;
  routeAgents();
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const method = init.method || 'GET';
    if (method === 'POST') {
      reserved = { id: 'row-1', status: 'pending', created_at: new Date().toISOString(), started_at: new Date().toISOString() };
      return { body: [reserved] };
    }
    if (method === 'PATCH') throw new TypeError('row write failed');
    if (url.includes('select=duration_seconds')) return { body: [] };
    if (url.includes('status=in.(active,pending)')) return { body: reserved ? [reserved] : [] };
    return { body: [] };
  });
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_tmp', session_id: 'sess-untracked' } },
  }));
  const stopped = [];
  route(`${LA}/v1/sessions/stop`, (_url, init) => {
    stopped.push(JSON.parse(init.body || '{}'));
    return { body: { success: true } };
  });
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'usage_store_unavailable');
  const minted = heygenCalls().filter((c) => c.url.includes('/v1/sessions/token'));
  assert.equal(minted.length, 1);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].session_id, 'sess-untracked');
});

test('session-end event=end stops the LiveAvatar session then closes the local row', async () => {
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'PATCH') return { body: [{ id: 'row-1', duration_seconds: 12, status: 'ended' }] };
    return { body: [{ id: 'row-1', status: 'active', started_at: new Date().toISOString(), duration_seconds: 10, liveavatar_session_id: 'la-end-1' }] };
  });
  const stopped = [];
  route(`${LA}/v1/sessions/stop`, (_url, init) => {
    stopped.push(JSON.parse(init.body || '{}'));
    return { body: { success: true } };
  });
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'row-1', duration_seconds: 12, event: 'end' },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.event, 'end');
  assert.equal(body.stopped, true);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].session_id, 'la-end-1');
});

test('heartbeat under the max only records a heartbeat and does not stop LiveAvatar', async () => {
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'PATCH') return { status: 200, body: '' };
    return { body: [{ id: 'row-1', status: 'active', started_at: new Date().toISOString(), duration_seconds: 20, liveavatar_session_id: 'la-hb-1' }] };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ body: { success: true } }));
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'row-1', duration_seconds: 20, event: 'heartbeat' },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.event, 'heartbeat');
  assert.equal(heygenCalls().length, 0);
});

test('heartbeat at the per-session max stops LiveAvatar and closes the row', async () => {
  setEnv('AVATAR_MAX_SESSION_SECONDS', 180);
  route(`${SB}/rest/v1/avatar_sessions`, (_url, init) => {
    if ((init.method || 'GET') === 'PATCH') return { body: [{ id: 'row-1', duration_seconds: 180, status: 'reaped' }] };
    return { body: [{ id: 'row-1', status: 'active', started_at: new Date(Date.now() - 180 * 1000).toISOString(), duration_seconds: 170, liveavatar_session_id: 'la-max-1' }] };
  });
  const stopped = [];
  route(`${LA}/v1/sessions/stop`, (_url, init) => {
    stopped.push(JSON.parse(init.body || '{}'));
    return { body: { success: true } };
  });
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'row-1', duration_seconds: 180, event: 'heartbeat' },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.event, 'stopped');
  assert.equal(body.reason, 'max_session');
  assert.equal(body.stopped, true);
  assert.equal(stopped[0].session_id, 'la-max-1');
});

test('reaper uses the env per-session max when listing stale sessions', async () => {
  setEnv('AVATAR_MAX_SESSION_SECONDS', 90);
  setEnv('AVATAR_HEARTBEAT_TIMEOUT_SECONDS', 30);
  let listedUrl = '';
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    listedUrl = url;
    if ((init.method || 'GET') === 'PATCH') return { body: [{ id: 'ok' }] };
    return { body: [] };
  });
  const res = await reaper();
  assert.equal(res.status, 200);
  // 90s and 30s windows appear as ISO cutoffs in the filter, not as minutes.
  assert.match(listedUrl, /started_at\.lt\./);
  assert.match(listedUrl, /last_heartbeat\.lt\./);
  const started = decodeURIComponent(/started_at\.lt\.([^,&)]+)/.exec(listedUrl)[1]);
  const idle = decodeURIComponent(/last_heartbeat\.lt\.([^,&)]+)/.exec(listedUrl)[1]);
  const startedAgo = (Date.now() - new Date(started).getTime()) / 1000;
  const idleAgo = (Date.now() - new Date(idle).getTime()) / 1000;
  assert.ok(startedAgo > 80 && startedAgo < 110, `hard cutoff ${startedAgo}s`);
  assert.ok(idleAgo > 20 && idleAgo < 50, `idle cutoff ${idleAgo}s`);
});
