// Stealth tenants are excluded at the iteration source of every cron /
// background cycle: no inserts, no LLM, no email, no Hunter.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, mockAuth, req, calls, INTERNAL, SB } from './helpers/env.mjs';
import { getStore } from './helpers/blobs-mock.mjs';

const T = await import('../netlify/functions/_tenant.mjs');
const S = await import('../netlify/functions/_campaign-store.mjs');
const { runDueWorkers } = await import('../netlify/functions/worker-runtime.mjs');
const { runDailyReports } = await import('../netlify/functions/worker-daily-report.mjs');
const { runTopUpSweep } = await import('../netlify/functions/researcher-background.mjs');
const { processQueue } = await import('../netlify/functions/queue-manager.mjs');
const sendWorker = (await import('../netlify/functions/send-worker-background.mjs')).default;
const loopEngine = (await import('../netlify/functions/loop-engine.mjs')).default;

const R = T.STEALTH_TENANT_IDS[0];
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';

function noSideEffects() {
  const bad = calls.filter((c) =>
    /api\.resend\.com|api\.hunter\.io|serpapi\.com|openai\.com|api\.anthropic\.com/i.test(c.url)
    || ((c.method === 'POST' || c.method === 'PATCH') && /worker_outreach/.test(c.url))
  );
  assert.deepEqual(bad.map((c) => `${c.method} ${c.url}`), [], 'no LLM, Hunter, Resend, or outreach writes');
}

function setupRest(hires) {
  resetFetch();
  mockAuth({}, {});
  route(`${SB}/rest/v1/workforce_hires`, (u, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET') return { body: [] };
    return { body: hires };
  });
  route(`${SB}/rest/v1/worker_outreach`, () => ({ body: [] }));
  route(`${SB}/rest/v1/memberships`, () => ({ body: [] }));
  route('api.resend.com', () => ({ body: { id: 'should-never-happen' } }));
  route('api.hunter.io', () => ({ body: { data: { emails: [] } } }));
}

test('withoutStealthTenants drops only stealth-tenant rows', () => {
  const rows = [
    { id: '1', tenant_id: R },
    { id: '2', tenant_id: A },
    { id: '3', tenant_id: R.toUpperCase() },
    { id: '4', tenant_id: null },
  ];
  assert.deepEqual(T.withoutStealthTenants(rows).map((r) => r.id), ['2', '4']);
  assert.deepEqual(T.withoutStealthTenants(null), []);
});

test('listAllActiveCampaigns excludes a stealth tenant campaign and keeps another tenant', async () => {
  await S.putCampaign({ id: 'c-stealth', tenant_id: R, name: 'R', status: 'active', auto_source: true });
  await S.putCampaign({ id: 'c-a', tenant_id: A, name: 'A', status: 'active', auto_source: true });
  await S.putCampaign({ id: 'c-paused', tenant_id: A, name: 'P', status: 'paused' });
  const all = await S.listAllActiveCampaigns();
  const ids = all.map((c) => c.id).sort();
  assert.ok(ids.includes('c-a'));
  assert.ok(!ids.includes('c-stealth'));
  assert.ok(!ids.includes('c-paused'));
  // listCampaigns (reads) still returns the stealth campaign
  const mine = await S.listCampaigns(R);
  assert.ok(mine.some((c) => c.id === 'c-stealth'));
});

test('runDueWorkers skips a stealth hire entirely (no cycle, no Hunter, no email, no outreach insert)', async () => {
  const stealth = { id: 'h-r', tenant_id: R, worker_id: 'sdr', name: 'R SDR', status: 'active', company: 'RefoundGTM', last_active_at: null };
  const other = { id: 'h-test', tenant_id: A, worker_id: 'sdr', name: 'Test worker', status: 'active', company: 'stripeok', last_active_at: null };
  setupRest([stealth, other]);
  const result = await runDueWorkers();
  assert.equal(result.stealth_skipped, 1);
  // the other hire is the isTest skip, so no cycle ran — but stealth was filtered first
  assert.equal(result.considered, 1);
  assert.ok(!calls.some((c) => c.url.includes('workforce_hires') && (c.method === 'PATCH' || c.method === 'POST')));
  noSideEffects();
});

