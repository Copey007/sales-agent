// Mission Control per-account workspaces: server-side tenant scoping.
// Two (three, with the operator's home) tenants; every endpoint the MC
// workspace calls must return ONLY the requested tenant's data, and a caller
// scoped to (or a member of) tenant A asking for tenant B gets 403/404/empty.
// Fetch + Netlify Blobs are mocked: no live DB reads/writes, no sends.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, mockAuth, req, calls, SB } from './helpers/env.mjs';
import { getStore } from './helpers/blobs-mock.mjs';

const T = await import('../netlify/functions/_tenant.mjs');
const R = await import('../netlify/functions/_supabase-rest.mjs');
const hires = (await import('../netlify/functions/workforce-hires.mjs')).default;
const outreach = (await import('../netlify/functions/worker-outreach.mjs')).default;
const orchestrator = (await import('../netlify/functions/campaign-orchestrator.mjs')).default;
const campaignAdmin = (await import('../netlify/functions/campaign-admin.mjs')).default;
const researcher = (await import('../netlify/functions/researcher-find.mjs')).default;
const brain = (await import('../netlify/functions/gtm-brain.mjs')).default;
const socialStats = (await import('../netlify/functions/social-stats.mjs')).default;
const socialPost = (await import('../netlify/functions/social-post.mjs')).default;
const narrate = (await import('../netlify/functions/slide-narrate.mjs')).default;
const runtime = (await import('../netlify/functions/worker-runtime.mjs')).default;
const dailyReport = (await import('../netlify/functions/worker-daily-report.mjs')).default;
const workforce = (await import('../netlify/functions/workforce.mjs')).default;

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const HOME = T.homeTenantId();
const MASTER = T.MASTER_TENANT_ID;
const ok = '2026-01-01T00:00:00Z';
const USERS = {
  op: { id: 'u-op', email: 'ops@example.com', email_confirmed_at: ok },
  alice: { id: 'u-alice', email: 'alice@a.test', email_confirmed_at: ok },  // member of A only
  bob: { id: 'u-bob', email: 'bob@b.test', email_confirmed_at: ok },        // member of B only
};
const TENANTS = {
  [A]: { id: A, slug: 'tenant-a', name: 'Tenant A', plan: 'starter', status: 'active' },
  [B]: { id: B, slug: 'tenant-b', name: 'Tenant B', plan: 'starter', status: 'active' },
  [HOME]: { id: HOME, slug: 'a-gent', name: 'A-Gent', plan: 'growth', status: 'active' },
};
const MEMBERS = {
  'u-op': [{ role: 'owner', tenant_id: HOME, tenants: TENANTS[HOME] }],
  'u-alice': [{ role: 'owner', tenant_id: A, tenants: TENANTS[A] }],
  'u-bob': [{ role: 'owner', tenant_id: B, tenants: TENANTS[B] }],
};
const HIRES = [
  { id: 'h-a', tenant_id: A, worker_id: 'sdr', name: 'A worker', status: 'active' },
  { id: 'h-b', tenant_id: B, worker_id: 'sdr', name: 'B worker', status: 'active' },
  { id: 'h-home', tenant_id: HOME, worker_id: 'sdr', name: 'Home worker', status: 'active' },
];
const DRAFTS = [
  { id: 'd-a', tenant_id: A, status: 'pending', subject: 'A draft', prospect_email: 'x@a.test', from_email: 'a@a.test' },
  { id: 'd-b', tenant_id: B, status: 'pending', subject: 'B draft', prospect_email: 'y@b.test', from_email: 'b@b.test' },
];
const AGENTS = [
  { slug: 'agent-a', tenant_id: A, name: 'A agent', system_prompt: 'A-SECRET' },
  { slug: 'agent-b', tenant_id: B, name: 'B agent', system_prompt: 'B-SECRET' },
];
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const U = (path, tid) => `https://aisdr.example.test${path}${path.includes('?') ? '&' : '?'}${tid ? `tenant_id=${tid}` : ''}`;
const eqId = (u, col = 'tenant_id') => (new RegExp(`[?&]${col}=eq\\.([^&]+)`).exec(u) || [])[1];

