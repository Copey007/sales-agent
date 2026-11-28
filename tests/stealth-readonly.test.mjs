// Stealth lock: RefoundGTM tenant 293f61ad… is read-only for every role,
// including operators and internal/service-token callers. Mutations and
// outreach approve/reject/send are 403. Other tenants are unchanged.
// Fetch is mocked — no live DB writes, no Resend, no Hunter.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, mockAuth, req, calls, INTERNAL, SB } from './helpers/env.mjs';

const T = await import('../netlify/functions/_tenant.mjs');
const outreach = (await import('../netlify/functions/worker-outreach.mjs')).default;
const hires = (await import('../netlify/functions/workforce-hires.mjs')).default;
const orchestrator = (await import('../netlify/functions/campaign-orchestrator.mjs')).default;
const campaignAdmin = (await import('../netlify/functions/campaign-admin.mjs')).default;
const researcher = (await import('../netlify/functions/researcher-find.mjs')).default;
const brain = (await import('../netlify/functions/gtm-brain.mjs')).default;
const workforce = (await import('../netlify/functions/workforce.mjs')).default;
const socialPost = (await import('../netlify/functions/social-post.mjs')).default;
const runtime = (await import('../netlify/functions/worker-runtime.mjs')).default;

const R = T.STEALTH_TENANT_IDS[0];
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ok = '2026-01-01T00:00:00Z';
const USERS = {
  op: { id: 'u-op', email: 'ops@example.com', email_confirmed_at: ok },
  member: { id: 'u-rgtm', email: 'owner@refoundgtm.test', email_confirmed_at: ok },
  alice: { id: 'u-alice', email: 'alice@a.test', email_confirmed_at: ok },
};
const TENANTS = {
  [R]: { id: R, slug: 'refoundgtm', name: 'RefoundGTM', plan: 'starter', status: 'active' },
  [A]: { id: A, slug: 'tenant-a', name: 'Tenant A', plan: 'starter', status: 'active' },
};
const MEMBERS = {
  'u-op': [{ role: 'owner', tenant_id: T.homeTenantId(), tenants: { id: T.homeTenantId(), slug: 'a-gent', name: 'A-Gent' } }],
  'u-rgtm': [{ role: 'owner', tenant_id: R, tenants: TENANTS[R] }],
  'u-alice': [{ role: 'owner', tenant_id: A, tenants: TENANTS[A] }],
};
const DRAFTS = [
  { id: 'd-r', tenant_id: R, status: 'pending', subject: 'Touch 1', prospect_email: 'p@x.test', from_email: 'info@refoundgtm.com', body: 'Hi' },
  { id: 'd-a', tenant_id: A, status: 'pending', subject: 'A draft', prospect_email: 'a@a.test', from_email: 'a@a.test', body: 'Hi' },
];
const HIRES = [
  { id: 'h-r', tenant_id: R, worker_id: 'sdr', name: 'R worker', status: 'active' },
  { id: 'h-a', tenant_id: A, worker_id: 'sdr', name: 'A worker', status: 'active' },
];
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const U = (path, tid, extra = '') => {
  const q = [tid ? `tenant_id=${tid}` : '', extra].filter(Boolean).join('&');
  return `https://aisdr.example.test${path}${q ? (path.includes('?') ? '&' : '?') + q : ''}`;
};
const eqId = (u, col = 'tenant_id') => (new RegExp(`[?&]${col}=eq\\.([^&]+)`).exec(u) || [])[1];

function setup() {
  resetFetch();
  mockAuth(USERS, MEMBERS);
  route(`${SB}/rest/v1/tenants`, (u) => {
    const id = eqId(u, 'id');
    return { body: id && TENANTS[id] ? [TENANTS[id]] : [] };
  });
  route(`${SB}/rest/v1/workforce_hires`, (u, init) => {
    if ((init.method || 'GET') !== 'GET') return { body: [] };
    return { body: HIRES.filter((h) => (!eqId(u) || h.tenant_id === eqId(u)) && (!eqId(u, 'id') || h.id === eqId(u, 'id'))) };
  });
  route(`${SB}/rest/v1/worker_outreach`, (u, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'PATCH' || method === 'POST') return { body: [] };
    const id = eqId(u, 'id');
    if (id) return { body: DRAFTS.filter((d) => d.id === id) };
    return { body: DRAFTS.filter((d) => d.tenant_id === eqId(u)) };
  });
  route(`${SB}/rest/v1/contact_pool`, (u) => {
    if (/select=tenant_id/.test(u)) return new Response(JSON.stringify({ code: '42703', message: 'column contact_pool.tenant_id does not exist' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (/id=is\.null/.test(u)) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } });
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } });
  });
  route('api.resend.com', () => ({ body: { id: 'should-never-happen' } }));
  route('api.bufferapp.com', () => ({ body: [{ id: 'buf-1', service: 'linkedin' }] }));
}

