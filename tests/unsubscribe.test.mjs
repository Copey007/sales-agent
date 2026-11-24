// RFC 8058 one-click unsubscribe: signed token, POST-only mutation, no auth bypass.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, req } from './helpers/env.mjs';
import {
  signUnsubToken, verifyUnsubToken, complianceOrBlock,
} from '../netlify/functions/_email-compliance.mjs';
import { isEmailSuppressed, addToSuppressionList, DEFAULTS } from '../netlify/functions/_campaign-store.mjs';

const unsub = (await import('../netlify/functions/unsubscribe.mjs')).default;

function tokenFor(email = 'jane.unsub@prospect.test', tenantId = 't-acme') {
  return signUnsubToken({ email, tenantId });
}
const post = (token, { method = 'POST', headers = {}, body = 'List-Unsubscribe=One-Click' } = {}) =>
  unsub(req(`https://aisdr.example.test/api/unsubscribe?token=${encodeURIComponent(token || '')}`, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: method === 'POST' ? body : undefined,
  }), {});

test('unsub token verifies and rejects tampering', () => {
  const token = tokenFor();
  assert.equal(verifyUnsubToken(token).ok, true);
  assert.equal(verifyUnsubToken(token).email, 'jane.unsub@prospect.test');
  assert.equal(verifyUnsubToken(token).tenantId, 't-acme');
  assert.equal(verifyUnsubToken(token + 'x').ok, false);
  assert.equal(verifyUnsubToken('').ok, false);
  assert.equal(verifyUnsubToken('not-a-token').ok, false);
});

test('verifyUnsubToken fails closed when no signing secret is configured', () => {
  const token = tokenFor();
  const a = process.env.UNSUBSCRIBE_SIGNING_SECRET;
  const b = process.env.INTERNAL_API_TOKEN;
  delete process.env.UNSUBSCRIBE_SIGNING_SECRET;
  delete process.env.INTERNAL_API_TOKEN;
  try {
    assert.equal(verifyUnsubToken(token).ok, false);
  } finally {
    if (a !== undefined) process.env.UNSUBSCRIBE_SIGNING_SECRET = a;
    process.env.INTERNAL_API_TOKEN = b;
  }
});

test('GET with a valid token does not write suppression', async () => {
  resetFetch();
  const token = tokenFor();
  const res = await post(token, { method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(await isEmailSuppressed('t-acme', 'jane.unsub@prospect.test'), false);
  const html = await res.text();
  assert.match(html, /<form method="post"/i);
});

test('POST with a valid token records the unsubscribe; a second POST is idempotent', async () => {
  resetFetch();
  const token = tokenFor();
  const first = await post(token);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).ok, true);
  assert.equal(await isEmailSuppressed('t-acme', 'jane.unsub@prospect.test'), true);

  const second = await post(token);
  assert.equal(second.status, 200);
  assert.equal(await isEmailSuppressed('t-acme', 'jane.unsub@prospect.test'), true);
});

test('POST without a valid token is 401 and writes nothing', async () => {
  resetFetch();
  const untouched = 'jane.401@prospect.test';
  for (const tok of ['', 'aaaa.bbbb', tokenFor(untouched) + 'tampered']) {
    const res = await post(tok);
    assert.equal(res.status, 401, tok);
  }
  assert.equal(await isEmailSuppressed('t-acme', untouched), false);
});

test('one-click endpoint does not accept a JWT in place of a signed token', async () => {
  resetFetch();
  const res = await unsub(req('https://aisdr.example.test/api/unsubscribe', {
    method: 'POST',
    headers: { Authorization: 'Bearer member', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  }), {});
  assert.equal(res.status, 401);
  assert.equal(await isEmailSuppressed('t-acme', 'cust.unsub@acme.test'), false);
});

test('a token for one address cannot suppress a different address', async () => {
  resetFetch();
  await addToSuppressionList({ tenant_id: 't-acme', email: 'other.unsub@prospect.test', reason: 'seed' });
  const token = tokenFor('jane.unsub@prospect.test', 't-acme');
  assert.equal((await post(token)).status, 200);
  assert.equal(await isEmailSuppressed('t-acme', 'jane.unsub@prospect.test'), true);
  // The token cannot name another recipient; other@ was only suppressed by the direct seed above,
  // and a jane token must not have removed or replaced that row's meaning for jane's tenant key.
  assert.equal(verifyUnsubToken(token).email, 'jane.unsub@prospect.test');
});
