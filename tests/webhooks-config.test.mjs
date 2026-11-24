// Stripe + Svix webhook verification, and netlify.toml exposure rules.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resetFetch, req, calls } from './helpers/env.mjs';

const { verify } = await import('../netlify/functions/billing-webhook.mjs');
const billing = (await import('../netlify/functions/billing-webhook.mjs')).default;
const inbound = (await import('../netlify/functions/inbound-webhook.mjs')).default;

const STRIPE = 'whsec_test_stripe_secret';
const stripeSig = (body, t, secret = STRIPE) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

test('Stripe: valid signature accepted', () => {
  const b = '{"type":"x"}'; assert.equal(verify(b, stripeSig(b, now()), STRIPE), true);
});
test('Stripe: tampered body / wrong secret / missing secret rejected', () => {
  const b = '{"type":"x"}'; const s = stripeSig(b, now());
  assert.equal(verify(b + ' ', s, STRIPE), false);
  assert.equal(verify(b, stripeSig(b, now(), 'other'), STRIPE), false);
  assert.equal(verify(b, s, ''), false);
  assert.equal(verify(b, '', STRIPE), false);
});
test('Stripe: stale timestamp (replay) rejected; rotated multi-v1 header accepted', () => {
  const b = '{}';
  assert.equal(verify(b, stripeSig(b, now() - 3600), STRIPE), false);
  const t = now();
  const good = createHmac('sha256', STRIPE).update(`${t}.${b}`).digest('hex');
  assert.equal(verify(b, `t=${t},v1=${'0'.repeat(64)},v1=${good}`, STRIPE), true);
});
test('Stripe handler returns 400 on a bad signature and touches nothing', async () => {
  resetFetch(); process.env.STRIPE_WEBHOOK_SECRET = STRIPE;
  const r = await billing(req('https://aisdr.example.test/api/billing-webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: '{"type":"checkout.session.completed"}' }));
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

const SVIX_KEY = Buffer.from('test-svix-secret-bytes-0123456789');
const SVIX = 'whsec_' + SVIX_KEY.toString('base64');
function svixHeaders(body, ts = now(), id = 'msg_1') {
  const sig = createHmac('sha256', SVIX_KEY).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'Content-Type': 'application/json' };
}
test('Resend inbound (Svix): unsigned / bad / stale requests → 401, no side effects', async () => {
  process.env.RESEND_WEBHOOK_SECRET = SVIX;
  const body = JSON.stringify({ type: 'email.received', data: { from: 'Eve <eve@x.test>', subject: 'hi', text: 'forged' } });
  for (const headers of [{}, { ...svixHeaders(body), 'svix-signature': 'v1,AAAA' }, svixHeaders(body, now() - 3600)]) {
    resetFetch();
    const r = await inbound(req('https://aisdr.example.test/api/inbound-webhook', { method: 'POST', headers, body }), {});
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  }
});
test('Resend inbound (Svix): missing secret fails closed', async () => {
  const saved = process.env.RESEND_WEBHOOK_SECRET; delete process.env.RESEND_WEBHOOK_SECRET;
  try {
    const body = '{}';
    const r = await inbound(req('https://aisdr.example.test/api/inbound-webhook', { method: 'POST', headers: svixHeaders(body), body }), {});
    assert.equal(r.status, 401);
  } finally { process.env.RESEND_WEBHOOK_SECRET = saved; }
});
test('Resend inbound (Svix): correctly signed request passes verification', async () => {
  process.env.RESEND_WEBHOOK_SECRET = SVIX;
  const { verifyResendSignature } = await import('../netlify/functions/inbound-webhook.mjs');
  const body = '{"type":"email.received"}';
  const r = new Request('https://x.test', { method: 'POST', headers: svixHeaders(body), body });
  assert.deepEqual(verifyResendSignature(r, body), { ok: true });
});

// ── netlify.toml ──
const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
const blocks = [...toml.matchAll(/\[\[redirects\]\]\s*\n\s*from = "([^"]+)"\s*\n\s*to = "([^"]+)"\s*\n\s*status = (\d+)\s*\n\s*force = (true|false)/g)]
  .filter((m) => m[3] === '404').map((m) => ({ from: m[1], force: m[4] === 'true' }));
const MUST_BLOCK = ['/netlify/*', '/memory/*', '/core/*', '/capabilities/*', '/integrations/*', '/agents/*', '/node_modules/*', '/supabase/*', '/tests/*', '/scripts/*', '/.git/*', '/.netlify/*', '/package.json', '/package-lock.json', '/deno.lock', '/netlify.toml', '/.gitignore', '/README.md', '/ARCHITECTURE.md', '/cli.js', '/integrate.js', '/cron_signal_scan.js', '/dashboard/login.html', '/dashboard/netlify.toml'];
for (const p of MUST_BLOCK) {
  test(`netlify.toml force-404s ${p}`, () => {
    const b = blocks.find((x) => x.from === p);
    assert.ok(b, `missing rule for ${p}`); assert.equal(b.force, true);
  });
}
test('netlify.toml no longer sets a blanket Access-Control-Allow-Origin "*"', () => {
  assert.equal(/Access-Control-Allow-Origin\s*=\s*"\*"/.test(toml), false);
});
test('netlify.toml keeps the public product routes', () => {
  assert.match(toml, /from = "\/a\/:slug"/); assert.match(toml, /from = "\/signup"/);
});
test('.gitignore covers secrets and local CLI state', () => {
  const gi = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const p of ['.env', 'node_modules/', '.netlify/', 'supabase/.temp/', '*.pem', 'memory/*.json']) assert.ok(gi.includes(p), p);
});
