// MCP Phase A read surface: tenant 401/403, stealth read-only, no mutations.
// Mocked fetch only: no live DB, no Resend, no Hunter, no LLM.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, mockAuth, req, calls, INTERNAL, SB } from './helpers/env.mjs';
import { getStore } from './helpers/blobs-mock.mjs';

const T = await import('../netlify/functions/_tenant.mjs');
const S = await import('../netlify/functions/_campaign-store.mjs');
const status = (await import('../netlify/functions/mcp-account-status.mjs')).default;
const drafts = (await import('../netlify/functions/mcp-lookup-drafts.mjs')).default;

const R = T.STEALTH_TENANT_IDS[0];
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const HOME = T.homeTenantId();
const ok = '2026-01-01T00:00:00Z';
const USERS = {
  alice: { id: 'u-alice', email: 'alice@a.test', email_confirmed_at: ok },
  rgtm: { id: 'u-rgtm', email: 'owner@refoundgtm.test', email_confirmed_at: ok },
  op: { id: 'u-op', email: 'ops@example.com', email_confirmed_at: ok },
  homeuser: { id: 'u-home', email: 'mark@home.test', email_confirmed_at: ok },
};
const TEN = {
  [R]: { id: R, slug: 'refoundgtm', name: 'RefoundGTM', plan: 'starter', status: 'active', stripe_customer_id: 'SECRET' },
  [A]: { id: A, slug: 'tenant-a', name: 'Tenant A', plan: 'starter', status: 'active', stripe_customer_id: 'SECRET' },
  [B]: { id: B, slug: 'tenant-b', name: 'Tenant B', plan: 'starter', status: 'active', stripe_customer_id: 'SECRET' },
  [HOME]: { id: HOME, slug: 'a-gent', name: 'A-Gent', plan: 'pro', status: 'active', stripe_customer_id: 'SECRET' },
};
const MEM = {
  'u-alice': [{ role: 'owner', tenant_id: A, tenants: TEN[A] }],
  'u-rgtm': [{ role: 'owner', tenant_id: R, tenants: TEN[R] }],
  'u-op': [{ role: 'owner', tenant_id: HOME, tenants: TEN[HOME] }],
  'u-home': [{ role: 'owner', tenant_id: HOME, tenants: TEN[HOME] }],
};
const DRAFTS = [
  { id: 'd-r', tenant_id: R, status: 'pending', subject: 'Touch 1', body: 'Hi', prospect_email: 'p@x.test', prospect_name: 'P', prospect_company: 'X', from_email: 'info@refoundgtm.com', worker_id: 'sdr', worker_name: 'W', hire_id: 'h-r', created_at: '2026-11-27T19:09:49Z', resend_id: 'SECRET' },
  { id: 'd-a', tenant_id: A, status: 'pending', subject: 'A draft', body: 'Yo', prospect_email: 'a@a.test', from_email: 'a@a.test', created_at: '2026-11-27T10:00:00Z', resend_id: 'SECRET' },
  { id: 'd-b', tenant_id: B, status: 'pending', subject: 'B draft', body: 'B', prospect_email: 'b@b.test', from_email: 'b@b.test', created_at: '2026-11-27T10:00:00Z' },
];
const HIRES = [
  { id: 'h-a', tenant_id: A, worker_id: 'sdr', name: 'A SDR', title: 'SDR', status: 'active', goal: 'secret goal', context: 'secret ctx', created_at: ok, resend_id: 'SECRET', stripe_customer_id: 'SECRET', hunter_id: 'SECRET' },
  { id: 'h-b', tenant_id: B, worker_id: 'sdr', name: 'B SDR', title: 'SDR', status: 'active', created_at: ok },
  { id: 'h-r', tenant_id: R, worker_id: 'sdr', name: 'R SDR', title: 'SDR', status: 'active', created_at: ok, resend_id: 'SECRET' },
];
const eqv = (u, col) => (new RegExp(`[?&]${col}=eq\\.([^&]+)`).exec(u) || [])[1];

