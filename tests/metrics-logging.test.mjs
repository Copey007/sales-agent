// Trivial activity_log writes for bounce / one-click unsub. Fetch is mocked.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { resetFetch, req } from './helpers/env.mjs';
import { listActivityLog, isEmailSuppressed } from '../netlify/functions/_campaign-store.mjs';
import { signUnsubToken } from '../netlify/functions/_email-compliance.mjs';

const inbound = (await import('../netlify/functions/inbound-webhook.mjs')).default;
const unsub = (await import('../netlify/functions/unsubscribe.mjs')).default;

const SVIX_KEY = Buffer.from('test-svix-secret-bytes-0123456789');
const SVIX = 'whsec_' + SVIX_KEY.toString('base64');
const now = () => Math.floor(Date.now() / 1000);
function svixHeaders(body, ts = now(), id = 'msg_metrics') {
  const sig = createHmac('sha256', SVIX_KEY).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'Content-Type': 'application/json' };
}

test('docs/metrics-logging.md maps frameworks metrics and marks warehouse work as plan-only', () => {
  const docs = readFileSync(new URL('../docs/metrics-logging.md', import.meta.url), 'utf8');
  for (const n of ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10']) {
    assert.match(docs, new RegExp(n.replace('.', '\\.')));
  }
  assert.match(docs, /Plan only/i);
  assert.match(docs, /deliverability_daily/);
  assert.match(docs, /suppression_event/);
  assert.match(docs, /one_click_unsubscribe/);
});

test('a signed bounce appends a suppression_event to activity_log', async () => {
  resetFetch();
  process.env.RESEND_WEBHOOK_SECRET = SVIX;
  const email = 'jane.metrics.bounce@prospect.test';
  const body = JSON.stringify({ type: 'email.bounced', data: { to: [email], email_id: 're_metrics_b' } });
  const r = await inbound(req('https://aisdr.example.test/api/inbound-webhook', {
    method: 'POST', headers: svixHeaders(body), body,
  }), {});
  assert.equal(r.status, 200);
  const events = (await listActivityLog(200)).filter((e) => e.type === 'suppression_event' && (e.emails || []).includes(email));
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'bounce');
  assert.equal(await isEmailSuppressed('t-acme', email), true);
});

test('a one-click POST appends one_click_unsubscribe to activity_log', async () => {
  resetFetch();
  const email = 'jane.metrics.unsub@prospect.test';
  const token = signUnsubToken({ email, tenantId: 't-acme' });
  const r = await unsub(req(`https://aisdr.example.test/api/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  }), {});
  assert.equal(r.status, 200);
  const events = (await listActivityLog(200)).filter((e) => e.type === 'one_click_unsubscribe' && e.email === email);
  assert.equal(events.length >= 1, true);
  assert.equal(await isEmailSuppressed('t-acme', email), true);
});
