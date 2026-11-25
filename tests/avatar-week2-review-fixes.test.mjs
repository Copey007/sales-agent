// Review fixes for draft PR #16: local SDK bundle, missing-column reaper
// fallback, SDK 0.0.18 usage, tenant-keyed cool-down, authenticated caps.
// Fetch is fully mocked — no real HeyGen or LiveAvatar calls.
import './helpers/env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetFetch, route, req, calls, SB, mockAuth } from './helpers/env.mjs';
import {
  isUndefinedColumnError,
  listStaleSessions,
  recordStopFailure,
  cooldownRemainingSeconds,
} from '../netlify/functions/_avatar-store.mjs';
import {
  loadSdkThenMint,
  resetSdkLoader,
  attachToVideo,
  startAndAttach,
  setMuted,
  speakReply,
  askAGent,
  bindTranscriptEvents,
  createSessionEnder,
  isVideoElement,
  AgentEvents,
  SessionEvent,
  SDK_MODULE_PATH,
  SDK_VERSION,
} from '../avatar-side-panel/live-session.js';
import { ensureMicAccess, queryMicPermission, tryGetUserMedia } from '../avatar-side-panel/mic-permission.js';
import { siteForUrl } from '../avatar-side-panel/allowed-sites.js';

process.env.LIVEAVATAR_API_KEY = 'test-liveavatar-key';

const token = (await import('../netlify/functions/avatar-token.mjs')).default;
const capsStatus = (await import('../netlify/functions/avatar-caps-status.mjs')).default;
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

beforeEach(() => resetFetch());

function heygenCalls() {
  return calls.filter((c) => /api\.liveavatar\.com|api\.heygen\.com/i.test(c.url));
}

const confirmed = '2026-01-01T00:00:00Z';
function authUser({ token: tok = 'mem', role = 'member', tenant = 't-1', email = 'cust@acme.test', id = 'u-mem' } = {}) {
  mockAuth(
    { [tok]: { id, email, email_confirmed_at: confirmed } },
    { [id]: [{ role, tenant_id: tenant, tenants: { id: tenant, slug: 'acme', name: 'Acme' } }] },
  );
}

function routeAgent(agent = DEMO_AGENT) {
  route(`${SB}/rest/v1/avatar_agents`, (url) => {
    const m = /slug=eq\.([^&]+)/.exec(url);
    const slug = m ? decodeURIComponent(m[1]) : agent.slug;
    if (slug !== agent.slug) return { body: [] };
    return { body: [agent] };
  });
}

// ── B1: local SDK, load before mint, no remote code ────────────────────────

test('SDK is vendored at 0.0.18 and the extension has no remote script imports', () => {
  const vendor = join(ROOT, 'avatar-side-panel/vendor/liveavatar-web-sdk.js');
  const note = readFileSync(join(ROOT, 'avatar-side-panel/vendor/VENDOR.md'), 'utf8');
  assert.equal(existsSync(vendor), true);
  assert.equal(SDK_VERSION, '0.0.18');
  assert.equal(SDK_MODULE_PATH, './vendor/liveavatar-web-sdk.js');
  assert.match(note, /0\.0\.18/);
  assert.match(note, /26dbaeb71334ac67aa9deb636756035d25c84f6bea6019ac0a003e0694ff7b51/);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'avatar-side-panel/manifest.json'), 'utf8'));
  assert.ok(!JSON.stringify(manifest).includes('esm.sh'));
  const skip = new Set(['vendor']);
  const hits = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!['.js', '.html', '.mjs', '.css', '.json'].includes(extname(name))) continue;
      const src = readFileSync(p, 'utf8');
      if (/import\s*\(\s*['"]https?:/i.test(src) || /from\s+['"]https?:/i.test(src) || /<script[^>]+src=["']https?:/i.test(src)) {
        hits.push(p);
      }
    }
  }
  walk(join(ROOT, 'avatar-side-panel'));
  assert.deepEqual(hits, []);
  const micHtml = readFileSync(join(ROOT, 'avatar-side-panel/mic-permission.html'), 'utf8');
  assert.doesNotMatch(micHtml, /<script(?![^>]*src=)[^>]*>\s*\S/i);
  assert.match(micHtml, /src="mic-permission-page.js"/);
  assert.equal(existsSync(join(ROOT, 'avatar-side-panel/mic-permission-page.js')), true);
});