function setup() {
  resetFetch();
  mockAuth(USERS, MEMBERS);
  route(`${SB}/rest/v1/tenants`, (u) => {
    const id = eqId(u, 'id');
    if (!id && /select=id,name,slug,status,plan,created_at/.test(u)) return { body: [TENANTS[A], TENANTS[B], TENANTS[HOME]] };
    return { body: id && TENANTS[id] ? [TENANTS[id]] : [] };
  });
  route(`${SB}/rest/v1/workforce_hires`, (u) => ({ body: HIRES.filter((h) => h.tenant_id === eqId(u) && (!eqId(u, 'id') || h.id === eqId(u, 'id'))) }));
  route(`${SB}/rest/v1/worker_outreach`, (u, init) => {
    if ((init.method || 'GET') !== 'GET') return { body: [] };
    const id = eqId(u, 'id');
    if (id) return { body: DRAFTS.filter((d) => d.id === id) };
    return { body: DRAFTS.filter((d) => d.tenant_id === eqId(u)) };
  });
  route(`${SB}/rest/v1/avatar_agents`, (u) => ({ body: AGENTS.filter((a) => a.slug === decodeURIComponent(eqId(u, 'slug') || '')) }));
  // Pre-migration contact_pool: the tenant_id column does not exist.
  route(`${SB}/rest/v1/contact_pool`, (u) => {
    if (/select=tenant_id/.test(u)) return new Response(JSON.stringify({ code: '42703', message: 'column contact_pool.tenant_id does not exist' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (/id=is\.null/.test(u)) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } });
    return new Response(JSON.stringify([{ id: 'p-master', email: 'pool@master.test', status: 'found' }]), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' } });
  });
  route('api.bufferapp.com', () => ({ body: [{ id: 'buf-1', service: 'linkedin' }] }));
  route('api.resend.com', () => ({ body: { id: 'should-never-happen' } }));
}

async function seedCampaigns() {
  const s = getStore('campaigns');
  for (const [id, tid, name] of [['c-a', A, 'A campaign'], ['c-b', B, 'B campaign'], ['c-m', MASTER, '1600 CEO\'s']]) {
    await s.set(id, JSON.stringify({ id, tenant_id: tid, name, status: 'active', metrics: { prospects_enrolled: 3 } }));
  }
}

// ─── Resolver ────────────────────────────────────────────────────────────────

test('resolver: operator scoped to A / B / home / MASTER; malformed and unknown ids fail closed', async () => {
  setup();
  const a = await T.resolveTenantContext(req(U('/api/x', A), { headers: bearer('op') }));
  assert.equal(a.tenantId, A); assert.equal(a.scoped, true); assert.equal(a.operator, true);
  const b = await T.resolveTenantContext(req('https://aisdr.example.test/api/x', { headers: { ...bearer('op'), 'X-Tenant-Id': B } }));
  assert.equal(b.tenantId, B, 'X-Tenant-Id header works too');
  const h = await T.resolveTenantContext(req(U('/api/x', HOME), { headers: bearer('op') }));
  assert.equal(h.tenantId, MASTER, 'home account keeps the operator campaign data'); assert.equal(h.tenant.id, HOME); assert.equal(h.home, true);
  const m = await T.resolveTenantContext(req(U('/api/x', MASTER), { headers: bearer('op') }));
  assert.equal(m.tenantId, MASTER); assert.equal(m.home, true);
  const bad = await T.resolveTenantContext(req('https://aisdr.example.test/api/x?tenant_id=not-a-uuid', { headers: bearer('op') }));
  assert.equal(bad.invalid, true); assert.equal(bad.status, 400);
  const unknown = await T.resolveTenantContext(req(U('/api/x', 'cccccccc-0000-4000-8000-00000000000c'), { headers: bearer('op') }));
  assert.equal(unknown.invalid, true); assert.equal(unknown.status, 404);
  const legacy = await T.resolveTenantContext(req('https://aisdr.example.test/api/x', { headers: bearer('op') }));
  assert.equal(legacy.tenantId, MASTER); assert.equal(legacy.scoped, undefined, 'unscoped behaviour unchanged');
});

test('resolver: member of A scoped to A ok; scoped to B → 403 (and so is every tenantGuard endpoint)', async () => {
  setup();
  const a = await T.resolveTenantContext(req(U('/api/x', A), { headers: bearer('alice') }));
  assert.equal(a.tenantId, A); assert.equal(a.invalid, false);
  const b = await T.resolveTenantContext(req(U('/api/x', B), { headers: bearer('alice') }));
  assert.equal(b.invalid, true); assert.equal(b.status, 403); assert.equal(b.reason, 'not_a_member');
  const g = await T.requireTenant(req(U('/api/x', B), { headers: bearer('alice') }));
  assert.equal(g.response.status, 403);
  const home = await T.resolveTenantContext(req(U('/api/x', HOME), { headers: bearer('alice') }));
  assert.equal(home.status, 403, 'a customer cannot reach the operator home account');
});

// ─── workforce-hires ─────────────────────────────────────────────────────────

test('workforce-hires: operator scoped to A sees only A hires; scoped to B only B', async () => {
  setup();
  const ra = await hires(req(U('/api/workforce-hires', A), { headers: bearer('op') }), {});
  assert.equal(ra.status, 200);
  assert.deepEqual((await ra.json()).hires.map((h) => h.id), ['h-a']);
  const rb = await hires(req(U('/api/workforce-hires', B), { headers: bearer('op') }), {});
  assert.deepEqual((await rb.json()).hires.map((h) => h.id), ['h-b']);
  const rh = await hires(req(U('/api/workforce-hires', HOME), { headers: bearer('op') }), {});
  assert.deepEqual((await rh.json()).hires.map((h) => h.id), ['h-home']);
});

test('workforce-hires: member of A requesting B → 403, no hires leak', async () => {
  setup();
  const r = await hires(req(U('/api/workforce-hires', B), { headers: bearer('alice') }), {});
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.hires, undefined);
  assert.ok(!calls.some((c) => c.url.includes('/rest/v1/workforce_hires')), 'no hires query was even made');
});

