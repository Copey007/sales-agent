// Outbound email is human-approval gated end-to-end; no open relay.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetFetch, route, mockAuth, req, INTERNAL, calls } from './helpers/env.mjs';

process.env.OPENAI_API_KEY = 'test-llm-key';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.COMPANY_POSTAL_ADDRESS = '1 Test Street, Testville';
process.env.UNSUBSCRIBE_EMAIL = 'unsubscribe@example.test';

const S = await import('../netlify/functions/_campaign-store.mjs');
const worker = (await import('../netlify/functions/send-worker-background.mjs')).default;
const admin = (await import('../netlify/functions/campaign-admin.mjs')).default;
const { invoke } = await import('../netlify/functions/_mcp-connectors.mjs');

const CID = 'camp-1', TID = 't-acme';
const resendCalls = () => calls.filter((c) => c.url.startsWith('https://api.resend.com'));
function mockLLM() {
  route('/chat/completions', () => ({ body: { choices: [{ message: { content: JSON.stringify({ subject: 'Draft subject', body: 'Hi Jane,\n\nDraft body.', signals_used: [] }) } }] } }));
  route('api.resend.com', () => ({ body: { id: 'resend-123' } }));
}
async function seed(sendPatch = {}, prospectPatch = {}) {
  await S.putCampaign({ id: CID, tenant_id: TID, name: 'C', status: 'active', sending_domain: 'example.test' });
  await S.putProspect({ id: 'p-1', email: 'jane@prospect.test', contact_name: 'Jane Doe', company_name: 'Prospect Co', ...prospectPatch });
  await S.putEmailSend({ id: 's-1', campaign_id: CID, tenant_id: TID, prospect_id: 'p-1', step_number: 1, status: 'dispatched', scheduled_at: new Date().toISOString(), ...sendPatch });
}
const run = (headers = INTERNAL, body = { campaign_id: CID, send_ids: ['s-1'] }) =>
  worker(req('https://aisdr.example.test/.netlify/functions/send-worker-background', { method: 'POST', headers, body }), {});

test('send-worker-background rejects callers without the internal token', async () => {
  resetFetch(); mockLLM(); await seed();
  assert.equal((await run({})).status, 403);
  assert.equal((await run({ 'X-Internal-Token': 'wrong' })).status, 403);
  const saved = process.env.INTERNAL_API_TOKEN; delete process.env.INTERNAL_API_TOKEN;
  try { assert.equal((await run()).status, 503); } finally { process.env.INTERNAL_API_TOKEN = saved; }
  assert.equal(resendCalls().length, 0);
  assert.equal((await S.getEmailSend('s-1')).status, 'dispatched');
});

test('unapproved send is drafted to pending_approval — nothing is emailed', async () => {
  resetFetch(); mockLLM(); await seed();
  const r = await run(); assert.equal(r.status, 200);
  const s = await S.getEmailSend('s-1');
  assert.equal(s.status, 'pending_approval');
  assert.equal(s.email_subject, 'Draft subject');
  assert.match(s.email_body, /Draft body/);
  assert.equal(resendCalls().length, 0);
});

test('only dispatched sends are processed (sent / pending / rejected are skipped)', async () => {
  for (const status of ['sent', 'pending_approval', 'rejected', 'queued']) {
    resetFetch(); mockLLM(); await seed({ status, approved_at: '2026-01-01T00:00:00Z', email_subject: 'x', email_body: 'y' });
    await run();
    assert.equal((await S.getEmailSend('s-1')).status, status, status);
    assert.equal(resendCalls().length, 0, status);
  }
});