async function setup() {
  resetFetch();
  mockAuth(USERS, MEM);
  const stores = globalThis.__stores; if (stores) stores.clear();
  route(`${SB}/rest/v1/tenants`, (u) => ({ body: TEN[eqv(u, 'id')] ? [TEN[eqv(u, 'id')]] : [] }));
  route(`${SB}/rest/v1/workforce_hires`, (u) => ({ body: HIRES.filter((h) => !eqv(u, 'tenant_id') || h.tenant_id === eqv(u, 'tenant_id')) }));
  route(`${SB}/rest/v1/worker_outreach`, (u) => {
    const rows = DRAFTS.filter((d) => d.tenant_id === eqv(u, 'tenant_id') && d.status === eqv(u, 'status'));
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` } });
  });
  route('api.resend.com', () => ({ body: { id: 'never' } }));
  route('api.hunter.io', () => ({ body: {} }));
}
const H = (tok, extra = {}) => ({ Authorization: `Bearer ${tok}`, ...extra });
const U = (p, q = '') => `https://aisdr.example.test${p}${q ? '?' + q : ''}`;
const NOWRITE = () => {
  const bad = calls.filter((c) => c.method !== 'GET' && c.method !== 'HEAD' && !/auth\/v1\/user/.test(c.url));
  assert.deepEqual(bad.map((c) => `${c.method} ${c.url}`), [], 'no non-GET calls');
  assert.ok(!calls.some((c) => /api\.resend\.com|api\.hunter\.io/.test(c.url)), 'no Resend/Hunter');
};
/** Provider ids and the fixture sentinel must never appear in a read response. */
const NO_PROVIDER_IDS = (body, label = '') => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const keys = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) { keys.push(k); walk(v[k]); }
    }
  };
  if (typeof body !== 'string') walk(body);
  assert.ok(!raw.includes('SECRET'), `${label} must not contain SECRET`);
  assert.ok(!keys.some((k) => /resend_id|stripe_|hunter_|svix_|liveavatar|heygen|api_key/i.test(k)), `${label} leaked provider key: ${keys.filter((k) => /resend_id|stripe_|hunter_|svix_|liveavatar|heygen|api_key/i.test(k))}`);
  assert.ok(!/resend_id/.test(raw), `${label} must not contain resend_id`);
};

test('401 without a token or with a bad token, on both endpoints', async () => {
  await setup();
  for (const fn of [status, drafts]) {
    const a = await fn(req(U('/api/mcp/x', `tenant=tenant-a`)), {});
    assert.equal(a.status, 401);
    const b = await fn(req(U('/api/mcp/x', `tenant=tenant-a`), { headers: H('nope') }), {});
    assert.equal(b.status, 401);
  }
});

test('explicit tenant selector required: no default to first membership', async () => {
  await setup();
  for (const fn of [status, drafts]) {
    const r = await fn(req(U('/api/mcp/x'), { headers: H('alice') }), {});
    assert.equal(r.status, 400);
    assert.equal((await r.json()).reason, 'tenant_required');
    const bad = await fn(req(U('/api/mcp/x', 'tenant_id=not-a-uuid'), { headers: H('alice') }), {});
    assert.equal(bad.status, 400);
  }
});

test('internal service token and operator-without-membership are refused', async () => {
  await setup();
  for (const fn of [status, drafts]) {
    const i = await fn(req(U('/api/mcp/x', `tenant_id=${A}`), { headers: INTERNAL }), {});
    assert.equal(i.status, 403);
    // operator (member of HOME only) naming tenant A: 403 unless MCP_READ_ALLOW_OPERATOR=1 (off)
    const o = await fn(req(U('/api/mcp/x', `tenant_id=${A}`), { headers: H('op') }), {});
    assert.equal(o.status, 403);
    assert.equal((await o.json()).reason, 'not_a_member');
  }
});

test('wrong tenant is 403 by slug and by uuid, with no data from the other tenant', async () => {
  await setup();
  for (const fn of [status, drafts]) {
    for (const q of ['tenant=tenant-b', `tenant_id=${B}`, 'tenant=refoundgtm', `tenant_id=${R}`]) {
      const r = await fn(req(U('/api/mcp/x', q), { headers: H('alice') }), {});
      assert.equal(r.status, 403, q);
      const text = await r.text();
      assert.ok(!/B draft|Touch 1|B SDR|R SDR/.test(text));
    }
    // slug/uuid mismatch
    const m = await fn(req(U('/api/mcp/x', `tenant_id=${A}&tenant=tenant-b`), { headers: H('alice') }), {});
    assert.equal(m.status, 403);
  }
});

