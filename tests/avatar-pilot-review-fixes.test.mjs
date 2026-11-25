// Review fixes for the A-Gent avatar week-1 PR: deleted public start path,
// server-side duration, retryable stops, reservation-before-mint, cap clamps.
// Fetch is fully mocked — no real HeyGen or LiveAvatar calls.
import './helpers/env.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetFetch, route, req, calls, SB } from './helpers/env.mjs';
import {
  getAvatarCaps,
  serverDurationSeconds,
  DEFAULT_MONTHLY_MINUTE_CAP,
  DEFAULT_MAX_SESSION_SECONDS,
  DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
  MAX_MONTHLY_MINUTE_CAP,
  MAX_MAX_SESSION_SECONDS,
  MAX_HEARTBEAT_TIMEOUT_SECONDS,
} from '../netlify/functions/_avatar-caps.mjs';

process.env.LIVEAVATAR_API_KEY = 'test-liveavatar-key';

const token = (await import('../netlify/functions/avatar-token.mjs')).default;
const sessionEnd = (await import('../netlify/functions/avatar-session-end.mjs')).default;
const reaper = (await import('../netlify/functions/avatar-reaper.mjs')).default;

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

function heygenCalls() {
  return calls.filter((c) => /api\.liveavatar\.com|api\.heygen\.com/i.test(c.url));
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

function routeAgents() {
  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [DEMO_AGENT] }));
}

// ── B1: public uncapped start path is gone ─────────────────────────────────

test('avatar-session.mjs is deleted and netlify.toml has no /api/avatar-session route', () => {
  assert.equal(existsSync(join(ROOT, 'netlify/functions/avatar-session.mjs')), false);
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  assert.doesNotMatch(toml, /\/api\/avatar-session[^\-]/);
  assert.doesNotMatch(toml, /path\s*=\s*['\"]\/api\/avatar-session['\"]/);
  const reaperSrc = readFileSync(join(ROOT, 'netlify/functions/avatar-reaper.mjs'), 'utf8');
  assert.doesNotMatch(reaperSrc, /avatar-session\.mjs/);
  assert.doesNotMatch(reaperSrc, /export const config\s*=\s*\{\s*schedule/);
});

// ── Nits: floor-then-positive env + upper bounds ───────────────────────────

test('fractional env caps like 0.5 fall back to defaults instead of rounding to 0', () => {
  setEnv('AVATAR_MONTHLY_MINUTE_CAP', '0.5');
  setEnv('AVATAR_MAX_SESSION_SECONDS', '0.5');
  setEnv('AVATAR_HEARTBEAT_TIMEOUT_SECONDS', '0.5');
  const caps = getAvatarCaps();
  assert.equal(caps.monthlyMinuteCap, DEFAULT_MONTHLY_MINUTE_CAP);
  assert.equal(caps.maxSessionSeconds, DEFAULT_MAX_SESSION_SECONDS);
  assert.equal(caps.heartbeatTimeoutSeconds, DEFAULT_HEARTBEAT_TIMEOUT_SECONDS);
});

test('env caps are clamped to an upper bound', () => {
  setEnv('AVATAR_MONTHLY_MINUTE_CAP', '1e9');
  setEnv('AVATAR_MAX_SESSION_SECONDS', '1e9');
  setEnv('AVATAR_HEARTBEAT_TIMEOUT_SECONDS', '1e9');
  const caps = getAvatarCaps({ monthly_minute_cap: 1e9 });
  assert.equal(caps.monthlyMinuteCap, MAX_MONTHLY_MINUTE_CAP);
  assert.equal(caps.maxSessionSeconds, MAX_MAX_SESSION_SECONDS);
  assert.equal(caps.heartbeatTimeoutSeconds, MAX_HEARTBEAT_TIMEOUT_SECONDS);
});

test('serverDurationSeconds uses elapsed wall time and ignores a too-small client report, capped at the max', () => {
  const startedAt = new Date(Date.now() - 170_000).toISOString();
  const dur = serverDurationSeconds({ started_at: startedAt }, 1, 180);
  assert.ok(dur >= 169 && dur <= 172, `expected ~170, got ${dur}`);
  const capped = serverDurationSeconds({ started_at: new Date(Date.now() - 500_000).toISOString() }, 9999, 180);
  assert.equal(capped, 180);
});

// ── B2: server duration; heartbeat/end only update active rows ─────────────

test('session-end writes server-computed duration, not the under-reported client value', async () => {
  const startedAt = new Date(Date.now() - 170_000).toISOString();
  const patches = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'PATCH') {
      patches.push({ url, body: JSON.parse(init.body || '{}') });
      return { body: [{ id: 'row-1', duration_seconds: 170, status: 'ended' }] };
    }
    return { body: [{ id: 'row-1', status: 'active', started_at: startedAt, duration_seconds: 1, liveavatar_session_id: 'la-dur-1' }] };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ body: { success: true } }));
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'row-1', duration_seconds: 1, event: 'end' },
  }));
  assert.equal(res.status, 200);
  assert.equal(patches.length, 1);
  assert.match(patches[0].url, /status=in\.\(active,pending\)/);
  assert.ok(patches[0].body.duration_seconds >= 169 && patches[0].body.duration_seconds <= 172, patches[0].body.duration_seconds);
});

