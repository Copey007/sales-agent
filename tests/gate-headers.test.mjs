// AG-08: aisdr dashboards are gated server-side (operator only) and every page
// carries security + noindex headers; anti-framing everywhere except the
// documented hosted-avatar widget exception.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleGate } from '../netlify/edge-lib/gate-core.mjs';

const ADMIN = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ENV = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_dummy', OPERATOR_EMAILS: 'ops@example.com' };
const USERS = {
  op: { id: 'u1', email: 'ops@example.com', email_confirmed_at: '2026-01-01' },
  cust: { id: 'u2', email: 'cust@acme.test', email_confirmed_at: '2026-01-01' },
  opUnconfirmed: { id: 'u3', email: 'ops@example.com' },
};
const fetchImpl = async (url, init) => {
  const tok = (init.headers.Authorization || '').replace('Bearer ', '');
  return USERS[tok] ? new Response(JSON.stringify(USERS[tok])) : new Response('{}', { status: 401 });
};
const deps = (env = ENV) => ({ env: (k) => env[k], fetchImpl, next: async () => new Response(ADMIN, { headers: { 'Content-Type': 'text/html' } }),
  title: 'A-Gent Fleet — Operator sign-in', subtitle: 'Operator access only.', storageKey: 'agent_auth_session_v1', requireOperator: true });
const get = (headers = {}, path = '/') => new Request(`https://aisdr.a-gent.co${path}`, { headers });
const DASH_MARKERS = ['OPERATIONAL', 'SDR LIVE', 'campaign-orchestrator', 'auth-gate.js', 'rest/v1/'];

test('anonymous GET / → login shell only (no dashboard shell / LOADING)', async () => {
  const r = await handleGate(get(), deps());
  const html = await r.text();
  assert.equal(r.status, 401);
  for (const m of DASH_MARKERS) assert.equal(html.includes(m), false, m);
  assert.match(html, /<main[\s>]/); assert.match(html, /<h1[\s>]/);
});
test('signed-in non-operator → 403 login shell', async () => {
  const r = await handleGate(get({ Cookie: 'agent_at=cust' }), deps());
  assert.equal(r.status, 403);
  assert.equal((await r.text()).includes('campaign-orchestrator'), false);
});
test('unconfirmed operator email → refused', async () => {
  assert.equal((await handleGate(get({ Cookie: 'agent_at=opUnconfirmed' }), deps())).status, 403);
});
test('no OPERATOR_EMAILS configured → nobody passes (fail closed)', async () => {
  assert.equal((await handleGate(get({ Cookie: 'agent_at=op' }), deps({ ...ENV, OPERATOR_EMAILS: '' }))).status, 403);
});
test('verified operator → dashboard served, no-store', async () => {
  const r = await handleGate(get({ Cookie: 'agent_at=op' }), deps());
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('campaign-orchestrator'));
  assert.equal(r.headers.get('cache-control'), 'no-store, private');
});
test('gate falls back to SUPABASE_ANON_KEY but never to the service-role key', async () => {
  const env = { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', OPERATOR_EMAILS: 'ops@example.com' };
  const r = await handleGate(get(), deps(env));
  assert.equal(r.status, 503);
  assert.equal((await r.text()).includes('sb_secret_x'), false);
});
test('edge gate covers /, /index.html, /index and /dashboard/*; public pages are not gated', () => {
  const src = readFileSync(new URL('../netlify/edge-functions/aisdr-gate.js', import.meta.url), 'utf8');
  const paths = JSON.parse(/path:\s*(\[[^\]]*\])/.exec(src)[1].replace(/'/g, '"'));
  for (const p of ['/', '/index.html', '/index', '/dashboard', '/dashboard/*']) assert.ok(paths.includes(p), p);
  for (const p of ['/signup', '/signup.html', '/offers-demo.html', '/agent.html', '/a/*', '/api/*']) assert.equal(paths.includes(p), false, p);
});

// ── headers ──
const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
const blocks = [...toml.matchAll(/\[\[headers\]\]\s*\n\s*for = "([^"]+)"\s*\n\s*\[headers\.values\]\n((?:\s+[A-Za-z-]+ = ".*"\n?)+)/g)]
  .map((m) => ({ for: m[1], values: Object.fromEntries([...m[2].matchAll(/([A-Za-z-]+) = "(.*)"/g)].map((x) => [x[1], x[2]])) }));
const forPath = (p) => blocks.filter((b) => b.for === p || (b.for.endsWith('/*') && p.startsWith(b.for.slice(0, -1))));
const merged = (p) => Object.assign({}, ...forPath(p).map((b) => b.values));

for (const p of ['/', '/index.html', '/dashboard/index.html', '/signup.html', '/workers.html', '/offers-demo.html', '/auth-gate.js', '/concierge.html']) {
  test(`headers on ${p}: DENY framing + nosniff + referrer + noindex`, () => {
    const h = merged(p);
    assert.equal(h['X-Frame-Options'], 'DENY');
    assert.equal(h['Content-Security-Policy'], "frame-ancestors 'none'");
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin');
    assert.equal(h['X-Robots-Tag'], 'noindex, nofollow');
  });
}
for (const p of ['/agent.html', '/a/acme']) {
  test(`documented exception: ${p} (hosted avatar widget) stays embeddable but noindex/nosniff`, () => {
    const h = merged(p);
    assert.equal(h['X-Frame-Options'], undefined);
    assert.equal(h['Content-Security-Policy'], undefined);
    assert.equal(h['X-Robots-Tag'], 'noindex, nofollow');
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
  });
}
test('exception is documented with a MARK decision marker', () => {
  assert.match(toml, /\{\{MARK: allow customer-site iframe embedding of \/a\/<slug>\?/);
});

test('login shell carries anti-framing / nosniff headers (edge responses skip netlify.toml headers)', async () => {
  const r = await handleGate(get(), deps());
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});
