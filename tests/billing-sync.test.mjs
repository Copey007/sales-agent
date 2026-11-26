// Stripe billing sync: webhook, checkout metadata, operator reconcile.
// Stripe and Supabase are fully mocked — zero live or paid calls.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resetFetch, route, mockAuth, req, calls, SB } from './helpers/env.mjs';
import {
  stripeId, periodEndIso, resolvePlan, mrrCents, priceFields,
  handleStripeEvent, tenantIdFor, KNOWN_PLANS,
} from '../netlify/functions/_billing-sync.mjs';
import { verify } from '../netlify/functions/billing-webhook.mjs';
const billing = (await import('../netlify/functions/billing-webhook.mjs')).default;
const checkout = (await import('../netlify/functions/billing-checkout.mjs')).default;
const reconcile = (await import('../netlify/functions/billing-reconcile.mjs')).default;

const STRIPE_WHSEC = 'whsec_test_stripe_secret';
const STRIPE_SK = 'sk_test_dummy_not_a_real_key';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CUST = 'cus_test_acme';
const SUB = 'sub_test_acme';
const PRICE = 'price_live_agent_test';
const confirmed = '2026-01-01T00:00:00Z';
const USERS = {
  op: { id: 'u-op', email: 'ops@example.com', email_confirmed_at: confirmed },
  member: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed },
  orphan: { id: 'u-orphan', email: 'nobody@bv.test', email_confirmed_at: confirmed },
};
const MEMBERS = {
  'u-mem': [{ role: 'owner', tenant_id: TENANT, tenants: { id: TENANT, slug: 'acme', name: 'Acme', plan: 'trial', status: 'active', stripe_customer_id: CUST } }],
};
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

function stripeSig(body, t = Math.floor(Date.now() / 1000), secret = STRIPE_WHSEC) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function writes() {
  return calls.filter((c) => /\/rest\/v1\/(subscriptions|tenants)/.test(c.url) && ['POST', 'PATCH'].includes(c.method));
}

function parsed(call) {
  if (!call?.body) return null;
  try { return JSON.parse(call.body); } catch { return call.body; }
}