test('a failed SDK load never calls mint', async () => {
  resetSdkLoader();
  let minted = 0;
  await assert.rejects(
    () => loadSdkThenMint({
      loadSdk: async () => { throw new Error('blocked by csp'); },
      mint: async () => { minted += 1; return { ok: true }; },
    }),
    /blocked by csp/,
  );
  assert.equal(minted, 0);
  const ok = await loadSdkThenMint({
    loadSdk: async () => ({ LiveAvatarSession: class {} }),
    mint: async () => { minted += 1; return { ok: true, token: 't' }; },
  });
  assert.equal(minted, 1);
  assert.equal(ok.minted.token, 't');
});

// ── B2: migration exists (not applied) and reaper falls back ───────────────

test('stop-alert migration file exists and isUndefinedColumnError detects 42703', () => {
  const sql = readFileSync(join(ROOT, 'migrations/2026-11-25-avatar-sessions-stop-alert.sql'), 'utf8');
  assert.match(sql, /stop_fail_count/);
  assert.match(sql, /stop_alerted_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/i);
  assert.match(sql, /Mark's go/);
  assert.match(sql, /SET lock_timeout/);
  assert.equal(isUndefinedColumnError(400, '{"code":"42703","message":"column avatar_sessions.stop_fail_count does not exist"}'), true);
  assert.equal(isUndefinedColumnError(400, 'schema cache'), true);
  assert.equal(isUndefinedColumnError(500, '42703'), false);
  assert.equal(isUndefinedColumnError(200, ''), false);
});

test('listStaleSessions falls back when stop-alert columns are missing', async () => {
  const row = {
    id: 'stale-1',
    status: 'active',
    started_at: new Date(Date.now() - 200_000).toISOString(),
    last_heartbeat: new Date(Date.now() - 120_000).toISOString(),
    liveavatar_session_id: 'la-1',
  };
  let fullSelects = 0;
  let baseSelects = 0;
  route(`${SB}/rest/v1/avatar_sessions`, (url) => {
    if (url.includes('stop_fail_count')) {
      fullSelects += 1;
      return { status: 400, body: { code: '42703', message: 'column avatar_sessions.stop_fail_count does not exist' } };
    }
    baseSelects += 1;
    return { body: [row] };
  });
  const rows = await listStaleSessions({ maxSessionSeconds: 180, heartbeatTimeoutSeconds: 60 });
  assert.equal(fullSelects, 1);
  assert.equal(baseSelects, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'stale-1');
  assert.equal(rows[0]._stopAlertColumnsMissing, true);
  assert.equal(rows[0].stop_fail_count, 0);
});

test('reaper still stops abandoned sessions when stop-alert columns are missing (no 500)', async () => {
  const started = new Date(Date.now() - 200_000).toISOString();
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const method = init.method || 'GET';
    if (method === 'PATCH') return { body: [{ id: 'stale-1', status: 'reaped' }] };
    if (url.includes('stop_fail_count')) {
      return { status: 400, body: { code: '42703', message: 'column avatar_sessions.stop_fail_count does not exist' } };
    }
    return {
      body: [{
        id: 'stale-1',
        status: 'active',
        started_at: started,
        last_heartbeat: started,
        liveavatar_session_id: 'la-1',
      }],
    };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ body: { ok: true } }));
  const res = await reaper();
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stopped, 1);
  assert.equal(body.reaped, 1);
  assert.equal(heygenCalls().filter((c) => c.url.includes('/v1/sessions/stop')).length, 1);
});

test('recordStopFailure only sets stop_alerted_at when alerted is true', async () => {
  const patches = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const body = JSON.parse(init.body || '{}');
    patches.push(body);
    return { body: [{ id: 's1', ...body }] };
  });
  await recordStopFailure('s1', { failCount: 3, alerted: false });
  await recordStopFailure('s1', { failCount: 5, alerted: true });
  await recordStopFailure('s1', { failCount: 6, alerted: false });
  assert.equal('stop_alerted_at' in patches[0], false);
  assert.ok(patches[1].stop_alerted_at);
  assert.equal('stop_alerted_at' in patches[2], false);
  assert.equal(patches[2].stop_fail_count, 6);
});