test('workforce-hires: PATCH a B hire while scoped to A updates nothing (404)', async () => {
  setup();
  const patched = [];
  route(`${SB}/rest/v1/workforce_hires?id=eq.h-b`, (u, init) => { patched.push(u); return { body: HIRES.filter((h) => h.id === 'h-b' && h.tenant_id === eqId(u)) }; });
  const r = await hires(req(U('/api/workforce-hires', A), { method: 'PATCH', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { id: 'h-b', status: 'paused' } }), {});
  assert.equal(r.status, 404);
  assert.ok(patched.every((u) => u.includes(`tenant_id=eq.${A}`)), 'every write is filtered to the scoped tenant');
});

// ─── worker-outreach (RefoundGTM-style queue) ────────────────────────────────

test('worker-outreach: operator scoped to A sees only A drafts, scoped to B only B', async () => {
  setup();
  const ra = await outreach(req(U('/api/worker-outreach', A), { headers: bearer('op') }), {});
  assert.equal(ra.status, 200);
  const ba = await ra.json();
  assert.deepEqual(ba.drafts.map((d) => d.id), ['d-a']);
  assert.deepEqual(ba.tenants.map((t) => t.id), [A]);
  const rb = await outreach(req(U('/api/worker-outreach', B), { headers: bearer('op') }), {});
  assert.deepEqual((await rb.json()).drafts.map((d) => d.id), ['d-b']);
});

test('worker-outreach: member of A asking for B → 403', async () => {
  setup();
  const r = await outreach(req(U('/api/worker-outreach', B), { headers: bearer('alice') }), {});
  assert.equal(r.status, 403);
});