function setup({ stripeSubs = null, tenants = [{ id: TENANT }], restError = null } = {}) {
  resetFetch();
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WHSEC;
  process.env.STRIPE_SECRET_KEY = STRIPE_SK;
  process.env.STRIPE_PRICE_LIVE_AGENT = PRICE;
  process.env.STRIPE_PRICE_STARTER = 'price_starter_test';
  process.env.OPERATOR_EMAILS = 'ops@example.com';
  mockAuth(USERS, MEMBERS);

  route(`${SB}/rest/v1/tenants`, (url, init) => {
    if (restError && (init.method === 'POST' || init.method === 'PATCH') && url.includes('tenants')) {
      return { status: restError, body: { message: 'tenant write failed' } };
    }
    if ((init.method || 'GET') === 'GET' && url.includes('stripe_customer_id=')) {
      return { body: tenants };
    }
    return { status: 200, body: [] };
  });
  route(`${SB}/rest/v1/subscriptions`, (url, init) => {
    if (restError && (init.method === 'POST' || init.method === 'PATCH')) {
      // Optional price/MRR PATCH should not fail the test's core upsert unless
      // we are simulating a core-column failure (no stripe_price_id in body).
      const body = typeof init.body === 'string' ? init.body : '';
      const isOptional = body.includes('mrr_cents') || body.includes('stripe_price_id');
      if (!isOptional) return { status: restError, body: { message: 'subscription write failed' } };
    }
    return { status: 200, body: [] };
  });
  route('https://api.stripe.com/v1/subscriptions', (url, init) => {
    assert.equal((init.headers?.Authorization || init.headers?.get?.('Authorization') || ''), `Bearer ${STRIPE_SK}`);
    if (stripeSubs && typeof stripeSubs === 'function') return stripeSubs(url, init);
    if (Array.isArray(stripeSubs)) {
      if (url.includes('/v1/subscriptions?customer=')) return { body: { object: 'list', data: stripeSubs } };
      return { body: stripeSubs[0] || { error: { message: 'not found' } }, status: stripeSubs[0] ? 200 : 404 };
    }
    return { status: 404, body: { error: { message: 'not mocked' } } };
  });
  route('https://api.stripe.com/v1/customers', () => ({ body: { id: 'cus_new_test' } }));
  route('https://api.stripe.com/v1/checkout/sessions', () => ({ body: { id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' } }));
}

function subFixture(overrides = {}) {
  return {
    id: SUB,
    object: 'subscription',
    status: 'active',
    customer: CUST,
    current_period_end: 1767225600, // 2026-01-01T00:00:00Z
    metadata: { tenant_id: TENANT, plan: 'live-agent' },
    items: {
      data: [{
        quantity: 1,
        current_period_end: 1767225600,
        price: {
          id: PRICE,
          currency: 'usd',
          unit_amount: 12000,
          recurring: { interval: 'month', interval_count: 1 },
        },
      }],
    },
    ...overrides,
  };
}

async function postEvent(type, object, { status } = {}) {
  const body = JSON.stringify({ type, data: { object } });
  const r = await billing(req('https://aisdr.example.test/api/billing-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': stripeSig(body) },
    body,
  }));
  if (status) assert.equal(r.status, status, await r.clone().text());
  return r;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

test('stripeId accepts a string or an expanded { id } object', () => {
  assert.equal(stripeId('cus_abc'), 'cus_abc');
  assert.equal(stripeId({ id: 'cus_abc' }), 'cus_abc');
  assert.equal(stripeId(null), null);
  assert.equal(stripeId({}), null);
});

test('periodEndIso reads Subscription or 2025 item-level period end', () => {
  assert.equal(periodEndIso({ current_period_end: 1767225600 }), '2026-01-01T00:00:00.000Z');
  assert.equal(periodEndIso({ items: { data: [{ current_period_end: 1767225600 }] } }), '2026-01-01T00:00:00.000Z');
  assert.equal(periodEndIso({}), null);
  assert.equal(periodEndIso({ current_period_end: 0 }), null);
});

test('resolvePlan prefers metadata, then env-mapped price ids, never invents', () => {
  const envMap = (k) => ({ STRIPE_PRICE_LIVE_AGENT: PRICE, STRIPE_PRICE_STARTER: 'price_starter_test' }[k] || '');
  assert.equal(resolvePlan({ metadataPlan: 'starter', priceId: PRICE }, envMap), 'starter');
  assert.equal(resolvePlan({ metadataPlan: '', priceId: PRICE }, envMap), 'live-agent');
  assert.equal(resolvePlan({ metadataPlan: 'workspace', priceId: 'price_other' }, envMap), null);
  assert.equal(resolvePlan({ metadataPlan: 'unknown' }, envMap), null);
  assert.ok(KNOWN_PLANS.has('live-agent') && KNOWN_PLANS.has('starter'));
});

test('mrrCents converts monthly, yearly, and quarterly prices', () => {
  assert.equal(mrrCents({ unit_amount: 12000, recurring: { interval: 'month', interval_count: 1 } }), 12000);
  assert.equal(mrrCents({ unit_amount: 120000, recurring: { interval: 'year', interval_count: 1 } }), 10000);
  assert.equal(mrrCents({ unit_amount: 30000, recurring: { interval: 'month', interval_count: 3 } }), 10000);
  assert.equal(mrrCents({ unit_amount: 12000, recurring: { interval: 'month', interval_count: 1 } }, 2), 24000);
  assert.equal(mrrCents({ unit_amount: 100 }, {}), null);
});

test('priceFields extracts amount, interval, and MRR from a subscription item', () => {
  const f = priceFields(subFixture());
  assert.equal(f.stripe_price_id, PRICE);
  assert.equal(f.currency, 'usd');
  assert.equal(f.unit_amount, 12000);
  assert.equal(f.interval, 'month');
  assert.equal(f.mrr_cents, 12000);
});

// ── Tenant resolution ─────────────────────────────────────────────────────

test('tenantIdFor uses metadata.tenant_id when present', async () => {
  setup();
  assert.equal(await tenantIdFor({ metadata: { tenant_id: TENANT } }), TENANT);
  assert.equal(calls.filter((c) => c.url.includes('/tenants')).length, 0);
});

test('tenantIdFor falls back to tenants.stripe_customer_id and unwraps expanded customer', async () => {
  setup();
  assert.equal(await tenantIdFor({ customer: { id: CUST }, metadata: {} }), TENANT);
  const lookup = calls.find((c) => c.url.includes('stripe_customer_id='));
  assert.ok(lookup.url.includes(`stripe_customer_id=eq.${encodeURIComponent(CUST)}`));
  assert.equal(lookup.url.includes('[object Object]'), false);
});

test('tenantIdFor returns null when nothing maps, and does not throw', async () => {
  setup({ tenants: [] });
  assert.equal(await tenantIdFor({ customer: 'cus_unknown', metadata: {} }), null);
});

// ── Webhook event handling ────────────────────────────────────────────────

test('checkout.session.completed upserts the subscription and sets tenants.plan + status', async () => {
  const sub = subFixture();
  setup({ stripeSubs: [sub] });
  const r = await postEvent('checkout.session.completed', {
    id: 'cs_1',
    customer: CUST,
    subscription: SUB,
    metadata: { tenant_id: TENANT, plan: 'live-agent' },
  }, { status: 200 });
  const body = await r.json();
  assert.equal(body.received, true);
  assert.equal(body.tenantId, TENANT);
  const subWrite = writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions'));
  assert.ok(subWrite, 'expected a subscriptions upsert');
  const row = parsed(subWrite);
  assert.equal(row.tenant_id, TENANT);
  assert.equal(row.stripe_subscription_id, SUB);
  assert.equal(row.plan, 'live-agent');
  assert.equal(row.status, 'active');
  assert.equal(row.current_period_end, '2026-01-01T00:00:00.000Z');
  const tenantPatch = writes().find((c) => c.method === 'PATCH' && c.url.includes('tenants'));
  assert.deepEqual(parsed(tenantPatch), { status: 'active', plan: 'live-agent' });
  assert.ok(calls.some((c) => c.url.startsWith('https://api.stripe.com/v1/subscriptions/') && (c.method === 'GET')));
});

test('checkout.session.completed still works when the session carries metadata and the customer is expanded', async () => {
  const sub = subFixture({ metadata: {} }); // subscription itself has no tenant_id
  setup({ stripeSubs: [sub] });
  const r = await postEvent('checkout.session.completed', {
    customer: { id: CUST },
    subscription: SUB,
    metadata: { tenant_id: TENANT, plan: 'starter' },
  }, { status: 200 });
  assert.equal((await r.json()).tenantId, TENANT);
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.plan, 'starter'); // stamped from session metadata
});

test('customer.subscription.created maps a price id to the product plan and writes MRR fields', async () => {
  setup();
  const obj = subFixture({ metadata: { tenant_id: TENANT } }); // no plan in metadata; price maps to live-agent
  delete obj.metadata.plan;
  await postEvent('customer.subscription.created', obj, { status: 200 });
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.plan, 'live-agent');
  const mrrPatch = writes().find((c) => c.method === 'PATCH' && c.url.includes('subscriptions'));
  assert.equal(parsed(mrrPatch).mrr_cents, 12000);
  assert.equal(parsed(mrrPatch).stripe_price_id, PRICE);
});

test('customer.subscription.updated with status past_due sets tenants.status to past_due', async () => {
  setup();
  await postEvent('customer.subscription.updated', subFixture({ status: 'past_due' }), { status: 200 });
  const tenantPatch = writes().find((c) => c.method === 'PATCH' && c.url.includes('tenants'));
  assert.equal(parsed(tenantPatch).status, 'past_due');
});

test('customer.subscription.deleted marks the row canceled and the tenant cancelled', async () => {
  setup();
  await postEvent('customer.subscription.deleted', subFixture({ status: 'canceled' }), { status: 200 });
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.status, 'canceled');
  assert.equal(parsed(writes().find((c) => c.method === 'PATCH' && c.url.includes('tenants'))).status, 'cancelled');
});