function noResend() {
  assert.ok(!calls.some((c) => c.url.includes('api.resend.com')), 'no Resend call');
}
function noPatchOutreach() {
  assert.ok(!calls.some((c) => c.url.includes('worker_outreach') && (c.method === 'PATCH' || c.method === 'POST')), 'outreach row unchanged');
}

test('helpers: only the RefoundGTM id is stealth; writes are blocked, other ids are not', () => {
  assert.equal(T.isStealthTenant(R), true);
  assert.equal(T.stealthWriteBlocked(R), true);
  assert.equal(T.stealthWriteBlocked(R.toUpperCase()), true);
  assert.equal(T.isStealthTenant(A), false);
  assert.equal(T.stealthWriteBlocked(A), false);
  assert.equal(T.stealthWriteBlocked(null), false);
  assert.deepEqual([...T.STEALTH_TENANT_IDS], [R]);
});

test('isMutatingHttpRequest: GET and read-only POSTs pass; other methods and unknown POSTs do not', async () => {
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/worker-outreach', R))), false);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/campaign-orchestrator', R), { method: 'POST', body: { action: 'status' } })), false);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/campaign-orchestrator', R), { method: 'POST', body: { action: 'launch' } })), true);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/campaign-admin?action=campaigns_overview', R))), false);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/campaign-admin?action=approve_sends', R), { method: 'POST', body: {} })), true);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/workforce', R), { method: 'POST', body: { action: 'tasks' } })), false);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/workforce', R), { method: 'POST', body: { action: 'delegate' } })), true);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/researcher-find', R), { method: 'POST', body: { action: 'find' } })), true);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/gtm-brain', R), { method: 'PATCH', body: {} })), true);
  assert.equal(await T.isMutatingHttpRequest(req(U('/api/x', R), { method: 'OPTIONS' })), false);
});

async function roles(tid, path, { method = 'POST', body, headers } = {}) {
  return [
    ['operator', await call('op', tid, path, { method, body, headers })],
    ['member', await call('member', tid, path, { method, body, headers })],
    ['internal', await call(null, tid, path, { method, body, headers: { ...INTERNAL, 'Content-Type': 'application/json' } })],
  ];
}
async function call(user, tid, path, { method = 'GET', body, headers } = {}) {
  setup();
  const h = { ...(user ? bearer(user) : {}), 'Content-Type': 'application/json', ...(headers || {}) };
  const handlers = {
    '/api/worker-outreach': outreach,
    '/api/workforce-hires': hires,
    '/api/campaign-orchestrator': orchestrator,
    '/api/campaign-admin': campaignAdmin,
    '/api/researcher-find': researcher,
    '/api/gtm-brain': brain,
    '/api/workforce': workforce,
    '/api/social-post': socialPost,
    '/api/worker-runtime': runtime,
  };
  const fn = handlers[path.split('?')[0]];
  return fn(req(U(path, tid), { method, headers: h, body }), {});
}

