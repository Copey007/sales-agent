// Bounce / complaint / unsubscribe webhooks write the suppression list.
// Signatures are Svix; missing or bad secrets fail closed. Fetch is mocked.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { resetFetch, route, mockAuth, req, calls } from './helpers/env.mjs';
import {
  isEmailSuppressed, addToSuppressionList, putProspect, putEmailSend, getEmailSend,
} from '../netlify/functions/_campaign-store.mjs';
import { isOptOutMessage, extractEmails } from '../netlify/functions/inbound-webhook.mjs';

const inbound = (await import('../netlify/functions/inbound-webhook.mjs')).default;
const wo = (await import('../netlify/functions/worker-outreach.mjs')).default;

const SVIX_KEY = Buffer.from('test-svix-secret-bytes-0123456789');
const SVIX = 'whsec_' + SVIX_KEY.toString('base64');
const now = () => Math.floor(Date.now() / 1000);
function svixHeaders(body, ts = now(), id = 'msg_sup') {
  const sig = createHmac('sha256', SVIX_KEY).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'Content-Type': 'application/json' };
}
function postEvent(payload, headers) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  process.env.RESEND_WEBHOOK_SECRET = SVIX;
  return inbound(req('https://aisdr.example.test/api/inbound-webhook', {
    method: 'POST',
    headers: headers || svixHeaders(body),
    body,
  }), {});
}
const resendCalls = () => calls.filter((c) => c.url.startsWith('https://api.resend.com'));

test('extractEmails and isOptOutMessage helpers', () => {
  assert.deepEqual(extractEmails(['Jane <jane@x.test>', 'other@x.test']), ['jane@x.test', 'other@x.test']);
  assert.equal(isOptOutMessage('unsubscribe', ''), true);
  assert.equal(isOptOutMessage('', 'Stop\n\nPlease take me off this list'), true);
  assert.equal(isOptOutMessage('Re: intro', 'Thanks for reaching out — interested.'), false);
});

test('isEmailSuppressed lowercases and honours the global * key', async () => {
  const email = 'Jane.Global.Star@Prospect.Test';
  await addToSuppressionList({ tenant_id: '*', email, reason: 'seed' });
  assert.equal(await isEmailSuppressed('t-acme', email), true);
  assert.equal(await isEmailSuppressed('t-other', email.toLowerCase()), true);
  assert.equal(await isEmailSuppressed('t-acme', 'untouched.global@prospect.test'), false);
});

test('unsigned bounce is 401 and writes no suppression', async () => {
  resetFetch();
  const email = 'jane.unsigned.bounce@prospect.test';
  const body = JSON.stringify({ type: 'email.bounced', data: { to: [email], email_id: 're_u' } });
  const r = await postEvent(body, { 'Content-Type': 'application/json' });
  assert.equal(r.status, 401);
  assert.equal(await isEmailSuppressed('t-acme', email), false);
  assert.equal(await isEmailSuppressed('*', email), false);
  assert.equal(resendCalls().length, 0);
});

test('bounce / complaint fail closed when RESEND_WEBHOOK_SECRET is unset', async () => {
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  try {
    const email = 'jane.nosecret.bounce@prospect.test';
    const body = JSON.stringify({ type: 'email.bounced', data: { to: [email] } });
    const r = await inbound(req('https://aisdr.example.test/api/inbound-webhook', {
      method: 'POST', headers: svixHeaders(body), body,
    }), {});
    assert.equal(r.status, 401);
    assert.equal(await isEmailSuppressed('*', email), false);
  } finally {
    if (saved !== undefined) process.env.RESEND_WEBHOOK_SECRET = saved;
    else delete process.env.RESEND_WEBHOOK_SECRET;
  }
});