test('worker-outreach: approving a B draft while scoped to A → 404, nothing sent or patched', async () => {
  setup();
  // bob is a member of B; even he cannot act on B's draft from an A-scoped request.
  MEMBERS['u-bob'].push({ role: 'owner', tenant_id: A, tenants: TENANTS[A] });
  try {
    const r = await outreach(req(U('/api/worker-outreach', A), { method: 'POST', headers: { ...bearer('bob'), 'Content-Type': 'application/json' }, body: { id: 'd-b', action: 'approve' } }), {});
    assert.equal(r.status, 404);
    assert.ok(!calls.some((c) => c.url.includes('api.resend.com')), 'no email send');
    assert.ok(!calls.some((c) => c.url.includes('/worker_outreach') && c.method === 'PATCH'), 'no status change');
  } finally { MEMBERS['u-bob'].pop(); }
});

// ─── campaign engine (Blobs) ─────────────────────────────────────────────────

test('campaign-orchestrator status: A sees only A campaigns; home sees the master campaigns', async () => {
  setup(); await seedCampaigns();
  const post = (tid, body) => orchestrator(req(U('/api/campaign-orchestrator', tid), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body }), {});
  const a = await (await post(A, { action: 'status' })).json();
  assert.deepEqual(a.campaigns.map((c) => c.id), ['c-a']);
  const b = await (await post(B, { action: 'status' })).json();
  assert.deepEqual(b.campaigns.map((c) => c.id), ['c-b']);
  const h = await (await post(HOME, { action: 'status' })).json();
  assert.deepEqual(h.campaigns.map((c) => c.id), ['c-m'], 'Mark\'s own campaigns = the home account only');
});

test('campaign-orchestrator detail of a B campaign while scoped to A → 404', async () => {
  setup(); await seedCampaigns();
  const r = await orchestrator(req(U('/api/campaign-orchestrator', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { action: 'detail', campaign_id: 'c-b' } }), {});
  assert.equal(r.status, 404);
});

test('campaign-orchestrator: member of A asking for B → 403', async () => {
  setup(); await seedCampaigns();
  const r = await orchestrator(req(U('/api/campaign-orchestrator', B), { method: 'POST', headers: { ...bearer('alice'), 'Content-Type': 'application/json' }, body: { action: 'status' } }), {});
  assert.equal(r.status, 403);
});

test('campaign-admin campaigns_overview is tenant-scoped; set_campaign_status on another tenant\'s campaign is refused', async () => {
  setup(); await seedCampaigns();
  const r = await campaignAdmin(req(U('/api/campaign-admin?action=campaigns_overview', A), { headers: bearer('op') }), {});
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).campaigns.map((c) => c.id), ['c-a']);
  const s = await campaignAdmin(req(U('/api/campaign-admin?action=set_campaign_status', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { campaign_id: 'c-b', status: 'paused' } }), {});
  const sb = await s.json();
  assert.equal(sb.success, undefined); assert.match(String(sb.error), /not found/i);
  const raw = await getStore('campaigns').get('c-b');
  assert.equal(JSON.parse(raw).status, 'active', 'B campaign untouched');
});

test('gtm-brain plan is per tenant', async () => {
  setup();
  const plans = getStore('gtm_plans');
  await plans.setJSON(A, { tenant_id: A, title: 'A plan' });
  await plans.setJSON(B, { tenant_id: B, title: 'B plan' });
  const a = await (await brain(req(U('/api/gtm-brain', A), { headers: bearer('op') }), {})).json();
  assert.equal(a.plan.title, 'A plan');
  const b = await (await brain(req(U('/api/gtm-brain', B), { headers: bearer('op') }), {})).json();
  assert.equal(b.plan.title, 'B plan');
  const x = await brain(req(U('/api/gtm-brain', B), { headers: bearer('alice') }), {});
  assert.equal(x.status, 403);
});

// ─── Researcher contact pool (pre-tenancy table) ─────────────────────────────