test('lookup_drafts: member sees only own tenant drafts, stable shape, no secrets', async () => {
  await setup();
  const r = await drafts(req(U('/api/mcp/lookup-drafts', 'tenant=tenant-a'), { headers: H('alice') }), {});
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.tenant.slug, 'tenant-a');
  assert.deepEqual(b.drafts.map((d) => d.id), ['d-a']);
  assert.equal(b.stealth_readonly, false);
  assert.deepEqual(Object.keys(b.drafts[0]).sort(), ['body', 'campaign_id', 'created_at', 'from', 'id', 'kind', 'reviewed_at', 'sent_at', 'status', 'step_number', 'subject', 'to', 'worker'].sort());
  assert.ok(!/(approve|reject)/i.test(Object.keys(b).join(',')));
  NO_PROVIDER_IDS(b, 'lookup_drafts tenant-a');
  NOWRITE();
});

test('lookup_drafts: campaign-engine pending drafts are tenant-only and use the same shape', async () => {
  await setup();
  await S.putCampaign({ id: 'c-a', tenant_id: A, name: 'CA', status: 'active' });
  await S.putCampaign({ id: 'c-b', tenant_id: B, name: 'CB', status: 'active' });
  await S.putEmailSend({ id: 's-a', campaign_id: 'c-a', tenant_id: A, status: 'pending_approval', email_subject: 'SA', email_body: 'ba', prospect_id: 'p1', step_number: 1, drafted_at: '2026-11-27T11:00:00Z', resend_id: 'SECRET' });
  await S.putEmailSend({ id: 's-b', campaign_id: 'c-b', tenant_id: B, status: 'pending_approval', email_subject: 'SB', email_body: 'bb', prospect_id: 'p2', step_number: 1, drafted_at: '2026-11-27T11:00:00Z', resend_id: 'SECRET' });
  const r = await drafts(req(U('/api/mcp/lookup-drafts', 'tenant=tenant-a&source=campaign_sends'), { headers: H('alice') }), {});
  const b = await r.json();
  assert.deepEqual(b.drafts.map((d) => d.id), ['s-a']);
  assert.equal(b.drafts[0].kind, 'campaign_send');
  assert.equal(b.counts.campaign_sends, 1);
  NO_PROVIDER_IDS(b, 'lookup_drafts campaign_sends');
  NOWRITE();
});

test('lookup_drafts: bad params are 400', async () => {
  await setup();
  for (const q of ['source=nope', 'status=weird', 'campaign_id=a%20b%3B']) {
    const r = await drafts(req(U('/api/mcp/lookup-drafts', `tenant=tenant-a&${q}`), { headers: H('alice') }), {});
    assert.equal(r.status, 400, q);
  }
});

test('stealth tenant: member READS drafts and status (21-style rows), flagged read-only, and no aliasing', async () => {
  await setup();
  const d = await drafts(req(U('/api/mcp/lookup-drafts', `tenant_id=${R}`), { headers: H('rgtm') }), {});
  assert.equal(d.status, 200);
  const db = await d.json();
  assert.equal(db.stealth_readonly, true);
  assert.deepEqual(db.drafts.map((x) => x.id), ['d-r']);
  assert.equal(db.tenant.id, R);
  NO_PROVIDER_IDS(db, 'lookup_drafts stealth');
  const s = await status(req(U('/api/mcp/account-status', 'tenant=refoundgtm'), { headers: H('rgtm') }), {});
  const sb = await s.json();
  assert.equal(s.status, 200);
  NO_PROVIDER_IDS(sb, 'account_status stealth');
  assert.equal(sb.stealth_readonly, true);
  assert.equal(sb.tenant.id, R);
  assert.ok(sb.workforce.hires.every((h) => h.id === 'h-r'));
  // the stealth id is never a home/master alias
  assert.equal(T.isHomeTenant(R), false);
  const { campaignKeyFor } = await import('../netlify/functions/_mcp-read.mjs');
  assert.equal(campaignKeyFor(R), R);
  assert.equal(campaignKeyFor(HOME), T.MASTER_TENANT_ID);
  NOWRITE();
});

