// Fail-closed operator admin sub-accounts directory.
import './helpers/env.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetFetch, route, req, calls, SB } from './helpers/env.mjs';
import {
  parseFilters, matchesFilters, countByTenantStatus, sanitizeMembers, shapeTenant,
} from '../netlify/functions/admin-subaccounts.mjs';
import {
  sharedCookieDomain, cookieAttributeSuffix, clearCookieSetCookieValues,
  clearAuthCookieSetCookieValues, COOKIE, COOKIE_RT,
} from '../netlify/edge-lib/gate-core.mjs';
import { handleGate, loginShell } from '../netlify/edge-lib/gate-core.mjs';

const USERS = {
  ops: { id: 'u-ops', email: 'ops@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
  member: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: '2026-01-01T00:00:00Z' },
  unconfirmed: { id: 'u-ops', email: 'ops@example.com' },
};
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const URL = 'https://aisdr.example.test/api/admin-subaccounts';

const TENANTS = [
  { id: 't-agent', name: 'A-Gent', slug: 'a-gent', status: 'active', plan: 'growth', created_at: '2026-01-01T00:00:00Z' },
  { id: 't-rgtm', name: 'RefoundGTM', slug: 'refoundgtm', status: 'active', plan: 'starter', created_at: '2026-11-27T00:00:00Z' },
];
const MEMBERSHIPS = [
  { tenant_id: 't-agent', user_id: 'u-ops', role: 'owner' },
  { tenant_id: 't-rgtm', user_id: 'u-mem', role: 'owner' },
];
const OUTREACH = [
  { tenant_id: 't-rgtm', status: 'pending' },
  { tenant_id: 't-rgtm', status: 'pending' },
  { tenant_id: 't-rgtm', status: 'sent' },
  { tenant_id: 't-agent', status: 'rejected' },
];
const HIRES = [
  { tenant_id: 't-rgtm', status: 'active' },
  { tenant_id: 't-rgtm', status: 'paused' },
  { tenant_id: 't-agent', status: 'active' },
];

function mockDirectory() {
  resetFetch();
  route(`${SB}/auth/v1/user`, (_u, _i, h) => {
    const tok = (h.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = USERS[tok];
    return user ? { body: user } : { status: 401, body: { msg: 'invalid JWT' } };
  });
  route(`${SB}/rest/v1/tenants`, () => ({ body: TENANTS }));
  route(`${SB}/rest/v1/memberships`, () => ({ body: MEMBERSHIPS }));
  route(`${SB}/rest/v1/worker_outreach`, () => ({ body: OUTREACH }));
  route(`${SB}/rest/v1/workforce_hires`, () => ({ body: HIRES }));
  route(`${SB}/auth/v1/admin/users/`, (url) => {
    const id = url.split('/auth/v1/admin/users/')[1].split('?')[0];
    const emails = { 'u-ops': 'ops@example.com', 'u-mem': 'cust@acme.test' };
    if (!emails[id]) return { status: 404, body: { msg: 'not found' } };
    return { body: { id, email: emails[id] } };
  });
}

async function invoke() {
  return import('../netlify/functions/admin-subaccounts.mjs');
}
async function read(res) {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

test('parseFilters / matchesFilters support q, status, and plan', () => {
  const f = parseFilters('https://x.test/api/admin-subaccounts?q=Refound&status=active&plan=starter');
  assert.deepEqual(f, { q: 'refound', status: 'active', plan: 'starter' });
  assert.equal(matchesFilters(TENANTS[1], f), true);
  assert.equal(matchesFilters(TENANTS[0], f), false);
  assert.equal(matchesFilters(TENANTS[1], { q: 't-rgtm' }), true);
});

test('shapeTenant aggregates outreach and active workforce_hires and strips member extras', () => {
  const row = shapeTenant(TENANTS[1], {
    members: [{ email: 'cust@acme.test', role: 'owner', password: 'secret', access_token: 'tok' }],
    outreach: OUTREACH,
    hires: HIRES,
  });
  assert.equal(row.outreach_pending_count, 2);
  assert.equal(row.outreach_sent_count, 1);
  assert.equal(row.active_workers_count, 1);
  assert.equal(row.member_count, 1);
  assert.deepEqual(row.members, [{ email: 'cust@acme.test', role: 'owner' }]);
  assert.equal(JSON.stringify(row).includes('secret'), false);
  assert.equal(JSON.stringify(row).includes('access_token'), false);
  assert.equal(countByTenantStatus(OUTREACH, 't-rgtm', 'pending'), 2);
  assert.deepEqual(sanitizeMembers([{ email: '', role: 'admin', hash: 'x' }]), [{ email: null, role: 'admin' }]);
});

test('unauthenticated GET /api/admin-subaccounts → 401 and never lists tenants', async () => {
  mockDirectory();
  const mod = await invoke();
  const res = await read(await mod.default(req(URL), {}));
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'unauthorized');
  assert.equal(calls.filter((c) => c.url.includes('/rest/v1/tenants')).length, 0);
});

test('authenticated non-operator → 403 and never lists tenants', async () => {
  mockDirectory();
  const mod = await invoke();
  const res = await read(await mod.default(req(URL, { headers: bearer('member') }), {}));
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'forbidden');
  assert.equal(calls.filter((c) => c.url.includes('/rest/v1/tenants')).length, 0);
  assert.equal(calls.filter((c) => c.url.includes('/auth/v1/admin/users')).length, 0);
});

test('unconfirmed operator email → 403', async () => {
  mockDirectory();
  const mod = await invoke();
  const res = await read(await mod.default(req(URL, { headers: bearer('unconfirmed') }), {}));
  assert.equal(res.status, 403);
});

