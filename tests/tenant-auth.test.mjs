// Tenant resolver, operator allowlist, service-role helper, CORS + guards.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resetFetch, route, mockAuth, req, INTERNAL, SB, calls } from './helpers/env.mjs';

const T = await import('../netlify/functions/_tenant.mjs');
const R = await import('../netlify/functions/_supabase-rest.mjs');
const A = await import('../netlify/functions/_auth.mjs');

const confirmed = '2026-01-01T00:00:00Z';
const USERS = {
  op: { id: 'u-op', email: 'ops@example.com', email_confirmed_at: confirmed },
  opUnconfirmed: { id: 'u-op2', email: 'ops@example.com' },
  staff: { id: 'u-staff', email: 'someone@a-gent.co', email_confirmed_at: confirmed },
  member: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed },
  orphan: { id: 'u-orphan', email: 'nobody@bv.test', email_confirmed_at: confirmed },
};
const MEMBERS = { 'u-mem': [{ role: 'owner', tenant_id: 't-acme', tenants: { id: 't-acme', slug: 'acme', name: 'Acme' } }] };
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const U = 'https://aisdr.example.test/api/x';

function setup() { resetFetch(); mockAuth(USERS, MEMBERS); }

test('no token → 401 (no demo-tenant fallback)', async () => {
  setup();
  const c = await T.resolveTenantContext(req(U));
  assert.equal(c.invalid, true); assert.equal(c.status, 401); assert.equal(c.tenantId, null);
});
test('bad token → 401', async () => {
  setup();
  const c = await T.resolveTenantContext(req(U, { headers: bearer('garbage') }));
  assert.equal(c.invalid, true); assert.equal(c.status, 401);
});
test('allowlisted confirmed operator → master tenant', async () => {
  setup();
  const c = await T.resolveTenantContext(req(U, { headers: bearer('op') }));
  assert.equal(c.operator, true); assert.equal(c.tenantId, T.MASTER_TENANT_ID);
});
test('unconfirmed operator email is NOT an operator', async () => {
  setup();
  const c = await T.resolveTenantContext(req(U, { headers: bearer('opUnconfirmed') }));
  assert.notEqual(c.operator, true); assert.equal(c.invalid, true); assert.equal(c.status, 403);
});
test('@a-gent.co email without allowlist entry gets no operator rights', async () => {
  setup();
  const c = await T.resolveTenantContext(req(U, { headers: bearer('staff') }));
  assert.notEqual(c.operator, true); assert.equal(c.status, 403);
});
test('member → own tenant', async () => {
  setup();
  const c = await T.resolveTenantContext(req(U, { headers: bearer('member') }));
  assert.equal(c.tenantId, 't-acme'); assert.equal(c.invalid, false);
});
test('valid login without membership → 403 (was: master owner)', async () => {
  setup();
  const c = await T.resolveTenantContext(req(U, { headers: bearer('orphan') }));
  assert.equal(c.invalid, true); assert.equal(c.status, 403); assert.equal(c.tenantId, null);
});
test('internal token recognised; wrong internal token is not', async () => {
  setup();
  assert.equal((await T.resolveTenantContext(req(U, { headers: INTERNAL }))).internal, true);
  const bad = await T.resolveTenantContext(req(U, { headers: { 'X-Internal-Token': 'nope' } }));
  assert.equal(bad.internal, undefined); assert.equal(bad.status, 401);
});
test('empty OPERATOR_EMAILS → nobody is an operator', async () => {
  setup();
  const saved = process.env.OPERATOR_EMAILS; process.env.OPERATOR_EMAILS = '';
  try {
    const c = await T.resolveTenantContext(req(U, { headers: bearer('op') }));
    assert.notEqual(c.operator, true);
    const g = await T.requireOperator(req(U, { headers: bearer('op') }));
    assert.equal(g.response.status, 503);
  } finally { process.env.OPERATOR_EMAILS = saved; }
});
test('canAccessTenant scoping', () => {
  assert.equal(T.canAccessTenant({ tenantId: 't1' }, 't1'), true);
  assert.equal(T.canAccessTenant({ tenantId: 't1' }, 't2'), false);
  assert.equal(T.canAccessTenant({ tenantId: 't1' }, null), false);
  assert.equal(T.canAccessTenant({ operator: true }, 't2'), true);
});

