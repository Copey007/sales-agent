// P1 rehome companion: aisdr (.a-gent.co) <-> Mission Control (.askarlen.com)
// cross-domain SSO peer routes, CORS for the new MC origin, link updates.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { allowedOrigins } from '../netlify/functions/_auth.mjs';
import { handleGate, sharedCookieDomain, safeNext } from '../netlify/edge-lib/gate-core.mjs';

const r = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const scriptOf = (html) => /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const ENV = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_dummy' };
const deps = () => ({
  env: (k) => ENV[k], fetchImpl: async () => new Response('{}', { status: 401 }),
  next: async () => new Response('DASHBOARD', { status: 200 }),
  title: 't', subtitle: 's', storageKey: 'agent_auth_session_v1', requireOperator: true,
  reviewUrl: 'https://missioncontrol.askarlen.com',
});

test('CORS default allowlist adds https://missioncontrol.askarlen.com and keeps the legacy MC origin', () => {
  const o = allowedOrigins();
  assert.ok(o.includes('https://missioncontrol.askarlen.com'));
  assert.ok(o.includes('https://missioncontrol.a-gent.co'));
});

test('aisdr gate serves /auth/handoff and /auth/logout (operator gate does not block them)', async () => {
  assert.match(r('netlify/edge-functions/aisdr-gate.js'), /'\/auth\/handoff', '\/auth\/logout'/);
  assert.match(r('netlify/edge-functions/aisdr-gate.js'), /reviewUrl: 'https:\/\/missioncontrol\.askarlen\.com'/);
  const h = await handleGate(new Request('https://aisdr.a-gent.co/auth/handoff'), deps());
  assert.equal(h.status, 200);
  assert.doesNotMatch(await h.text(), /DASHBOARD/);
  const lo = await handleGate(new Request('https://aisdr.a-gent.co/auth/logout?next=' + encodeURIComponent('https://missioncontrol.askarlen.com/')), deps());
  assert.equal(lo.status, 200);
  const sc = lo.headers.getSetCookie();
  assert.equal(sc.filter((c) => c.includes('Domain=.a-gent.co')).length, 2);
  assert.equal(sc.filter((c) => !c.includes('Domain=')).length, 2);
  assert.match(await lo.text(), /"next":"https:\/\/missioncontrol\.askarlen\.com\/"/);
  assert.equal(sharedCookieDomain('aisdr.a-gent.co'), '.a-gent.co');
  assert.equal(safeNext('https://evil.example/'), '/');
});

function authGateSandbox(href, cookie = '') {
  const u = new URL(href);
  const writes = []; const ls = new Map(); const listeners = {};
  ls.set('agent_auth_session_v1', JSON.stringify({ access_token: 'AT', refresh_token: 'RT_LS', expires_at: Math.floor(Date.now() / 1000) + 3000, email: 'm@x' }));
  const location = { hostname: u.hostname, href: u.href, origin: u.origin, pathname: u.pathname };
  const ctx = {
    location, URL, JSON, Math, Date, Promise, Object, Headers, encodeURIComponent, decodeURIComponent, console,
    document: {
      currentScript: { dataset: { supabaseUrl: 'https://test.supabase.co', supabaseKey: 'sb_publishable_x' } },
      set cookie(v) { writes.push(v); }, get cookie() { return cookie; },
      addEventListener: (t, fn) => { listeners[t] = fn; }, body: null, getElementById: () => null,
    },
    localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: (k) => ls.delete(k) },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  ctx.window = ctx; ctx.fetch = async () => ({ ok: true, json: async () => ({}) });
  vm.runInNewContext(r('auth-gate.js'), ctx);
  return { ctx, writes, ls, listeners };
}

test('auth-gate.js: handoff to MC puts the refresh token ONLY in the fragment and relinquishes it locally', () => {
  const b = authGateSandbox('https://aisdr.a-gent.co/', 'agent_rt=RT_COOKIE');
  const url = b.ctx.AGENT_AUTH.ssoHandoffUrl('https://missioncontrol.askarlen.com/some/path?x=1');
  assert.equal(url, 'https://missioncontrol.askarlen.com/auth/handoff#rt=RT_COOKIE&next=%2Fsome%2Fpath%3Fx%3D1');
  assert.equal(new URL(url).search, '');
  assert.equal(JSON.parse(b.ls.get('agent_auth_session_v1')).refresh_token, '');
  assert.ok(b.writes.some((w) => w.startsWith('agent_rt=;') && w.includes('Domain=.a-gent.co') && w.includes('Max-Age=0')));
  assert.ok(b.writes.some((w) => w.startsWith('agent_rt=;') && !w.includes('Domain=')));
  // Same cookie domain or non-peer hosts: plain link, no token.
  assert.equal(b.ctx.AGENT_AUTH.ssoHandoffUrl('https://fleet.a-gent.co/'), 'https://fleet.a-gent.co/');
  assert.equal(b.ctx.AGENT_AUTH.ssoHandoffUrl('https://evil.example/'), 'https://evil.example/');
  assert.equal(typeof b.listeners.click, 'function');
});

test('auth-gate.js: host-aware cookie Domain + two-domain sign-out via MC /auth/logout with Supabase revoke', () => {
  const s = r('auth-gate.js');
  const fn = /function cookieDomain\(\)\{[^\n]*?return '';\}/.exec(s)[0];
  for (const [h, want] of [['aisdr.a-gent.co', '; Domain=.a-gent.co'], ['missioncontrol.askarlen.com', '; Domain=.askarlen.com'], ['a-gent-ai-sdr.netlify.app', ''], ['localhost', '']]) {
    assert.equal(vm.runInNewContext(fn + ';cookieDomain()', { location: { hostname: h } }), want, h);
  }
  assert.match(s, /SSO_LOGOUT_PEER = 'https:\/\/missioncontrol\.askarlen\.com\/auth\/logout'/);
  assert.match(s, /\/auth\/v1\/logout\?scope=local/);
  assert.doesNotMatch(s, /auth\/handoff\?/);
});

test('MC links point at https://missioncontrol.askarlen.com (gated headers use SSO handoff)', () => {
  assert.match(r('index.html'), /href="https:\/\/missioncontrol\.askarlen\.com\/" data-sso-handoff/);
  assert.match(r('dashboard/index.html'), /href="https:\/\/missioncontrol\.askarlen\.com\/" target="_blank" rel="noopener" data-sso-handoff/);
  for (const f of ['signup.html', 'workers.html', 'pricing.html', 'offers-demo.html', 'netlify/functions/billing-checkout.mjs', 'netlify/functions/worker-runtime.mjs', 'index.html', 'dashboard/index.html']) {
    assert.doesNotMatch(r(f), /missioncontrol\.a-gent\.co/, f);
  }
});