test('heartbeat on an already-ended row does not write and does not stop LiveAvatar', async () => {
  const patches = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'PATCH') {
      patches.push({ url, body: init.body });
      return { body: [{ id: 'row-1' }] };
    }
    return { body: [{ id: 'row-1', status: 'ended', started_at: new Date().toISOString(), duration_seconds: 12, liveavatar_session_id: 'la-ended' }] };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ body: { success: true } }));
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'row-1', duration_seconds: 20, event: 'heartbeat' },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.event, 'already_ended');
  assert.equal(patches.length, 0);
  assert.equal(heygenCalls().length, 0);
});

test('heartbeat under the max PATCHes only active rows', async () => {
  const patches = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'PATCH') {
      patches.push(url);
      return { status: 200, body: '' };
    }
    return { body: [{ id: 'row-1', status: 'active', started_at: new Date().toISOString(), duration_seconds: 20, liveavatar_session_id: 'la-hb-1' }] };
  });
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'row-1', duration_seconds: 20, event: 'heartbeat' },
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).event, 'heartbeat');
  assert.equal(patches.length, 1);
  assert.match(patches[0], /status=eq\.active/);
});

// ── B3 / session-end: stop failure must not close the row ──────────────────

test('session-end leaves the row open and returns 502 when the LiveAvatar stop fails', async () => {
  const patches = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'PATCH') {
      patches.push(url);
      return { body: [{ id: 'row-1', status: 'ended' }] };
    }
    return { body: [{ id: 'row-1', status: 'active', started_at: new Date().toISOString(), duration_seconds: 10, liveavatar_session_id: 'la-end-1' }] };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ status: 502, body: { error: 'upstream' } }));
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'row-1', duration_seconds: 12, event: 'end' },
  }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'stop_failed');
  assert.equal(patches.length, 0);
});

test('reaper treats a 404 stop as success and then closes the local row', async () => {
  const patches = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if ((init.method || 'GET') === 'PATCH') {
      patches.push(url);
      return { body: [{ id: 'r1' }] };
    }
    return { body: [{ id: 'r1', liveavatar_session_id: 'la-gone', started_at: '2020-01-01T00:00:00Z', last_heartbeat: '2020-01-01T00:00:00Z', duration_seconds: 10 }] };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ status: 404, body: { error: 'not found' } }));
  const res = await reaper();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stopped, 1);
  assert.equal(body.reaped, 1);
  assert.equal(patches.length, 1);
});

// ── S3: session-end uses only the row's session id ─────────────────────────

test('session-end ignores a client-supplied session_id and does not stop a spoofed id when the row is missing', async () => {
  route(`${SB}/rest/v1/avatar_sessions`, () => ({ body: [] }));
  const stopped = [];
  route(`${LA}/v1/sessions/stop`, (_url, init) => {
    stopped.push(JSON.parse(init.body || '{}'));
    return { body: { success: true } };
  });
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'nonexistent', session_id: 'victim-uuid', duration_seconds: 5, event: 'end' },
  }));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'session_not_found');
  assert.equal(stopped.length, 0);
  assert.equal(heygenCalls().length, 0);
});

test('session-end stops only the row liveavatar_session_id, not a spoofed client session_id', async () => {
  const stopped = [];
  route(`${SB}/rest/v1/avatar_sessions`, (_url, init) => {
    if ((init.method || 'GET') === 'PATCH') return { body: [{ id: 'row-1', status: 'ended', duration_seconds: 5 }] };
    return { body: [{ id: 'row-1', status: 'active', started_at: new Date().toISOString(), duration_seconds: 5, liveavatar_session_id: 'la-real' }] };
  });
  route(`${LA}/v1/sessions/stop`, (_url, init) => {
    stopped.push(JSON.parse(init.body || '{}'));
    return { body: { success: true } };
  });
  const res = await sessionEnd(req('https://aisdr.example.test/api/avatar-session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { session_row: 'row-1', session_id: 'victim-uuid', duration_seconds: 5, event: 'end' },
  }));
  assert.equal(res.status, 200);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].session_id, 'la-real');
});

