// AISDR rehome to aisdr.askarlen.com + nav audit: page-only 301s, API/webhook/
// embed paths untouched on both hosts, CORS, cookie-first refresh, no a-gent.co links.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowedOrigins } from '../netlify/functions/_auth.mjs';
import { handleGate } from '../netlify/edge-lib/gate-core.mjs';

const r = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const AGENT_URL = /https?:\/\/(?:[a-z0-9-]+\.)*a-gent\.co\b|https?:\/\/a-gent-[a-z0-9-]+\.netlify\.app/gi;
const SERVED = ['index.html', 'dashboard/index.html', 'pricing.html', 'offers-demo.html', 'workers.html', 'signup.html', 'demo.html', 'demo-live.html', 'concierge.html', 'copilot.html', 'agent.html', '404.html', 'auth-gate.js'];

test('served pages + auth-gate.js contain zero a-gent.co / a-gent-*.netlify.app URLs', () => {
  for (const f of SERVED) assert.deepEqual(r(f).match(AGENT_URL) || [], [], f);
});

test('AISDR header: no stray a-gent.co item; brand → askarlen.com; Fleet/CRM/MC on askarlen hosts', () => {
  for (const f of ['index.html', 'dashboard/index.html']) {
    const s = r(f);
    assert.doesNotMatch(s, />a-gent\.co<\/a>/, f);
    assert.match(s, /class="brand-home" href="https:\/\/askarlen\.com\/"/, f);
    assert.match(s, /const CRM_URL='https:\/\/crm\.askarlen\.com\/';/, f);
    assert.match(s, /LAUNCH_URL = 'https:\/\/fleet\.askarlen\.com\/login'/, f);
  }
  assert.match(r('index.html'), /href="https:\/\/fleet\.askarlen\.com\/">Fleet<\/a>/);
});

const ENV = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_dummy' };
const gateDeps = () => {
  const src = r('netlify/edge-functions/aisdr-gate.js');
  assert.match(src, /canonicalHosts: \{ 'aisdr\.a-gent\.co': 'aisdr\.askarlen\.com' \}/);
  assert.match(src, /canonicalExcept: \['\/auth\/\*'\]/);
  return {
    env: (k) => ENV[k], fetchImpl: async () => new Response('{}', { status: 401 }), next: async () => new Response('DASH', { status: 200 }),
    title: 't', subtitle: 's', storageKey: 'agent_auth_session_v1', requireOperator: true,
    canonicalHosts: { 'aisdr.a-gent.co': 'aisdr.askarlen.com' }, canonicalExcept: ['/auth/*'],
  };
};

test('aisdr-gate: legacy host 301s gated page GETs (path + query), never POST or /auth/*', async () => {
  for (const p of ['/', '/index.html?x=1', '/dashboard/foo?y=2']) {
    const res = await handleGate(new Request('https://aisdr.a-gent.co' + p), gateDeps());
    assert.equal(res.status, 301, p);
    assert.equal(res.headers.get('location'), 'https://aisdr.askarlen.com' + p);
  }
  const post = await handleGate(new Request('https://aisdr.a-gent.co/', { method: 'POST' }), gateDeps());
  assert.equal(post.status, 200, 'POST passes through');
  assert.equal((await handleGate(new Request('https://aisdr.a-gent.co/auth/handoff'), gateDeps())).status, 200);
  assert.equal((await handleGate(new Request('https://aisdr.a-gent.co/auth/logout'), gateDeps())).status, 200);
  assert.equal((await handleGate(new Request('https://aisdr.askarlen.com/'), gateDeps())).status, 401);
  assert.equal((await handleGate(new Request('https://a-gent-ai-sdr.netlify.app/'), gateDeps())).status, 401);
  // The gate only runs on these paths; /api/*, /a/*, widgets are never edge-intercepted.
  const cfg = /path: \[([^\]]*)\]/.exec(r('netlify/edge-functions/aisdr-gate.js'))[1];
  assert.doesNotMatch(cfg, /\/api|\/a\/|\.netlify|concierge|unsubscribe|webhook/);
});

test('netlify.toml: legacy-host 301 only for public marketing pages; never API/functions/embeds/webhooks', () => {
  const toml = r('netlify.toml');
  const rules = [...toml.matchAll(/from = "https:\/\/aisdr\.a-gent\.co([^"]*)"\s*to = "https:\/\/aisdr\.askarlen\.com([^"]*)"\s*status = 301\s*force = true/g)];
  assert.deepEqual(rules.map((m) => m[1]).sort(), ['/offers-demo.html', '/pricing', '/pricing.html', '/signup', '/signup.html', '/workers.html']);
  for (const m of rules) assert.equal(m[1], m[2]);
  assert.doesNotMatch(toml, /from = "https:\/\/aisdr\.a-gent\.co\/(\*|api|\.netlify|a\/|concierge|copilot|demo|agent)/);
  // Host rules precede the generic /signup and /pricing rewrites.
  assert.ok(toml.indexOf('from = "https://aisdr.a-gent.co/signup"') < toml.indexOf('from = "/signup"'));
});

test('CORS: aisdr.askarlen.com, fleet.askarlen.com and both MC hosts allowed; legacy kept', () => {
  const o = allowedOrigins();
  for (const x of ['https://aisdr.askarlen.com', 'https://fleet.askarlen.com', 'https://missioncontrol.askarlen.com', 'https://missioncontrol.a-gent.co', 'https://aisdr.a-gent.co', 'https://askarlen.com', 'https://app.askarlen.com']) assert.ok(o.includes(x), x);
});

test('auth-gate.js: refresh prefers the shared cookie token; cross-domain logout bounce only off .askarlen.com', () => {
  const s = r('auth-gate.js');
  assert.match(s, /var rtok = readCookie\('agent_rt'\) \|\| \(session && session\.refresh_token\) \|\| '';/);
  assert.match(s, /if \(cookieDomain\(\) !== '; Domain=\.askarlen\.com'\) location\.href = SSO_LOGOUT_PEER/);
});

test('new tenant agent URLs and plan CTA use AskArlen hosts', () => {
  assert.match(r('netlify/functions/signup.mjs'), /agent_url: `https:\/\/aisdr\.askarlen\.com\/a\/\$\{slug\}`/);
  assert.match(r('netlify/functions/provision-agent.mjs'), /agent_url: `https:\/\/aisdr\.askarlen\.com\/a\/\$\{b\.slug\}`/);
  assert.match(r('netlify/functions/_plans.mjs'), /ctaHref: 'https:\/\/askarlen\.com\/demo'/);
});