test('stealth tenant: every mutating method on both endpoints is refused and nothing is written', async () => {
  await setup();
  for (const fn of [status, drafts]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const tok of ['rgtm', 'op']) {
        const r = await fn(req(U('/api/mcp/x', `tenant_id=${R}`), { method, headers: { ...H(tok), 'Content-Type': 'application/json' }, body: { action: 'approve', id: 'd-r' } }), {});
        assert.equal(r.status, 405, `${method} ${tok}`);
      }
      const i = await fn(req(U('/api/mcp/x', `tenant_id=${R}`), { method, headers: { ...INTERNAL, 'Content-Type': 'application/json' }, body: {} }), {});
      assert.equal(i.status, 405);
    }
  }
  NOWRITE();
});

test('MCP_READ_ALLOW_OPERATOR=1 lets an operator read a non-member tenant by uuid; stealth stays read-only', async () => {
  await setup();
  process.env.MCP_READ_ALLOW_OPERATOR = '1';
  try {
    const r = await drafts(req(U('/api/mcp/lookup-drafts', `tenant_id=${A}`), { headers: H('op') }), {});
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).drafts.map((d) => d.id), ['d-a']);
    const x = await status(req(U('/api/mcp/account-status', `tenant_id=${R}`), { method: 'POST', headers: H('op') }), {});
    assert.equal(x.status, 405);
    // still no internal token
    const i = await status(req(U('/api/mcp/account-status', `tenant_id=${A}`), { headers: INTERNAL }), {});
    assert.equal(i.status, 403);
  } finally { delete process.env.MCP_READ_ALLOW_OPERATOR; }
  NOWRITE();
});

test('account_status: own tenant only, aggregates campaigns + hires + draft counts, hides goal/context', async () => {
  await setup();
  await S.putCampaign({ id: 'c-a', tenant_id: A, name: 'CA', status: 'active', daily_send_limit: 10, metrics: { prospects_enrolled: 3, queued_sends: 1, sent_today: 0, resend_id: 'SECRET' } });
  await S.putCampaign({ id: 'c-b', tenant_id: B, name: 'CB', status: 'active' });
  await S.putCampaign({ id: 'c-a-paused', tenant_id: A, name: 'CP', status: 'paused' });
  await S.putEmailSend({ id: 's-a', campaign_id: 'c-a', tenant_id: A, status: 'pending_approval', prospect_id: 'p1' });
  await S.putEmailSend({ id: 's-b', campaign_id: 'c-b', tenant_id: B, status: 'pending_approval', prospect_id: 'p2' });
  const r = await status(req(U('/api/mcp/account-status', 'tenant=tenant-a'), { headers: H('alice') }), {});
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.tenant.id, A);
  assert.equal(b.campaigns.total, 2);
  assert.equal(b.campaigns.active, 1);
  assert.deepEqual(b.campaigns.items.map((c) => c.id), ['c-a']);
  assert.deepEqual(b.workforce.hires.map((h) => h.id), ['h-a']);
  assert.equal(b.drafts.campaign_sends_pending, 1);
  assert.ok(!JSON.stringify(b).includes('secret goal'));
  assert.ok(!JSON.stringify(b).includes('secret ctx'));
  assert.ok(!JSON.stringify(b).includes('c-b'));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(b.campaigns.items[0].metrics, { prospects_enrolled: 3, queued_sends: 1, sent_today: 0 });
  NO_PROVIDER_IDS(b, 'account_status tenant-a');
  NOWRITE();
});

test('account_status for the home tenant reads the MASTER campaign data (one account)', async () => {
  await setup();
  await S.putCampaign({ id: 'c-home', tenant_id: T.MASTER_TENANT_ID, name: '1600 CEOs', status: 'active' });
  const r = await status(req(U('/api/mcp/account-status', 'tenant=a-gent'), { headers: H('homeuser') }), {});
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(b.campaigns.items.map((c) => c.id), ['c-home']);
  assert.equal(b.tenant.id, HOME);
});

test('read module contains no write/send/hunter code paths', async () => {
  const { readFileSync } = await import('node:fs');
  const src = ['_mcp-read.mjs', 'mcp-account-status.mjs', 'mcp-lookup-drafts.mjs']
    .map((f) => readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/method:\s*['"](POST|PATCH|PUT|DELETE)/i.test(src));
  assert.ok(!/putRecord|putCampaign|putEmailSend|putProspect|logActivity|resend|hunter|callLLM/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
});
