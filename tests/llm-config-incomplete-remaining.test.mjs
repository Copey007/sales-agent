// Remaining AI callers must refuse a partial LLM_API_KEY / LLM_API_BASE pair
// with llm_config_incomplete — no fallback fetch, no paid calls, no secret leaks.
import './helpers/env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetFetch, route, req, calls, SB, mockAuth, INTERNAL } from './helpers/env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const copilot = (await import('../netlify/functions/copilot.mjs')).default;
const gtmBrain = (await import('../netlify/functions/gtm-brain.mjs')).default;
const workerRuntime = (await import('../netlify/functions/worker-runtime.mjs')).default;
const { runDueWorkers } = await import('../netlify/functions/worker-runtime.mjs');
const workerDaily = (await import('../netlify/functions/worker-daily-report.mjs')).default;
const { runDailyReports } = await import('../netlify/functions/worker-daily-report.mjs');
const slideNarrate = (await import('../netlify/functions/slide-narrate.mjs')).default;
const { icpDiscoverCompanies } = await import('../netlify/functions/_icp-agent.mjs');
const sendWorker = (await import('../netlify/functions/send-worker-background.mjs')).default;
const S = await import('../netlify/functions/_campaign-store.mjs');

const confirmed = '2026-01-01T00:00:00Z';
const TID = 't-acme';
const USERS = {
  member: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed },
};
const MEMBERS = {
  'u-mem': [{ role: 'owner', tenant_id: TID, tenants: { id: TID, slug: 'acme', name: 'Acme' } }],
};
const AUTH = { Authorization: 'Bearer member' };
const HIRE = {
  id: 'h-llm-inc',
  tenant_id: TID,
  status: 'active',
  name: 'Alex Stone',
  title: 'Analyst',
  worker_id: 'analyst',
  company: 'Acme',
  goal: 'help the team',
  activity: [],
};
const CID = 'camp-llm-inc';
const SEND_ID = 's-llm-inc';
const PROSPECT_ID = 'p-llm-inc';
const SECRETS = ['llm-only-test-key', 'openai-only-test-key', 'sk-test-secret-should-not-appear'];

const CALLERS = [
  'netlify/functions/copilot.mjs',
  'netlify/functions/gtm-brain.mjs',
  'netlify/functions/worker-runtime.mjs',
  'netlify/functions/worker-daily-report.mjs',
  'netlify/functions/slide-narrate.mjs',
  'netlify/functions/_icp-agent.mjs',
  'netlify/functions/send-worker-background.mjs',
];

beforeEach(() => {
  resetFetch();
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_API_BASE;
  delete process.env.LLM_MODEL;
  delete process.env.OPENAI_API_BASE;
  delete process.env.HUNTER_API_KEY;
  delete process.env.RESEND_API_KEY;
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
});

function chatCalls() {
  return calls.filter((c) => c.url.includes('/chat/completions'));
}
function hunterCalls() {
  return calls.filter((c) => c.url.includes('hunter.io'));
}
function resendCalls() {
  return calls.filter((c) => c.url.includes('api.resend.com'));
}
function noChatCalls() {
  assert.equal(chatCalls().length, 0);
}
function assertNoLeak(text, ...secrets) {
  const dumped = typeof text === 'string' ? text : JSON.stringify(text);
  for (const s of secrets) {
    if (s) assert.equal(dumped.includes(s), false, `leaked ${s}`);
  }
  assert.equal(/Bearer\s+\S+/i.test(dumped), false);
}

function setupCommonRoutes() {
  // Register memberships first so tenant_id lookups (daily-report owner email)
  // are not swallowed by mockAuth's user_id-only handler.
  route(`${SB}/rest/v1/memberships`, (u) => {
    if (u.includes('tenant_id=eq.')) {
      return { body: [{ user_id: 'u-mem', role: 'owner', tenant_id: TID }] };
    }
    const m = /user_id=eq\.([^&]+)/.exec(u);
    return { body: (m && MEMBERS[decodeURIComponent(m[1])]) || [] };
  });
  route(`${SB}/auth/v1/admin/users/`, () => ({ body: { email: 'cust@acme.test' } }));
  mockAuth(USERS, MEMBERS);
  route(`${SB}/rest/v1/workforce_hires`, () => ({ body: [HIRE] }));
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: 'should-not-run' } }] } }));
  route('api.hunter.io', () => ({ body: { data: { organizations: [{ domain: 'acme.com', organization: 'Acme' }] } } }));
  route('api.resend.com', () => ({ body: { id: 'resend-should-not-run' } }));
  process.env.RESEND_API_KEY = 'test-resend-key';
}