test('approved send delivers exactly the approved text + compliance footer + List-Unsubscribe', async () => {
  resetFetch(); mockLLM();
  await seed({ approved_at: '2026-01-01T00:00:00Z', email_subject: 'Edited subject', email_body: 'Edited body by a human.' });
  await run();
  const rc = resendCalls(); assert.equal(rc.length, 1);
  const sent = JSON.parse(rc[0].body);
  assert.equal(sent.subject, 'Edited subject');
  assert.ok(sent.text.startsWith('Edited body by a human.'));
  assert.match(sent.text, /1 Test Street, Testville/);
  assert.match(sent.text, /unsubscribe/i);
  assert.match(sent.headers['List-Unsubscribe'], /^<mailto:unsubscribe@example\.test\?subject=unsubscribe>/);
  assert.match(sent.headers['List-Unsubscribe'], /https:\/\/aisdr\.example\.test\/api\/unsubscribe\?token=/);
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.deepEqual(sent.to, ['jane@prospect.test']);
  assert.equal(calls.filter((c) => c.url.includes('/chat/completions')).length, 0, 'no regeneration of approved text');
  assert.equal((await S.getEmailSend('s-1')).status, 'sent');
});

test('approved send without COMPANY_POSTAL_ADDRESS is blocked, not sent', async () => {
  resetFetch(); mockLLM();
  const saved = process.env.COMPANY_POSTAL_ADDRESS; delete process.env.COMPANY_POSTAL_ADDRESS;
  try {
    await seed({ approved_at: '2026-01-01T00:00:00Z', email_subject: 'a', email_body: 'b' });
    await run();
    assert.equal(resendCalls().length, 0);
    assert.equal((await S.getEmailSend('s-1')).status, 'queued');
  } finally { process.env.COMPANY_POSTAL_ADDRESS = saved; }
});

test('suppressed or replied prospects are never emailed, even if approved', async () => {
  resetFetch(); mockLLM();
  await seed({ approved_at: '2026-01-01T00:00:00Z', email_subject: 'a', email_body: 'b' });
  await S.addToSuppressionList({ tenant_id: TID, email: 'jane@prospect.test' });
  await run();
  assert.equal((await S.getEmailSend('s-1')).status, 'suppressed');
  assert.equal(resendCalls().length, 0);
  resetFetch(); mockLLM();
  await S.putEmailSend({ id: 's-2', campaign_id: CID, tenant_id: TID, prospect_id: 'p-2', step_number: 1, status: 'dispatched', approved_at: '2026-01-01T00:00:00Z', email_subject: 'a', email_body: 'b' });
  await S.putProspect({ id: 'p-2', email: 'joe@prospect.test', contact_name: 'Joe', company_name: 'P', replied_at: '2026-01-02T00:00:00Z' });
  await run(INTERNAL, { campaign_id: CID, send_ids: ['s-2'] });
  assert.equal((await S.getEmailSend('s-2')).status, 'cancelled_replied');
  assert.equal(resendCalls().length, 0);
});

const confirmed = '2026-01-01T00:00:00Z';
const USERS = {
  member: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed },
  other: { id: 'u-oth', email: 'x@other.test', email_confirmed_at: confirmed },
};
const MEMBERS = {
  'u-mem': [{ role: 'owner', tenant_id: TID, tenants: { id: TID, slug: 'acme' } }],
  'u-oth': [{ role: 'owner', tenant_id: 't-other', tenants: { id: 't-other', slug: 'other' } }],
};
const call = (action, token, body) => admin(req(`https://aisdr.example.test/api/campaign-admin?action=${action}`, {
  method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, body }), {});

test('campaign-admin approval queue is tenant-scoped; approve re-queues with edits', async () => {
  resetFetch(); mockAuth(USERS, MEMBERS);
  await seed({ status: 'pending_approval', email_subject: 'Draft', email_body: 'Body' });
  const other = await (await call('list_pending', 'other')).json();
  assert.equal(other.count, 0, 'other tenant cannot see drafts');
  const otherApprove = await (await call('approve_sends', 'other', { send_ids: ['s-1'] })).json();
  assert.equal(otherApprove.updated, 0);
  assert.equal((await S.getEmailSend('s-1')).status, 'pending_approval');

  const mine = await (await call('list_pending', 'member')).json();
  assert.equal(mine.count, 1); assert.equal(mine.pending[0].to, 'jane@prospect.test');
  const ok = await (await call('approve_sends', 'member', { send_ids: ['s-1'], edits: { 's-1': { subject: 'Final', body: 'Final body' } } })).json();
  assert.equal(ok.updated, 1);
  const s = await S.getEmailSend('s-1');
  assert.equal(s.status, 'queued'); assert.ok(s.approved_at); assert.equal(s.approved_by, 'cust@acme.test');
  assert.equal(s.email_subject, 'Final'); assert.equal(s.email_body, 'Final body');
  assert.equal(resendCalls().length, 0, 'approval itself sends nothing');
});