test('invoice.paid retrieves the subscription and sets the tenant active', async () => {
  const sub = subFixture({ status: 'active' });
  setup({ stripeSubs: [sub] });
  await postEvent('invoice.paid', {
    id: 'in_paid',
    customer: CUST,
    subscription: SUB,
    metadata: {},
    subscription_details: { metadata: { tenant_id: TENANT, plan: 'live-agent' } },
  }, { status: 200 });
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.stripe_subscription_id, SUB);
  assert.equal(row.status, 'active');
});

test('invoice.payment_failed retrieves the full subscription, sets past_due, and keeps plan and period end', async () => {
  const sub = subFixture({ status: 'active' });
  setup({ stripeSubs: [sub] });
  await postEvent('invoice.payment_failed', {
    id: 'in_fail',
    customer: CUST,
    subscription: SUB,
    metadata: { tenant_id: TENANT },
  }, { status: 200 });
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.status, 'past_due');
  assert.equal(row.plan, 'live-agent');
  assert.equal(row.current_period_end, '2026-01-01T00:00:00.000Z');
  assert.equal(row.plan === 'unknown', false);
  assert.ok(row.current_period_end);
  assert.equal(parsed(writes().find((c) => c.method === 'PATCH' && c.url.includes('tenants'))).status, 'past_due');
});