async function seedSend() {
  await S.putCampaign({ id: CID, tenant_id: TID, name: 'C', status: 'active', sending_domain: 'example.test' });
  await S.putProspect({ id: PROSPECT_ID, email: 'jane@prospect.test', contact_name: 'Jane Doe', company_name: 'Prospect Co' });
  await S.putEmailSend({
    id: SEND_ID,
    campaign_id: CID,
    tenant_id: TID,
    prospect_id: PROSPECT_ID,
    step_number: 1,
    status: 'dispatched',
    scheduled_at: new Date().toISOString(),
  });
}

async function assert502(res, label) {
  assert.equal(res.status, 502, label);
  const body = await res.json();
  assert.equal(body.error, 'llm_config_incomplete', label);
  assertNoLeak(body, ...SECRETS);
  noChatCalls();
  return body;
}

async function assertAllHttpCallers(label) {
  setupCommonRoutes();

  const coach = await copilot(req('https://aisdr.example.test/api/copilot', {
    method: 'POST',
    body: { action: 'coach', transcript: [{ speaker: 'Rep', text: 'How are things going?' }] },
  }));
  await assert502(coach, `${label} copilot coach`);

  resetFetch();
  setupCommonRoutes();
  const summarize = await copilot(req('https://aisdr.example.test/api/copilot', {
    method: 'POST',
    body: { action: 'summarize', transcript: [{ speaker: 'Rep', text: 'Thanks for the time.' }] },
  }));
  await assert502(summarize, `${label} copilot summarize`);

  resetFetch();
  setupCommonRoutes();
  const gtm = await gtmBrain(req('https://aisdr.example.test/api/gtm-brain', {
    method: 'POST',
    headers: AUTH,
    body: { action: 'analyze', filename: 'export.csv', text: 'name,email\nPat,pat@acme.test' },
  }));
  await assert502(gtm, `${label} gtm-brain`);

  resetFetch();
  setupCommonRoutes();
  const runtime = await workerRuntime(req('https://aisdr.example.test/api/worker-runtime', {
    method: 'POST',
    headers: AUTH,
    body: { hire_id: HIRE.id },
  }));
  await assert502(runtime, `${label} worker-runtime`);

  resetFetch();
  setupCommonRoutes();
  const daily = await workerDaily(req('https://aisdr.example.test/api/worker-daily-report', {
    method: 'POST',
    headers: AUTH,
    body: { hire_id: HIRE.id },
  }));
  await assert502(daily, `${label} worker-daily-report`);
  assert.equal(resendCalls().length, 0, `${label} daily report must not send email`);

  resetFetch();
  setupCommonRoutes();
  const narrate = await slideNarrate(req('https://aisdr.example.test/api/slide-narrate', {
    method: 'POST',
    headers: AUTH,
    body: { slide_url: 'https://example.test/slide.png', title: 'Overview' },
  }));
  await assert502(narrate, `${label} slide-narrate`);

  resetFetch();
  setupCommonRoutes();
  await seedSend();
  const worker = await sendWorker(req('https://aisdr.example.test/.netlify/functions/send-worker-background', {
    method: 'POST',
    headers: INTERNAL,
    body: { campaign_id: CID, send_ids: [SEND_ID] },
  }), {});
  const workerBody = await assert502(worker, `${label} send-worker-background`);
  assert.equal(workerBody.success, undefined);
  assert.equal((await S.getEmailSend(SEND_ID)).status, 'dispatched');
  assert.equal(resendCalls().length, 0, `${label} send-worker must not email`);
}