test('campaign-admin reject marks the draft rejected', async () => {
  resetFetch(); mockAuth(USERS, MEMBERS);
  await seed({ status: 'pending_approval', email_subject: 'Draft', email_body: 'Body' });
  const r = await (await call('reject_sends', 'member', { send_ids: ['s-1'], reason: 'off-brand' })).json();
  assert.equal(r.updated, 1);
  assert.equal((await S.getEmailSend('s-1')).status, 'rejected');
});

test('relay closed: generic resend.send connector refuses to send', async () => {
  resetFetch(); mockLLM();
  await assert.rejects(() => invoke('resend', 'send', { to: 'victim@x.test', from: 'ceo@a-gent.co', subject: 's', html: 'h' }), /disabled/);
  assert.equal(resendCalls().length, 0);
});
test('relay closed: no agent code path calls resend.send', () => {
  const src = readFileSync(new URL('../netlify/functions/_agent-registry.mjs', import.meta.url), 'utf8');
  assert.equal(/use\(\s*['"]resend['"]\s*,\s*['"]send['"]/.test(src), false);
});
test('relay closed: /api/workforce execute/delegate/memory require operator or internal token', async () => {
  resetFetch(); mockAuth(USERS, MEMBERS);
  const wf = (await import('../netlify/functions/workforce.mjs')).default;
  for (const action of ['execute', 'delegate', 'memory', 'connectors', 'tasks']) {
    const anon = await wf(req('https://aisdr.example.test/api/workforce', { method: 'POST', body: { action, agent: 'sdr', objective: 'x', context: { toEmail: 'victim@x.test' } } }), {});
    assert.equal(anon.status, 401, `${action} anon`);
    const member = await wf(req('https://aisdr.example.test/api/workforce', { method: 'POST', headers: { Authorization: 'Bearer member' }, body: { action } }), {});
    assert.equal(member.status, 403, `${action} member`);
  }
  assert.equal(resendCalls().length, 0);
});
test('workforce GET roster is public but strips live task text', async () => {
  resetFetch();
  route('/rest/v1/agent_registry', () => ({ body: [{ agent_id: 'sdr', name: 'SDR', status: 'idle', current_task: 'secret tenant objective', last_action: 'emailed bob' }] }));
  const wf = (await import('../netlify/functions/workforce.mjs')).default;
  const r = await wf(req('https://aisdr.example.test/api/workforce'), {});
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.equal(text.includes('secret tenant objective'), false);
  assert.equal(text.includes('emailed bob'), false);
});

test('queue-manager dispatches with the internal token and reverts on worker failure', async () => {
  resetFetch();
  await S.putEmailSend({ id: 's-1', status: 'archived' });
  await S.setFeatureFlag('queue_manager_active', true);
  await S.setFeatureFlag('multi_campaign_orchestration', true);
  await S.putCampaign({ id: CID, tenant_id: TID, name: 'C', status: 'active', daily_send_limit: 10 });
  await S.putProspect({ id: 'p-9', email: 'q@prospect.test', contact_name: 'Q', company_name: 'P' });
  await S.putEmailSend({ id: 's-9', campaign_id: CID, tenant_id: TID, prospect_id: 'p-9', step_number: 2, status: 'queued', scheduled_at: '2020-01-01T00:00:00Z' });
  route('send-worker-background', () => ({ status: 403, body: { error: 'forbidden' } }));
  const qm = (await import('../netlify/functions/queue-manager.mjs')).default;
  await qm(req('https://aisdr.example.test/.netlify/functions/queue-manager', { method: 'POST' }), {});
  const wc = calls.filter((c) => c.url.includes('send-worker-background'));
  assert.ok(wc.length >= 1, 'worker invoked');
  assert.equal(wc[0].headers.get('x-internal-token'), process.env.INTERNAL_API_TOKEN);
  assert.equal((await S.getEmailSend('s-9')).status, 'queued', 'reverted after non-2xx');
});