// ── S2: reservation-before-mint closes the concurrency race ────────────────

test('concurrent token requests mint at most max_concurrent sessions', async () => {
  routeAgents();
  const rows = [];
  let seq = 0;
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const method = init.method || 'GET';
    if (method === 'POST') {
      return new Promise((resolve) => {
        setTimeout(() => {
          const id = `row-${++seq}`;
          const row = {
            id,
            status: 'pending',
            created_at: new Date(Date.now() + seq).toISOString(),
            started_at: new Date().toISOString(),
          };
          rows.push(row);
          resolve({ body: [row] });
        }, 15);
      });
    }
    if (method === 'PATCH') {
      const id = /id=eq\.([^&]+)/.exec(url)?.[1];
      const patch = JSON.parse(init.body || '{}');
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return { body: row ? [row] : [] };
    }
    if (url.includes('select=duration_seconds')) return { body: [] };
    if (url.includes('status=in.(active,pending)')) {
      return {
        body: rows
          .filter((r) => r.status === 'active' || r.status === 'pending')
          .slice()
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id))),
      };
    }
    return { body: [] };
  });
  let mint = 0;
  route(`${LA}/v1/sessions/token`, () => {
    mint += 1;
    return { body: { data: { session_token: `tok-${mint}`, session_id: `sess-${mint}` } } };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ body: { success: true } }));

  const results = await Promise.all(Array.from({ length: 8 }, () =>
    token(req('https://aisdr.example.test/api/avatar-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { slug: 'demo' },
    })),
  ));
  const statuses = await Promise.all(results.map(async (r) => ({ status: r.status, body: await r.json() })));
  const minted = heygenCalls().filter((c) => c.url.includes('/v1/sessions/token'));
  assert.equal(minted.length, 3, `minted ${minted.length}: ${JSON.stringify(statuses)}`);
  assert.equal(statuses.filter((s) => s.status === 200).length, 3);
  assert.equal(statuses.filter((s) => s.status === 503 && s.body.error === 'at_capacity').length, 5);
});

// ── IP: x-forwarded-for must not count toward the rate limit ───────────────

test('a spoofed x-forwarded-for header is ignored for the per-IP rate limit', async () => {
  routeAgents();
  const ipQueries = [];
  let reserved = null;
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const method = init.method || 'GET';
    if (url.includes('ip=eq.')) ipQueries.push(url);
    if (method === 'POST') {
      reserved = { id: 'row-1', status: 'pending', created_at: new Date().toISOString(), started_at: new Date().toISOString() };
      return { body: [reserved] };
    }
    if (method === 'PATCH') {
      reserved = { ...(reserved || { id: 'row-1' }), ...JSON.parse(init.body || '{}') };
      return { body: [reserved] };
    }
    if (url.includes('select=duration_seconds')) return { body: [] };
    if (url.includes('status=in.(active,pending)')) return { body: reserved ? [reserved] : [] };
    return { body: [] };
  });
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_test', session_id: 'sess-la-1' } },
  }));
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 200);
  assert.equal(ipQueries.length, 0);
});

test('x-nf-client-connection-ip is used for the per-IP rate limit', async () => {
  routeAgents();
  const ipQueries = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url) => {
    if (url.includes('ip=eq.')) ipQueries.push(url);
    return { body: [] };
  });
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_test', session_id: 'sess-la-1' } },
  }));
  // 5 recent sessions already from this IP — should 429 and not mint.
  // recentSessionCountByIp will see whatever we return; return 5 rows.
  resetFetch();
  routeAgents();
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    if (url.includes('ip=eq.')) {
      ipQueries.push(url);
      return { body: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] };
    }
    if ((init.method || 'GET') === 'POST') return { body: [{ id: 'should-not' }] };
    return { body: [] };
  });
  route(`${LA}/v1/sessions/token`, () => ({
    body: { data: { session_token: 'tok_test', session_id: 'sess-la-1' } },
  }));
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-nf-client-connection-ip': '198.51.100.7',
      'x-forwarded-for': '203.0.113.9',
    },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 429);
  assert.ok(ipQueries.some((u) => u.includes('ip=eq.198.51.100.7')));
  assert.ok(!ipQueries.some((u) => u.includes('203.0.113.9')));
  assert.equal(heygenCalls().length, 0);
});