test('remaining callers import isLlmConfigIncompleteError and go through shared _llm.mjs', () => {
  for (const rel of CALLERS) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /isLlmConfigIncompleteError/, rel);
    assert.match(src, /from ['"]\.\/_llm\.mjs['"]/, rel);
    assert.equal(src.includes('/chat/completions'), false, rel);
    assert.equal(src.includes("env.get('OPENAI_API_KEY')"), false, rel);
    assert.equal(src.includes("env.get('LLM_API_KEY')"), false, rel);
  }
});

test('LLM_API_KEY set without LLM_API_BASE: remaining callers refuse, no fallback fetch, no leak', async () => {
  process.env.LLM_API_KEY = 'llm-only-test-key';
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1';
  delete process.env.LLM_API_BASE;

  await assertAllHttpCallers('key-without-base');

  resetFetch();
  setupCommonRoutes();
  const parsed = await icpDiscoverCompanies('B2B SaaS companies with 15 to 100 employees', 'CRO', 'test-hunter-key');
  assert.deepEqual(parsed.companies, []);
  assert.equal(parsed.mode, 'llm_config_incomplete');
  assert.equal(parsed.transient, true);
  assertNoLeak(parsed, ...SECRETS);
  noChatCalls();
  assert.equal(hunterCalls().length, 0, 'parse abort must not call Hunter');

  resetFetch();
  setupCommonRoutes();
  const due = await runDueWorkers();
  assert.equal(due.ran, 0);
  noChatCalls();

  resetFetch();
  setupCommonRoutes();
  const reports = await runDailyReports();
  assert.equal(reports.sent, 0);
  assert.equal(resendCalls().length, 0);
  noChatCalls();
});

test('LLM_API_BASE set without LLM_API_KEY: remaining callers refuse, never send OPENAI_API_KEY, no leak', async () => {
  delete process.env.LLM_API_KEY;
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1';
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
  process.env.OPENAI_API_BASE = 'https://api.openai.com/v1';

  await assertAllHttpCallers('base-without-key');

  resetFetch();
  setupCommonRoutes();
  const parsed = await icpDiscoverCompanies('fintech companies with 50 to 200 employees', 'CFO', 'test-hunter-key');
  assert.deepEqual(parsed.companies, []);
  assert.equal(parsed.mode, 'llm_config_incomplete');
  assert.equal(parsed.transient, true);
  assertNoLeak(parsed, ...SECRETS);
  noChatCalls();
  assert.equal(hunterCalls().length, 0);
});

test('_icp-agent screening aborts on llm_config_incomplete and does not fall back to heuristic keep', async () => {
  const icp = 'cybersecurity companies with 20 to 80 employees — unique cache key';
  process.env.LLM_API_KEY = 'llm-only-test-key';
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1';
  process.env.OPENAI_API_KEY = 'openai-only-test-key';
  // Chat route must be registered first so it wins over any later default.
  route('/chat/completions', () => ({
    body: { choices: [{ message: { content: '{"query":"cybersecurity companies with 20 to 80 employees","exclude_domains":[],"exclude_keywords":[],"keep":["acme.com"]}' } }] },
  }));
  route('api.hunter.io', () => ({ body: { data: { organizations: [{ domain: 'acme.com', organization: 'Acme' }] } } }));

  const first = await icpDiscoverCompanies(icp, 'CISO', 'test-hunter-key');
  assert.ok(first.companies.some((c) => c.domain === 'acme.com'), JSON.stringify(first));
  assert.ok(chatCalls().length >= 1);

  resetFetch();
  setupCommonRoutes();
  delete process.env.LLM_API_KEY;
  process.env.LLM_API_BASE = 'https://api.anthropic.com/v1';

  const second = await icpDiscoverCompanies(icp, 'CISO', 'test-hunter-key');
  assert.deepEqual(second.companies, []);
  assert.equal(second.mode, 'llm_config_incomplete');
  assert.equal(second.transient, true);
  assertNoLeak(second, ...SECRETS);
  noChatCalls();
  assert.ok(hunterCalls().length >= 1, 'cached parse still queries Hunter before the screen abort');
});