// ── B3 + S5: SDK 0.0.18 shape ──────────────────────────────────────────────

function fakeSession() {
  const calls = [];
  const handlers = {};
  return {
    calls,
    voiceChat: {
      isMuted: false,
      async mute() { this.isMuted = true; calls.push('mute'); },
      async unmute() { this.isMuted = false; calls.push('unmute'); },
    },
    attach(el) {
      if (!isVideoElement(el) && String(el?.tagName || '').toUpperCase() !== 'VIDEO') {
        throw new Error('attach expects HTMLMediaElement');
      }
      if (!this.started) throw new Error('Stream is not yet ready');
      calls.push(['attach', el.tagName]);
    },
    started: false,
    async start() { this.started = true; calls.push('start'); this.emit(SessionEvent.SESSION_STREAM_READY); },
    async stop() { calls.push('stop'); },
    message(text) { calls.push(['message', text]); return 'evt-1'; },
    repeat(text) { calls.push(['repeat', text]); return 'evt-2'; },
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, data) { handlers[ev]?.(data); },
  };
}

test('attach before start throws; startAndAttach waits for stream_ready, then attaches a video', async () => {
  const session = fakeSession();
  const host = {
    innerHTML: 'poster',
    querySelector: () => null,
    appendChild(el) { this.child = el; },
  };
  const make = (tag) => ({ tagName: tag.toUpperCase(), setAttribute() {}, autoplay: false, playsInline: false });
  assert.throws(() => attachToVideo(session, host, { createElement: make }), /Stream is not yet ready/);
  assert.equal(session.calls.some((c) => Array.isArray(c) && c[0] === 'attach'), false);
  const videoP = startAndAttach(session, host, { createElement: make });
  const video = await videoP;
  assert.equal(video.tagName, 'VIDEO');
  assert.ok(session.calls.includes('start'));
  const startAt = session.calls.indexOf('start');
  const attachAt = session.calls.findIndex((c) => Array.isArray(c) && c[0] === 'attach');
  assert.ok(startAt >= 0 && attachAt > startAt, JSON.stringify(session.calls));
});

test('mute uses voiceChat, and Ask uses concierge then repeat, not message', async () => {
  const session = fakeSession();
  assert.equal(await setMuted(session, true), true);
  assert.ok(session.calls.includes('mute'));
  assert.equal(session.voiceChat.isMuted, true);
  assert.equal(await setMuted(session, false), false);
  assert.ok(session.calls.includes('unmute'));
  let conciergeBody = null;
  const reply = await askAGent({
    text: 'What is the timeline?',
    history: [],
    slug: 'a-gent',
    session,
    askConcierge: async (body) => {
      conciergeBody = body;
      return 'We can start next week.';
    },
  });
  assert.equal(reply, 'We can start next week.');
  assert.equal(conciergeBody.action, 'chat');
  assert.equal(conciergeBody.speak, false);
  assert.equal(conciergeBody.slug, 'a-gent');
  assert.deepEqual(conciergeBody.messages, [{ role: 'user', content: 'What is the timeline?' }]);
  assert.ok(session.calls.some((c) => Array.isArray(c) && c[0] === 'repeat' && c[1] === 'We can start next week.'));
  assert.ok(!session.calls.some((c) => Array.isArray(c) && c[0] === 'message'));
  speakReply(session, 'Thanks.');
  assert.ok(session.calls.some((c) => Array.isArray(c) && c[0] === 'repeat' && c[1] === 'Thanks.'));
});

test('session ender sends AVATAR_END once and swallows a throwing stop()', async () => {
  const ender = createSessionEnder();
  let stops = 0;
  let ends = 0;
  const stop = async () => { stops += 1; throw new Error('already stopped'); };
  const sendEnd = async () => { ends += 1; };
  await Promise.all([
    ender.end({ session: {}, row: { id: 'r1' }, stop, sendEnd }),
    ender.end({ session: {}, row: { id: 'r1' }, stop, sendEnd }),
  ]);
  assert.equal(stops, 1);
  assert.equal(ends, 1);
  await ender.end({ session: {}, row: { id: 'r1' }, stop, sendEnd });
  assert.equal(ends, 1);
});