test('empty OPERATOR_EMAILS → 503 fail-closed', async () => {
  mockDirectory();
  const prev = process.env.OPERATOR_EMAILS;
  delete process.env.OPERATOR_EMAILS;
  try {
    const mod = await invoke();
    const res = await read(await mod.default(req(URL, { headers: bearer('ops') }), {}));
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'operators_not_configured');
    assert.equal(calls.filter((c) => c.url.includes('/rest/v1/tenants')).length, 0);
  } finally {
    process.env.OPERATOR_EMAILS = prev;
  }
});

test('operator GET returns every tenant with members and counts (filterable)', async () => {
  mockDirectory();
  const mod = await invoke();
  const all = await read(await mod.default(req(URL, { headers: bearer('ops') }), {}));
  assert.equal(all.status, 200);
  assert.equal(all.json.total, 2);
  assert.equal(all.json.tenants.length, 2);
  const rgtm = all.json.tenants.find((t) => t.slug === 'refoundgtm');
  assert.equal(rgtm.outreach_pending_count, 2);
  assert.equal(rgtm.outreach_sent_count, 1);
  assert.equal(rgtm.active_workers_count, 1);
  assert.deepEqual(rgtm.members, [{ email: 'cust@acme.test', role: 'owner' }]);
  const filtered = await read(await mod.default(req(URL + '?q=refound&status=active&plan=starter', { headers: bearer('ops') }), {}));
  assert.equal(filtered.status, 200);
  assert.equal(filtered.json.total, 1);
  assert.equal(filtered.json.tenants[0].slug, 'refoundgtm');
  assert.equal(JSON.stringify(all.json).includes('test-service-role-key'), false);
});

test('sharedCookieDomain only applies to *.a-gent.co module hosts', () => {
  assert.equal(sharedCookieDomain('aisdr.a-gent.co'), '.a-gent.co');
  assert.equal(sharedCookieDomain('missioncontrol.a-gent.co'), '.a-gent.co');
  assert.equal(sharedCookieDomain('fleet.a-gent.co'), '.a-gent.co');
  assert.equal(sharedCookieDomain('www.a-gent.co'), '.a-gent.co');
  assert.equal(sharedCookieDomain('aisdr.a-gent.co:443'), '.a-gent.co');
  assert.equal(sharedCookieDomain('a-gent.co'), '');
  assert.equal(sharedCookieDomain('localhost'), '');
  assert.equal(sharedCookieDomain('6b09d99c--magenta-kleicha-c9a1e6.netlify.app'), '');
});

test('clearCookieSetCookieValues expires both Domain=.a-gent.co and host-only cookies', () => {
  const vals = clearAuthCookieSetCookieValues('aisdr.a-gent.co', { httpOnly: true });
  assert.equal(vals.length, 4);
  for (const name of [COOKIE, COOKIE_RT]) {
    const withDomain = vals.filter((v) => v.startsWith(`${name}=`) && v.includes('Domain=.a-gent.co'));
    const hostOnly = vals.filter((v) => v.startsWith(`${name}=`) && !v.includes('Domain='));
    assert.equal(withDomain.length, 1);
    assert.equal(hostOnly.length, 1);
    assert.match(withDomain[0], /Max-Age=0/);
    assert.match(withDomain[0], /Secure/);
    assert.match(withDomain[0], /SameSite=Lax/);
    assert.match(withDomain[0], /HttpOnly/);
    assert.match(hostOnly[0], /Max-Age=0/);
    assert.match(hostOnly[0], /HttpOnly/);
  }
  const local = clearCookieSetCookieValues('agent_at', 'localhost');
  assert.equal(local.length, 1);
  assert.equal(local[0].includes('Domain='), false);
  assert.match(cookieAttributeSuffix({ maxAge: 10, domain: '.a-gent.co', httpOnly: true }), /Domain=\.a-gent\.co/);
});

function extractScript(html) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m && m[1], 'login shell must include a script block');
  return m[1];
}

test('loginShell script is valid (Function + node --check) and sets Domain=.a-gent.co with dual clear', async () => {
  const html = loginShell({
    title: 'T', subtitle: 'S', supabaseUrl: 'https://x.supabase.co',
    publicKey: 'sb_publishable_x', storageKey: 'k',
  });
  const script = extractScript(html);
  assert.equal(script.includes('replace(/^?/,'), false);
  assert.doesNotThrow(() => new Function(script));
  const dir = mkdtempSync(join(tmpdir(), 'login-shell-'));
  const file = join(dir, 'login-shell.js');
  writeFileSync(file, script);
  const checked = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(script, /\['\.a-gent\.co','\.askarlen\.com'\]/);
  assert.match(script, /writeCookie\(C\.cookie,'',0,true\)/);
  assert.match(script, /writeCookie\(C\.cookie,'',0,false\)/);
  assert.match(script, /writeCookie\('agent_rt','',0,true\)/);
  assert.match(script, /writeCookie\('agent_rt','',0,false\)/);
  assert.match(script, /readCookie\('agent_rt'\)/);
});

test('handleGate login shell still binds and includes the dual-clear cookie helpers', async () => {
  const r = await handleGate(new Request('https://aisdr.a-gent.co/'), {
    env: (k) => ({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_dummy', OPERATOR_EMAILS: 'ops@example.com' }[k]),
    fetchImpl: async () => new Response('{}', { status: 401 }),
    next: async () => new Response('protected', { status: 200 }),
    title: 'T', subtitle: 'S', storageKey: 'k', requireOperator: true,
  });
  assert.equal(r.status, 401);
  const script = extractScript(await r.text());
  assert.doesNotThrow(() => new Function(script));
});