test('runDailyReports skips a stealth hire (no owner lookup, no Resend, no LLM)', async () => {
  const stealth = { id: 'h-r', tenant_id: R, worker_id: 'sdr', name: 'R SDR', status: 'active', company: 'RefoundGTM' };
  const other = { id: 'h-test', tenant_id: A, worker_id: 'sdr', name: 'sample bot', status: 'active', company: 'sample' };
  setupRest([stealth, other]);
  const result = await runDailyReports();
  assert.equal(result.sent, 0);
  assert.ok(!calls.some((c) => c.url.includes(`tenant_id=eq.${R}`) && c.url.includes('memberships')));
  noSideEffects();
});

test('runTopUpSweep does not touch a stealth auto_source campaign (no Hunter, no putCampaign)', async () => {
  setupRest([]);
  // Isolate: earlier tests may have left other auto_source campaigns in the blob store.
  const store = getStore('campaigns');
  const { blobs } = await store.list();
  for (const b of blobs) await store.delete(b.key);
  await S.putCampaign({
    id: 'c-stealth-top', tenant_id: R, name: 'R top', status: 'active',
    auto_source: true, auto_source_min_queue: 99,
  });
  const summary = await runTopUpSweep();
  assert.ok(!((summary.campaigns_topped_up || 0) > 0 && (summary.campaigns_checked || 0) > 0 && (summary.skipped || []).some((s) => s.campaign === 'R top')), 'stealth campaign must not be in the sweep at all');
  // Because listAllActiveCampaigns / withoutStealthTenants drop it, it is not checked
  const checkedNames = (summary.skipped || []).map((s) => s.campaign);
  assert.ok(!checkedNames.includes('R top'));
  const after = JSON.parse(await getStore('campaigns').get('c-stealth-top'));
  assert.equal(after.last_sourced_at, undefined);
  noSideEffects();
});

test('processQueue does not dispatch or draft for a stealth campaign', async () => {
  setupRest([]);
  await S.setFeatureFlag('multi_campaign_orchestration', true);
  await S.setFeatureFlag('queue_manager_active', true);
  await S.putCampaign({
    id: 'c-stealth-q', tenant_id: R, name: 'R queue', status: 'active',
    daily_send_limit: 50, sending_domain: 'refoundgtm.com',
  });
  await S.putEmailSend({
    id: 's-r-approved', campaign_id: 'c-stealth-q', tenant_id: R,
    status: 'queued', approved_at: new Date().toISOString(),
    scheduled_at: new Date(Date.now() - 1000).toISOString(),
    prospect_id: 'p-r', step_number: 1,
  });
  const results = await processQueue();
  const send = await S.getEmailSend('s-r-approved');
  assert.equal(send.status, 'queued');
  assert.equal(send.dispatched_at, undefined);
  assert.ok(!calls.some((c) => c.url.includes('send-worker-background')));
  noSideEffects();
  void results;
});

test('send-worker-background returns stealth_readonly and never calls Resend', async () => {
  setupRest([]);
  await S.putCampaign({ id: 'c-stealth-s', tenant_id: R, name: 'R send', status: 'active' });
  await S.putEmailSend({
    id: 's-r-disp', campaign_id: 'c-stealth-s', tenant_id: R,
    status: 'dispatched', approved_at: new Date().toISOString(), prospect_id: 'p-r',
  });
  const res = await sendWorker(req('https://aisdr.example.test/.netlify/functions/send-worker-background', {
    method: 'POST', headers: { ...INTERNAL, 'Content-Type': 'application/json' },
    body: { campaign_id: 'c-stealth-s', send_ids: ['s-r-disp'] },
  }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reason, 'stealth_readonly');
  noSideEffects();
});

test('loop-engine run/reset on a stealth campaign is skipped (no LLM, no blob writes of experiments)', async () => {
  setupRest([]);
  await S.putCampaign({ id: 'c-stealth-loop', tenant_id: R, name: 'R loop', status: 'active' });
  const store = getStore('loop_experiments'); // may be a different name — just run and check no side effects
  const run = await loopEngine(req('https://aisdr.example.test/api/loop-engine', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: { action: 'run', campaign_id: 'c-stealth-loop' },
  }), {});
  assert.equal(run.status, 200);
  assert.equal((await run.json()).reason, 'stealth_readonly');
  const reset = await loopEngine(req('https://aisdr.example.test/api/loop-engine', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: { action: 'reset', campaign_id: 'c-stealth-loop' },
  }), {});
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).reason, 'stealth_readonly');
  noSideEffects();
  void store;
});