test('SDK transcription events are captured into the in-memory transcript', () => {
  const session = fakeSession();
  const captions = [];
  const speaks = [];
  bindTranscriptEvents(session, {
    onCaption: (who, text) => captions.push([who, text]),
    onSpeak: (kind) => speaks.push(kind),
  });
  session.emit(AgentEvents.USER_TRANSCRIPTION, { text: 'Hello there' });
  session.emit(AgentEvents.AVATAR_TRANSCRIPTION, { text: 'Hi, how can I help?' });
  session.emit(AgentEvents.AVATAR_TRANSCRIPTION, { text: '' });
  session.emit(AgentEvents.AVATAR_SPEAK_STARTED, {});
  session.emit(AgentEvents.AVATAR_SPEAK_ENDED, {});
  assert.deepEqual(captions, [
    ['You', 'Hello there'],
    ['A-Gent', 'Hi, how can I help?'],
  ]);
  assert.deepEqual(speaks, ['avatar-start', 'avatar-end']);
});

// ── S2: cool-down keyed by tenant or agent, not IP ─────────────────────────

test('cool-down is keyed by tenant, so a different IP on the same agent is still blocked', async () => {
  routeAgent();
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const method = init.method || 'GET';
    if (method === 'POST') return { body: [{ id: 'row-1', status: 'pending' }] };
    if (url.includes('tenant_id=eq.t-1') && url.includes('status=in.(ended,reaped)')) {
      return { body: [{ ended_at: new Date(Date.now() - 10_000).toISOString() }] };
    }
    if (url.includes('select=duration_seconds')) return { body: [] };
    if (url.includes('status=in.(active,pending)') && url.includes('select=id,status,created_at')) {
      return { body: [{ id: 'row-1', status: 'pending', created_at: new Date().toISOString() }] };
    }
    return { body: [] };
  });
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': '198.51.100.20' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'cooldown');
  assert.equal(heygenCalls().length, 0);
  const cool = calls.find((c) => c.url.includes('status=in.(ended,reaped)'));
  assert.ok(cool.url.includes('tenant_id=eq.t-1'), cool.url);
  assert.ok(!cool.url.includes('ip=eq.'), cool.url);
});

test('cool-down for one tenant does not block a different tenant', async () => {
  const left = await (async () => {
    route(`${SB}/rest/v1/avatar_sessions`, (url) => {
      if (url.includes('tenant_id=eq.t-1') && url.includes('ended,reaped')) {
        return { body: [{ ended_at: new Date(Date.now() - 5_000).toISOString() }] };
      }
      return { body: [] };
    });
    const other = await cooldownRemainingSeconds({
      tenantId: 't-2',
      slug: 'other',
      ip: '203.0.113.9',
      cooldownSeconds: 30,
    });
    const same = await cooldownRemainingSeconds({
      tenantId: 't-1',
      slug: 'demo',
      ip: '198.51.100.1',
      cooldownSeconds: 30,
    });
    return { other, same };
  })();
  assert.equal(left.other, 0);
  assert.ok(left.same >= 24 && left.same <= 30, left.same);
});

// ── S3: avatar-caps requires auth and is scoped ────────────────────────────

test('GET /api/avatar-caps is 401 without a login and never calls LiveAvatar', async () => {
  const res = await capsStatus(req('https://aisdr.example.test/api/avatar-caps?slug=demo', { method: 'GET' }));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'unauthorized');
  assert.equal(heygenCalls().length, 0);
  assert.equal(calls.filter((c) => c.url.includes('avatar_sessions')).length, 0);
});