test('serviceCreds fails closed without SUPABASE_SERVICE_ROLE_KEY (no anon fallback)', () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.throws(() => R.serviceCreds(), (e) => e instanceof R.SupabaseConfigError && e.status === 503);
  } finally { process.env.SUPABASE_SERVICE_ROLE_KEY = saved; }
  assert.equal(R.serviceCreds().key, 'test-service-role-key');
});
test('no server function falls back to SUPABASE_ANON_KEY for data access', () => {
  const dir = new URL('../netlify/functions/', import.meta.url);
  const offenders = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    if (/SUPABASE_SERVICE_ROLE_KEY'\)\s*\|\|\s*env\('SUPABASE_ANON_KEY'\)/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test('CORS: allowlisted origin echoed, others get no ACAO, never "*"', async () => {
  const h = A.withCors(async () => new Response('{}', { headers: { 'Access-Control-Allow-Origin': '*' } }));
  const ok = await h(req(U, { headers: { Origin: 'https://missioncontrol.a-gent.co' } }));
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://missioncontrol.a-gent.co');
  const evil = await h(req(U, { headers: { Origin: 'https://evil.test' } }));
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const pf = await h(req(U, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } }));
  assert.equal(pf.status, 204); assert.equal(pf.headers.get('access-control-allow-origin'), null);
});
test('safeEqual / secretMatches fail closed', () => {
  assert.equal(A.safeEqual('a', 'a'), true);
  assert.equal(A.safeEqual('a', 'b'), false);
  assert.equal(A.safeEqual('', ''), false);
  delete process.env.ADMIN_SECRET;
  assert.equal(A.secretMatches('anything', 'ADMIN_SECRET'), false);
});

// Guarded endpoints reject anonymous callers before doing any work.
const TENANT_FNS = ['campaign-orchestrator', 'enqueue-send', 'gtm-brain', 'hunter-find-email', 'researcher-find', 'researcher-scan', 'slide-narrate', 'slide-upload', 'worker-daily-report', 'worker-outreach', 'worker-runtime', 'workforce-hires', 'billing-checkout', 'campaign-admin'];
const OPERATOR_FNS = ['avatar-list', 'avatar-speak', 'tts', 'social-post', 'social-stats', 'gap-email-pipeline', 'gather-signals', 'generate-gap-email', 'gen-impl-video', 'billing-reconcile'];
for (const name of TENANT_FNS) {
  test(`tenant guard: ${name} → 401 anonymous, 403 no-membership`, async () => {
    setup();
    const mod = await import(`../netlify/functions/${name}.mjs`);
    const r1 = await mod.default(req(`https://aisdr.example.test/api/${name}`, { method: 'POST', body: {} }), {});
    assert.equal(r1.status, 401, `${name} anon`);
    const r2 = await mod.default(req(`https://aisdr.example.test/api/${name}`, { method: 'POST', headers: bearer('orphan'), body: {} }), {});
    assert.equal(r2.status, 403, `${name} orphan`);
  });
}
for (const name of OPERATOR_FNS) {
  test(`operator guard: ${name} → 401 anonymous, 403 for a normal tenant member`, async () => {
    setup();
    const mod = await import(`../netlify/functions/${name}.mjs`);
    const r1 = await mod.default(req(`https://aisdr.example.test/api/${name}`, { method: 'POST', body: {} }), {});
    assert.equal(r1.status, 401, `${name} anon`);
    const r2 = await mod.default(req(`https://aisdr.example.test/api/${name}`, { method: 'POST', headers: bearer('member'), body: {} }), {});
    assert.equal(r2.status, 403, `${name} member`);
  });
}

test('campaign-admin: seed/set_flag are operator-only', async () => {
  setup();
  const mod = await import('../netlify/functions/campaign-admin.mjs');
  for (const action of ['seed', 'set_flag']) {
    const r = await mod.default(req(`https://aisdr.example.test/api/campaign-admin?action=${action}`, { method: 'POST', headers: bearer('member'), body: {} }), {});
    assert.equal(r.status, 403, action);
  }
});

test('signup refuses operator emails and the platform domain', async () => {
  setup();
  const mod = await import('../netlify/functions/signup.mjs');
  for (const email of ['ops@example.com', 'eve@a-gent.co', 'eve@mail.a-gent.co']) {
    const r = await mod.default(req('https://aisdr.example.test/api/signup', { method: 'POST', body: { name: 'E', company: 'E', email, password: 'longenough1', slug: 'evil-co' } }), {});
    assert.equal(r.status, 403, email);
  }
  assert.equal(calls.filter((c) => c.url.includes('/auth/v1/admin/users')).length, 0);
});

test('admin-secret endpoints fail closed / reject wrong secret', async () => {
  setup();
  delete process.env.ADMIN_SECRET;
  const g = await import('../netlify/functions/grant-access.mjs');
  const r0 = await g.default(req('https://aisdr.example.test/api/grant-access', { method: 'POST', body: { secret: 'x' } }), {});
  assert.equal(r0.status, 503);
  process.env.ADMIN_SECRET = 'correct-horse';
  const r1 = await g.default(req('https://aisdr.example.test/api/grant-access', { method: 'POST', body: { secret: 'wrong' } }), {});
  assert.equal(r1.status, 401);
  delete process.env.ADMIN_SECRET;
});