test('invoice.payment_failed falls back to a status-only PATCH and does not clobber plan or period end', async () => {
  const existing = {
    tenant_id: TENANT,
    stripe_subscription_id: SUB,
    plan: 'live-agent',
    status: 'active',
    current_period_end: '2026-01-01T00:00:00.000Z',
  };
  let stored = { ...existing };
  setup({ stripeSubs: () => ({ status: 502, body: { error: { message: 'stripe down' } } }) });
  await postEvent('invoice.payment_failed', {
    id: 'in_fail',
    customer: CUST,
    subscription: SUB,
    metadata: { tenant_id: TENANT },
  }, { status: 200 });
  const subWrites = writes().filter((c) => c.url.includes('subscriptions'));
  assert.ok(subWrites.length, 'expected a subscription write');
  assert.ok(subWrites.every((c) => c.method === 'PATCH'), 'must not upsert a sparse row (POST merge would clobber)');
  for (const c of subWrites) {
    const body = parsed(c);
    assert.equal('plan' in body, false, 'status-only PATCH must not include plan');
    assert.equal('current_period_end' in body, false, 'status-only PATCH must not include current_period_end');
    stored = { ...stored, ...body };
  }
  assert.equal(stored.plan, 'live-agent');
  assert.equal(stored.current_period_end, '2026-01-01T00:00:00.000Z');
  assert.equal(stored.status, 'past_due');
  assert.equal(parsed(writes().find((c) => c.method === 'PATCH' && c.url.includes('tenants'))).status, 'past_due');
});

test('invoice.paid returns 500 when subscription retrieve fails and does not write a sparse row', async () => {
  setup({ stripeSubs: () => ({ status: 502, body: { error: { message: 'stripe down' } } }) });
  const r = await postEvent('invoice.paid', {
    id: 'in_paid',
    customer: CUST,
    subscription: SUB,
    metadata: {},
    subscription_details: { metadata: { tenant_id: TENANT, plan: 'live-agent' } },
  }, { status: 500 });
  const body = await r.json();
  assert.equal(body.received, false);
  assert.equal(body.error, 'sync_failed');
  const subWrites = writes().filter((c) => c.url.includes('/rest/v1/subscriptions'));
  assert.equal(subWrites.length, 0, 'must not upsert a sparse subscription row');
  assert.equal(writes().filter((c) => c.url.includes('/rest/v1/tenants') && c.method === 'PATCH').length, 0);
});