test('GET /api/avatar-caps is scoped to the caller and returns can_buy without emails', async () => {
  authUser({ role: 'member', tenant: 't-1' });
  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [{ ...DEMO_AGENT, tenant_id: 't-9' }] }));
  const other = await capsStatus(req('https://aisdr.example.test/api/avatar-caps?slug=demo', {
    method: 'GET',
    headers: { Authorization: 'Bearer mem' },
  }));
  assert.equal(other.status, 404);

  resetFetch();
  authUser({ role: 'admin', tenant: 't-1' });
  routeAgent();
  route(`${SB}/rest/v1/avatar_sessions`, (url) => {
    if (url.includes('select=duration_seconds')) return { body: [{ duration_seconds: 60 }] };
    return { body: [] };
  });
  const res = await capsStatus(req('https://aisdr.example.test/api/avatar-caps?slug=demo', {
    method: 'GET',
    headers: { Authorization: 'Bearer mem' },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.can_buy, true);
  assert.equal(heygenCalls().length, 0);
  const dumped = JSON.stringify(body);
  assert.doesNotMatch(dumped, /@/);
  assert.doesNotMatch(dumped, /email/i);
  assert.ok(!('admins' in body) && !('admin_emails' in body));
});

test('GET /api/avatar-caps can_buy is false for a member, and no tenant-admins email endpoint exists', async () => {
  authUser({ role: 'member', tenant: 't-1' });
  routeAgent();
  route(`${SB}/rest/v1/avatar_sessions`, () => ({ body: [] }));
  const res = await capsStatus(req('https://aisdr.example.test/api/avatar-caps?slug=demo', {
    method: 'GET',
    headers: { Authorization: 'Bearer mem' },
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).can_buy, false);
  const fnDir = join(ROOT, 'netlify/functions');
  const names = readdirSync(fnDir);
  assert.ok(!names.some((n) => /tenant-admins/i.test(n)));
});

// ── S4 + S6: .mil dropped, mic permission helper ───────────────────────────

test('Salesforce GovCloud .mil hosts are not allowed', () => {
  assert.equal(siteForUrl('https://acme.lightning.crmforce.mil/lightning/r/Contact/001/view').allowed, false);
  const src = readFileSync(join(ROOT, 'avatar-side-panel/allowed-sites.js'), 'utf8');
  assert.doesNotMatch(src, /crmforce\.mil/);
});

test('mic permission opens the extension page when the side panel cannot grant it', async () => {
  let opened = 0;
  const denied = await ensureMicAccess({
    query: async () => 'denied',
    getUserMedia: async () => { throw new Error('not allowed'); },
    openPermissionPage: async () => { opened += 1; },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.openedPage, true);
  assert.equal(opened, 1);

  const granted = await ensureMicAccess({
    query: async () => 'granted',
    getUserMedia: async () => { throw new Error('should not run'); },
    openPermissionPage: async () => { opened += 1; },
  });
  assert.equal(granted.ok, true);
  assert.equal(opened, 1);

  const prompted = await ensureMicAccess({
    query: async () => 'prompt',
    getUserMedia: async () => true,
    openPermissionPage: async () => { opened += 1; },
  });
  assert.equal(prompted.ok, true);
  assert.equal(await queryMicPermission({ query: async () => ({ state: 'prompt' }) }), 'prompt');
  await tryGetUserMedia(async () => ({ getTracks: () => [{ stop() {} }] }));
});

test('docs cover External Client App, consent, no-BAA, and the pending retention / delete path', () => {
  const proposal = readFileSync(join(ROOT, 'docs/avatar-transcript-storage-proposal.md'), 'utf8');
  const plan = readFileSync(join(ROOT, 'docs/avatar-pilot-plan.md'), 'utf8');
  assert.match(proposal, /workspace-admin toggle/i);
  assert.match(proposal, /Save this conversation to \{Contact name\}/);
  assert.match(proposal, /LiveAvatar \/ HeyGen/);
  assert.match(proposal, /no BAA/i);
  assert.match(proposal, /health information/i);
  assert.match(proposal, /length-capped|length cap/i);
  assert.match(proposal, /full transcript/i);
  assert.match(proposal, /summary is optional/i);
  assert.match(proposal, /ContentNote/);
  assert.match(proposal, /delete path/i);
  assert.match(proposal, /Retention is pending Mark/i);
  assert.match(proposal, /External Client App/);
  assert.match(plan, /External Client App/);
  assert.doesNotMatch(plan.split('AppExchange')[0], /needs a \*\*Connected App\*\*/);
  assert.match(plan, /Drop `openid`/);
  assert.match(plan, /admin-approved users only/);
  const migration = readFileSync(join(ROOT, 'migrations/README.md'), 'utf8');
  assert.match(migration, /Apply the migration/);
  assert.match(migration, /Mark's approval/);
});