test('signed bounce suppresses the recipient, marks the send, cancels follow-ups, and does not forward', async () => {
  resetFetch();
  const email = 'jane.bounce@prospect.test';
  await putProspect({ id: 'p-bounce-1', email, tenant_id: 't-acme', contact_name: 'Jane' });
  await putEmailSend({
    id: 's-bounce-1', campaign_id: 'c-b', tenant_id: 't-acme', prospect_id: 'p-bounce-1',
    status: 'sent', resend_result: { resend_id: 're_bounce_1' },
  });
  await putEmailSend({
    id: 's-bounce-fu', campaign_id: 'c-b', tenant_id: 't-acme', prospect_id: 'p-bounce-1',
    status: 'queued', step_number: 2,
  });
  route('api.resend.com', () => ({ body: { id: 'should-not-send' } }));
  const r = await postEvent({
    type: 'email.bounced',
    data: { email_id: 're_bounce_1', to: [`Jane <${email}>`] },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.event, 'email.bounced');
  assert.equal(await isEmailSuppressed('t-acme', email), true);
  assert.equal((await getEmailSend('s-bounce-1')).status, 'bounced');
  assert.equal((await getEmailSend('s-bounce-fu')).status, 'cancelled_suppressed');
  assert.equal(resendCalls().length, 0);
});

test('signed complaint suppresses the recipient', async () => {
  resetFetch();
  const email = 'jane.complaint@prospect.test';
  await putProspect({ id: 'p-complaint-1', email, tenant_id: 't-acme' });
  const r = await postEvent({
    type: 'email.complained',
    data: { to: [email], email_id: 're_comp_1' },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).event, 'email.complained');
  assert.equal(await isEmailSuppressed('t-acme', email), true);
  assert.equal(resendCalls().length, 0);
});

test('bounce with no known tenant still suppresses globally', async () => {
  resetFetch();
  const email = 'jane.unknown.tenant@prospect.test';
  const r = await postEvent({ type: 'email.bounced', data: { to: [email] } });
  assert.equal(r.status, 200);
  assert.equal(await isEmailSuppressed('t-acme', email), true);
  assert.equal(await isEmailSuppressed('t-other', email.toUpperCase()), true);
});

test('a second identical bounce is idempotent', async () => {
  resetFetch();
  const email = 'jane.bounce.idem@prospect.test';
  const payload = { type: 'email.bounced', data: { to: [email] } };
  assert.equal((await postEvent(payload)).status, 200);
  assert.equal((await postEvent(payload)).status, 200);
  assert.equal(await isEmailSuppressed('t-acme', email), true);
});

test('email.delivered is ignored and does not suppress or forward', async () => {
  resetFetch();
  const email = 'jane.delivered@prospect.test';
  const r = await postEvent({ type: 'email.delivered', data: { to: [email] } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ignored, 'email.delivered');
  assert.equal(await isEmailSuppressed('t-acme', email), false);
  assert.equal(resendCalls().length, 0);
});

test('an inbound reply that starts with unsubscribe is added to the suppression list', async () => {
  resetFetch();
  const email = 'jane.optout@prospect.test';
  await putProspect({ id: 'p-optout-1', email, tenant_id: 't-acme' });
  await putEmailSend({
    id: 's-optout-fu', campaign_id: 'c-o', tenant_id: 't-acme', prospect_id: 'p-optout-1',
    status: 'queued',
  });
  const r = await postEvent({
    type: 'email.received',
    data: { from: `Jane <${email}>`, to: 'james@a-gent.co', subject: 'unsubscribe', text: 'unsubscribe' },
  });
  assert.equal(r.status, 200);
  assert.equal(await isEmailSuppressed('t-acme', email), true);
  assert.equal((await getEmailSend('s-optout-fu')).status, 'cancelled_suppressed');
});

// ── worker-outreach also checks suppression before Resend ──
const confirmed = '2026-01-01T00:00:00Z';
const USERS = { member: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed } };
const MEMBERS = { 'u-mem': [{ role: 'owner', tenant_id: 't-acme', tenants: { id: 't-acme', slug: 'acme' } }] };

test('worker-outreach approve of a suppressed address is 409 and never reaches Resend', async () => {
  resetFetch();
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.COMPANY_POSTAL_ADDRESS = '1 Test Street, Testville';
  const email = 'jane.wo.suppressed@prospect.test';
  await addToSuppressionList({ tenant_id: 't-acme', email, reason: 'bounce' });
  const draft = {
    id: 'd-sup', tenant_id: 't-acme', status: 'pending',
    worker_name: 'James', from_email: 'james@a-gent.co',
    prospect_email: email, subject: 'Hi', body: 'Hello',
  };
  mockAuth(USERS, MEMBERS);
  route('/rest/v1/worker_outreach', (u, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'PATCH') {
      Object.assign(draft, JSON.parse(init.body));
      return { body: [draft] };
    }
    if (u.includes('id=eq.d-sup')) return { body: [draft] };
    return { body: [] };
  });
  route('api.resend.com', () => ({ body: { id: 'should-not-send' } }));
  const res = await wo(req('https://aisdr.example.test/api/worker-outreach', {
    method: 'POST',
    headers: { Authorization: 'Bearer member' },
    body: { id: 'd-sup', action: 'approve' },
  }), {});
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.suppressed, true);
  assert.equal(draft.status, 'rejected');
  assert.equal(resendCalls().length, 0);
});