test('subscription events resolve the tenant by stripe_customer_id when metadata is missing', async () => {
  setup();
  await postEvent('customer.subscription.created', subFixture({ metadata: {} }), { status: 200 });
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.tenant_id, TENANT);
});

test('unmapped tenant is ignored with 200 (no retry storm) and writes nothing', async () => {
  setup({ tenants: [] });
  const r = await postEvent('customer.subscription.created', subFixture({ metadata: {}, customer: 'cus_other' }), { status: 200 });
  const body = await r.json();
  assert.equal(body.ignored, 'no_tenant');
  assert.equal(writes().length, 0);
});

test('DB failure on the subscriptions upsert returns 500 so Stripe retries', async () => {
  setup({ restError: 400 });
  const r = await postEvent('customer.subscription.created', subFixture(), { status: 500 });
  const body = await r.json();
  assert.equal(body.received, false);
  assert.equal(body.error, 'sync_failed');
  assert.equal(JSON.stringify(body).includes('subscription write failed'), false, 'must not leak the DB error');
});

test('checkout retrieve failure writes a stub row then returns 500 for retry', async () => {
  setup({ stripeSubs: () => ({ status: 502, body: { error: { message: 'stripe down' } } }) });
  const r = await postEvent('checkout.session.completed', {
    customer: CUST,
    subscription: SUB,
    metadata: { tenant_id: TENANT, plan: 'live-agent' },
  }, { status: 500 });
  assert.equal((await r.json()).error, 'sync_failed');
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.stripe_subscription_id, SUB);
  assert.equal(row.plan, 'live-agent');
});

test('unknown event types return received:true and write nothing', async () => {
  setup();
  const r = await postEvent('ping', {}, { status: 200 });
  assert.equal((await r.json()).ignored, 'unhandled_event');
  assert.equal(writes().length, 0);
});

test('handleStripeEvent covers the 2025 period-end-on-item shape', async () => {
  setup();
  const obj = subFixture();
  delete obj.current_period_end;
  obj.items.data[0].current_period_end = 1767225600;
  const result = await handleStripeEvent({ type: 'customer.subscription.updated', data: { object: obj } });
  assert.equal(result.tenantId, TENANT);
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.current_period_end, '2026-01-01T00:00:00.000Z');
});

// ── Checkout ──────────────────────────────────────────────────────────────

test('billing-checkout stamps subscription_data metadata and reuses the stored customer', async () => {
  setup();
  const r = await checkout(req('https://aisdr.example.test/api/billing-checkout', {
    method: 'POST',
    headers: { ...bearer('member'), Origin: 'https://missioncontrol.a-gent.co' },
    body: { plan: 'live-agent', trial_days: 15 },
  }));
  assert.equal(r.status, 200, await r.clone().text());
  const sessionCall = calls.find((c) => c.url.includes('/v1/checkout/sessions'));
  assert.ok(sessionCall, 'expected a Checkout Session create');
  const form = String(sessionCall.body);
  assert.ok(form.includes(`subscription_data%5Bmetadata%5D%5Btenant_id%5D=${encodeURIComponent(TENANT)}`) || form.includes(`subscription_data[metadata][tenant_id]=${TENANT}`));
  assert.ok(form.includes('subscription_data') && form.includes('tenant_id') && form.includes(TENANT));
  assert.ok(form.includes('live-agent'));
  // Reused the existing customer — no customers POST.
  assert.equal(calls.some((c) => c.url === 'https://api.stripe.com/v1/customers' || c.url.endsWith('/v1/customers')), false);
});