test('researcher-find: pre-migration pool belongs to the home account; other tenants see nothing and cannot write', async () => {
  setup();
  assert.equal(await R.poolTenantFilter(MASTER), '');
  assert.equal(await R.poolTenantFilter(A), R.POOL_NO_ROWS);
  const h = await (await researcher(req(U('/api/researcher-find', HOME), { headers: bearer('op') }), {})).json();
  assert.equal(h.pool.length, 1, 'home account still sees its pool');
  const a = await (await researcher(req(U('/api/researcher-find', A), { headers: bearer('op') }), {})).json();
  assert.equal(a.pool.length, 0, 'tenant A sees none of the master pool');
  assert.equal(a.total, 0);
  const sel = await researcher(req(U('/api/researcher-find', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { action: 'select_all', selected: true } }), {});
  assert.equal((await sel.json()).updated, 0);
  const patches = calls.filter((c) => c.url.includes('/contact_pool') && c.method === 'PATCH');
  assert.ok(patches.length && patches.every((c) => c.url.includes('id=is.null')), 'A-scoped PATCH matches no row');
  const find = await researcher(req(U('/api/researcher-find', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { action: 'find', icp: 'x' } }), {});
  assert.equal(find.status, 422);
  assert.equal((await find.json()).error, 'tenant_pool_unavailable');
});

// ─── Operator-only shared surfaces ───────────────────────────────────────────

test('social-stats / social-post: Buffer channels never shown or used for a non-home tenant', async () => {
  setup();
  const s = await (await socialStats(req(U('/api/social-stats', A), { headers: bearer('op') }), {})).json();
  assert.equal(s.connected, false);
  const p = await socialPost(req(U('/api/social-post', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { text: 'hi', profile_ids: ['buf-1'] } }), {});
  assert.equal(p.status, 403);
  assert.ok(!calls.some((c) => c.url.includes('api.bufferapp.com')), 'Buffer never called');
});

test('workforce roster: live task text is stripped for a non-home scoped workspace', async () => {
  setup();
  const r = await workforce(req(U('/api/workforce', A), { headers: bearer('op') }), {});
  assert.equal(r.status, 200);
  const body = await r.json();
  for (const a of body.workforce || []) {
    assert.equal(a.current_task, undefined); assert.equal(a.last_action, undefined); assert.equal(a.memory, undefined);
  }
});

test('slide-narrate: member of A cannot narrate with B\'s agent (no persona leak, no LLM call)', async () => {
  setup();
  const r = await narrate(req('https://aisdr.example.test/api/slide-narrate', { method: 'POST', headers: { ...bearer('alice'), 'Content-Type': 'application/json' }, body: { slug: 'agent-b', slide_url: 'https://x.test/s.png' } }), {});
  assert.equal(r.status, 403);
  const r2 = await narrate(req(U('/api/slide-narrate', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { slug: 'agent-b', slide_url: 'https://x.test/s.png' } }), {});
  assert.equal(r2.status, 403, 'operator scoped to A cannot use B\'s agent');
  assert.ok(!calls.some((c) => /anthropic|openai|openrouter|x\.ai/i.test(c.url)), 'no LLM call');
});

test('worker-runtime / worker-daily-report: a B hire is not found from an A-scoped request (nothing runs or sends)', async () => {
  setup();
  const rr = await runtime(req(U('/api/worker-runtime', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { hire_id: 'h-b' } }), {});
  assert.equal(rr.status, 404);
  const dr = await dailyReport(req(U('/api/worker-daily-report', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { hire_id: 'h-b' } }), {});
  assert.equal(dr.status, 404);
  const xr = await runtime(req(U('/api/worker-runtime', B), { method: 'POST', headers: { ...bearer('alice'), 'Content-Type': 'application/json' }, body: { hire_id: 'h-b' } }), {});
  assert.equal(xr.status, 403);
  assert.ok(!calls.some((c) => c.url.includes('api.resend.com')), 'no email send');
});

test('admin-subaccounts: the operator home account is flagged and listed first (one account among many)', async () => {
  setup();
  const admin = (await import('../netlify/functions/admin-subaccounts.mjs')).default;
  const r = await admin(req('https://aisdr.example.test/api/admin-subaccounts', { headers: bearer('op') }), {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.home_tenant_id, HOME);
  assert.equal(body.tenants[0].id, HOME); assert.equal(body.tenants[0].home, true);
  assert.deepEqual(body.tenants.filter((t) => t.home).length, 1);
  const deny = await admin(req('https://aisdr.example.test/api/admin-subaccounts', { headers: bearer('alice') }), {});
  assert.equal(deny.status, 403);
});