test('worker-outreach GET (read) for the stealth tenant still works for an operator', async () => {
  setup();
  const r = await outreach(req(U('/api/worker-outreach', R), { headers: bearer('op') }), {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.drafts.map((d) => d.id), ['d-r']);
});

test('worker-outreach approve AND reject of a stealth draft is 403 for operator, member, and internal; nothing is sent or patched', async () => {
  for (const action of ['approve', 'reject']) {
    for (const [role, res] of await roles(R, '/api/worker-outreach', { body: { id: 'd-r', action } })) {
      assert.equal(res.status, 403, `${role} ${action}`);
      const body = await res.json();
      assert.equal(body.reason, 'stealth_readonly');
      noResend();
      noPatchOutreach();
    }
  }
});

test('worker-outreach: unscoped operator approving a stealth draft (id only, no tenant_id) is also 403', async () => {
  setup();
  // Give the operator a membership so the unscoped POST can load the draft at all.
  MEMBERS['u-op'].push({ role: 'owner', tenant_id: R, tenants: TENANTS[R] });
  try {
    const r = await outreach(req('https://aisdr.example.test/api/worker-outreach', { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { id: 'd-r', action: 'approve' } }), {});
    assert.equal(r.status, 403);
    assert.equal((await r.json()).reason, 'stealth_readonly');
    noResend();
    noPatchOutreach();
  } finally { MEMBERS['u-op'].pop(); }
});

test('worker-outreach approve for a different tenant still reaches the send path (not stealth_readonly)', async () => {
  setup();
  // alice is a member of A; approving A's draft is allowed (will then fail closed on missing RESEND in this mock, not stealth).
  const r = await outreach(req(U('/api/worker-outreach', A), { method: 'POST', headers: { ...bearer('alice'), 'Content-Type': 'application/json' }, body: { id: 'd-a', action: 'approve' } }), {});
  assert.notEqual((await r.clone().json()).reason, 'stealth_readonly');
  assert.notEqual(r.status, 403);
});

test('mutating endpoints scoped to the stealth tenant return 403 for operator, member, and internal', async () => {
  const cases = [
    ['/api/workforce-hires', { method: 'POST', body: { worker: { id: 'sdr' }, goal: 'x' } }],
    ['/api/workforce-hires', { method: 'PATCH', body: { id: 'h-r', status: 'paused' } }],
    ['/api/campaign-orchestrator', { method: 'POST', body: { action: 'launch', campaign_name: 'x', target_persona: 'p', icp: 'i', problem_we_solve: 'q' } }],
    ['/api/campaign-admin?action=approve_sends', { method: 'POST', body: { send_ids: ['s1'] } }],
    ['/api/campaign-admin?action=set_campaign_status', { method: 'POST', body: { campaign_id: 'c1', status: 'paused' } }],
    ['/api/researcher-find', { method: 'POST', body: { action: 'find', icp: 'x' } }],
    ['/api/gtm-brain', { method: 'POST', body: { action: 'save_assessment', answers: { a: 1 } } }],
    ['/api/workforce', { method: 'POST', body: { action: 'delegate', objective: 'x' } }],
    ['/api/social-post', { method: 'POST', body: { text: 'hi', profile_ids: ['buf-1'] } }],
    ['/api/worker-runtime', { method: 'POST', body: { hire_id: 'h-r' } }],
  ];
  for (const [path, opts] of cases) {
    for (const [role, res] of await roles(R, path, opts)) {
      assert.equal(res.status, 403, `${role} ${path}`);
      assert.equal((await res.json()).reason, 'stealth_readonly', `${role} ${path} reason`);
      noResend();
    }
  }
});

test('read-only POSTs and GETs scoped to the stealth tenant are not blocked', async () => {
  setup();
  const status = await orchestrator(req(U('/api/campaign-orchestrator', R), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { action: 'status' } }), {});
  assert.equal(status.status, 200);
  const overview = await campaignAdmin(req(U('/api/campaign-admin?action=campaigns_overview', R), { headers: bearer('op') }), {});
  assert.equal(overview.status, 200);
  const pool = await researcher(req(U('/api/researcher-find', R), { headers: bearer('op') }), {});
  assert.equal(pool.status, 200);
  const plan = await brain(req(U('/api/gtm-brain', R), { headers: bearer('op') }), {});
  assert.equal(plan.status, 200);
  const wf = await workforce(req(U('/api/workforce', R), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { action: 'tasks' } }), {});
  assert.equal(wf.status, 200);
});

test('the same mutations still work when scoped to another tenant (not stealth_readonly)', async () => {
  setup();
  const launch = await orchestrator(req(U('/api/campaign-orchestrator', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { action: 'launch', campaign_name: 'x', target_persona: 'p', icp: 'i', problem_we_solve: 'q' } }), {});
  const body = await launch.json();
  assert.notEqual(body.reason, 'stealth_readonly');
  // 200 with a created campaign, or a field/validation error — never the stealth lock.
  const hire = await hires(req(U('/api/workforce-hires', A), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { worker: { id: 'sdr' }, goal: 'x' } }), {});
  assert.notEqual((await hire.json()).reason, 'stealth_readonly');
  const find = await researcher(req(U('/api/researcher-find', A), { method: 'POST', headers: { ...bearer('alice'), 'Content-Type': 'application/json' }, body: { action: 'select_all', selected: true } }), {});
  assert.notEqual((await find.json()).reason, 'stealth_readonly');
});

test('requireTenant / requireOperator themselves 403 a stealth mutation for operator and internal, but allow a GET', async () => {
  setup();
  const g = await T.requireTenant(req(U('/api/x', R), { headers: bearer('op') }));
  assert.equal(g.ctx.tenantId, R);
  assert.equal(g.response, undefined);
  const m = await T.requireTenant(req(U('/api/x', R), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { action: 'launch' } }));
  assert.equal(m.response.status, 403);
  assert.equal((await m.response.json()).reason, 'stealth_readonly');
  const i = await T.requireTenant(req(U('/api/x', R), { method: 'POST', headers: { ...INTERNAL, 'Content-Type': 'application/json' }, body: {} }), { allowInternal: true });
  assert.equal(i.response.status, 403);
  const op = await T.requireOperator(req(U('/api/social-post', R), { method: 'POST', headers: { ...bearer('op'), 'Content-Type': 'application/json' }, body: { text: 'hi' } }));
  assert.equal(op.response.status, 403);
});