test('billing-checkout creates a customer and fails if storing stripe_customer_id fails', async () => {
  setup({ restError: 500 });
  // Member fixture has a customer already; override memberships to omit it.
  resetFetch();
  process.env.STRIPE_SECRET_KEY = STRIPE_SK;
  process.env.STRIPE_PRICE_LIVE_AGENT = PRICE;
  mockAuth(USERS, {
    'u-mem': [{ role: 'owner', tenant_id: TENANT, tenants: { id: TENANT, slug: 'acme', name: 'Acme', plan: 'trial', status: 'active' } }],
  });
  route(`${SB}/rest/v1/tenants`, () => ({ status: 500, body: { message: 'patch failed' } }));
  route('https://api.stripe.com/v1/customers', () => ({ body: { id: 'cus_new_test' } }));
  route('https://api.stripe.com/v1/checkout/sessions', () => ({ body: { id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' } }));
  const r = await checkout(req('https://aisdr.example.test/api/billing-checkout', {
    method: 'POST',
    headers: { ...bearer('member'), Origin: 'https://aisdr.a-gent.co' },
    body: { plan: 'live-agent' },
  }));
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(/cus_new_test|sk_test/.test(JSON.stringify(body)), false);
  assert.ok(body.error);
  assert.equal(calls.some((c) => c.url.includes('/v1/checkout/sessions')), false, 'must not open a session after a failed customer save');
});

// ── Operator reconcile ────────────────────────────────────────────────────

test('billing-reconcile is operator-only and fails closed without OPERATOR_EMAILS', async () => {
  setup();
  const saved = process.env.OPERATOR_EMAILS;
  process.env.OPERATOR_EMAILS = '';
  try {
    const r = await reconcile(req('https://aisdr.example.test/api/billing-reconcile', {
      method: 'POST',
      headers: bearer('op'),
      body: {},
    }));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'operators_not_configured');
  } finally { process.env.OPERATOR_EMAILS = saved; }
});

test('billing-reconcile backfills subscriptions for Stripe-linked tenants (mocked Stripe)', async () => {
  const sub = subFixture();
  setup({ stripeSubs: [sub], tenants: [{ id: TENANT, stripe_customer_id: CUST, plan: 'trial', status: 'active' }] });
  const r = await reconcile(req('https://aisdr.example.test/api/billing-reconcile', {
    method: 'POST',
    headers: { ...bearer('op'), Origin: 'https://missioncontrol.a-gent.co' },
    body: {},
  }));
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.tenants, 1);
  assert.equal(body.subscriptions, 1);
  const row = parsed(writes().find((c) => c.method === 'POST' && c.url.includes('subscriptions')));
  assert.equal(row.tenant_id, TENANT);
  assert.equal(row.plan, 'live-agent');
  assert.ok(calls.some((c) => c.url.includes('https://api.stripe.com/v1/subscriptions?customer=')));
});

test('billing-reconcile returns 503 when Stripe is not configured, and never calls Stripe', async () => {
  setup();
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    resetFetch();
    mockAuth(USERS, MEMBERS);
    const r = await reconcile(req('https://aisdr.example.test/api/billing-reconcile', {
      method: 'POST',
      headers: bearer('op'),
      body: {},
    }));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'stripe_not_configured');
    assert.equal(calls.some((c) => String(c.url).includes('api.stripe.com')), false);
  } finally { process.env.STRIPE_SECRET_KEY = saved; }
});

test('no test in this file talks to live Stripe or live Supabase hosts', () => {
  for (const c of calls) {
    assert.equal(String(c.url).includes('api.stripe.com') && !c.url.startsWith('https://api.stripe.com/v1/'), false);
    assert.equal(/supabase\.co/.test(c.url) && !c.url.startsWith(SB), false);
  }
  // Sanity: the verify helper still works after the webhook rewrite.
  const b = '{"type":"x"}';
  assert.equal(verify(b, stripeSig(b), STRIPE_WHSEC), true);
});

test('unapplied price/MRR migration exists and is not referenced as auto-applied', () => {
  const sql = readFileSync(new URL('../migrations/20261126_subscriptions_price_mrr.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS mrr_cents INTEGER/);
  assert.match(sql, /DO NOT apply this to live Supabase/);
});
