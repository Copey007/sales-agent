// Starter / Growth / Custom Build plan definitions, Stripe env mapping,
// checkout fail-closed behavior, and pricing-page consistency.
import './helpers/env.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetFetch, route, mockAuth, req, SB, calls } from './helpers/env.mjs';
import {
  PLANS,
  PLAN_ALIASES,
  TRIAL_DAYS,
  BLENDED_TARGET_CENTS,
  BLENDED_STARTER_SHARE,
  canonicalPlanKey,
  getPlan,
  formatMonthlyUsd,
  publicPriceLabel,
  blendedMonthlyCents,
  normalizeSignupPlan,
  resolveStripePrice,
} from '../netlify/functions/_plans.mjs';

const checkout = await import('../netlify/functions/billing-checkout.mjs');
const signup = await import('../netlify/functions/signup.mjs');

const confirmed = '2026-01-01T00:00:00Z';
const USERS = { mem: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed } };
const MEMBERS = {
  'u-mem': [{
    role: 'owner',
    tenant_id: 't-acme',
    tenants: { id: 't-acme', slug: 'acme', name: 'Acme', stripe_customer_id: 'cus_test_acme' },
  }],
};
const bearer = { Authorization: 'Bearer mem' };
const CHECKOUT = 'https://aisdr.example.test/api/billing-checkout';
const SIGNUP = 'https://aisdr.example.test/api/signup';

const ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_ID',
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_GROWTH',
  'STRIPE_PRICE_LIVE_AGENT',
];
const savedEnv = {};
function snapEnv() { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; }
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}
function clearPriceEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
const dummyEnv = (map) => (key) => map[key] || '';

function setupAuth() {
  resetFetch();
  mockAuth(USERS, MEMBERS);
}

beforeEach(() => { snapEnv(); });
afterEach(() => { restoreEnv(); });

// ── Plan definitions ──────────────────────────────────────────────────────

test('canonical plans are starter, growth, and enterprise (Custom Build)', () => {
  assert.deepEqual(Object.keys(PLANS).sort(), ['enterprise', 'growth', 'starter']);
  assert.equal(PLANS.starter.monthlyCents, 49900);
  assert.equal(PLANS.growth.monthlyCents, 99900);
  assert.equal(PLANS.enterprise.monthlyCents, null);
  assert.equal(PLANS.enterprise.custom, true);
  assert.equal(PLANS.enterprise.publicName, 'Custom Build');
  assert.equal(PLANS.enterprise.priceLabel, 'Talk to us');
  assert.equal(PLANS.starter.checkout, true);
  assert.equal(PLANS.growth.checkout, true);
  assert.equal(PLANS.enterprise.checkout, false);
  assert.equal(PLANS.growth.featured, true);
  assert.equal(PLANS.starter.featured, false);
  assert.equal(TRIAL_DAYS, 15);
});

test('60/40 Starter/Growth mix blends to $699, within ~$700 target', () => {
  assert.equal(BLENDED_STARTER_SHARE, 0.6);
  assert.equal(blendedMonthlyCents(), 69900);
  assert.equal(blendedMonthlyCents(0.6), 69900);
  const delta = Math.abs(blendedMonthlyCents() - BLENDED_TARGET_CENTS);
  assert.ok(delta <= 1000, `blend ${blendedMonthlyCents()} should be within $10 of ${BLENDED_TARGET_CENTS}`);
});

test('formatters and aliases', () => {
  assert.equal(formatMonthlyUsd(49900), '$499');
  assert.equal(formatMonthlyUsd(99900), '$999');
  assert.equal(publicPriceLabel(PLANS.starter), '$499/month');
  assert.equal(publicPriceLabel(PLANS.growth), '$999/month');
  assert.equal(publicPriceLabel(PLANS.enterprise), 'Talk to us');
  assert.equal(canonicalPlanKey('live-agent'), 'starter');
  assert.equal(canonicalPlanKey('STARTER'), 'starter');
  assert.equal(canonicalPlanKey('growth'), 'growth');
  assert.equal(PLAN_ALIASES['live-agent'], 'starter');
  assert.equal(getPlan('live-agent').key, 'starter');
  assert.equal(getPlan('nope'), null);
  assert.equal(getPlan(''), null);
});

test('normalizeSignupPlan maps aliases and rejects unknown keys', () => {
  assert.deepEqual(normalizeSignupPlan(''), { ok: true, key: 'trial' });
  assert.equal(normalizeSignupPlan('starter').key, 'starter');
  assert.equal(normalizeSignupPlan('growth').key, 'growth');
  assert.equal(normalizeSignupPlan('enterprise').key, 'enterprise');
  assert.equal(normalizeSignupPlan('live-agent').key, 'starter');
  assert.equal(normalizeSignupPlan('LIVE-AGENT').key, 'starter');
  const bad = normalizeSignupPlan('butler');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unknown plan/i);
});

// ── Stripe env mapping (no network) ───────────────────────────────────────

test('starter requires STRIPE_PRICE_STARTER and does not fall back to STRIPE_PRICE_ID', () => {
  const miss = resolveStripePrice('starter', dummyEnv({ STRIPE_PRICE_ID: 'price_test_default' }));
  assert.equal(miss.ok, false);
  assert.equal(miss.configured, false);
  assert.equal(miss.envVar, 'STRIPE_PRICE_STARTER');
  assert.match(miss.reason, /STRIPE_PRICE_STARTER/);

  const hit = resolveStripePrice('starter', dummyEnv({
    STRIPE_PRICE_STARTER: 'price_test_starter',
    STRIPE_PRICE_ID: 'price_test_default',
  }));
  assert.equal(hit.ok, true);
  assert.equal(hit.priceId, 'price_test_starter');
  assert.equal(hit.envVar, 'STRIPE_PRICE_STARTER');
  assert.equal(hit.canonicalKey, 'starter');
});

test('growth requires STRIPE_PRICE_GROWTH and does not fall back to starter or default', () => {
  const miss = resolveStripePrice('growth', dummyEnv({
    STRIPE_PRICE_STARTER: 'price_test_starter',
    STRIPE_PRICE_ID: 'price_test_default',
  }));
  assert.equal(miss.ok, false);
  assert.equal(miss.envVar, 'STRIPE_PRICE_GROWTH');
  assert.match(miss.reason, /STRIPE_PRICE_GROWTH/);

  const hit = resolveStripePrice('growth', dummyEnv({ STRIPE_PRICE_GROWTH: 'price_test_growth' }));
  assert.equal(hit.ok, true);
  assert.equal(hit.priceId, 'price_test_growth');
  assert.equal(hit.canonicalKey, 'growth');
});

test('live-agent falls back through LIVE_AGENT, then STARTER, then STRIPE_PRICE_ID', () => {
  const a = resolveStripePrice('live-agent', dummyEnv({
    STRIPE_PRICE_LIVE_AGENT: 'price_test_live',
    STRIPE_PRICE_STARTER: 'price_test_starter',
    STRIPE_PRICE_ID: 'price_test_default',
  }));
  assert.equal(a.priceId, 'price_test_live');
  assert.equal(a.envVar, 'STRIPE_PRICE_LIVE_AGENT');
  assert.equal(a.canonicalKey, 'starter');

  const b = resolveStripePrice('live-agent', dummyEnv({
    STRIPE_PRICE_STARTER: 'price_test_starter',
    STRIPE_PRICE_ID: 'price_test_default',
  }));
  assert.equal(b.priceId, 'price_test_starter');
  assert.equal(b.envVar, 'STRIPE_PRICE_STARTER');

  const c = resolveStripePrice('live-agent', dummyEnv({ STRIPE_PRICE_ID: 'price_test_default' }));
  assert.equal(c.priceId, 'price_test_default');
  assert.equal(c.envVar, 'STRIPE_PRICE_ID');

  const miss = resolveStripePrice('live-agent', dummyEnv({}));
  assert.equal(miss.ok, false);
  assert.equal(miss.envVar, 'STRIPE_PRICE_LIVE_AGENT');
});

test('default (no plan) uses STRIPE_PRICE_ID only', () => {
  const miss = resolveStripePrice('', dummyEnv({ STRIPE_PRICE_STARTER: 'price_test_starter' }));
  assert.equal(miss.ok, false);
  assert.equal(miss.envVar, 'STRIPE_PRICE_ID');
  const hit = resolveStripePrice('', dummyEnv({ STRIPE_PRICE_ID: 'price_test_default' }));
  assert.equal(hit.ok, true);
  assert.equal(hit.priceId, 'price_test_default');
  assert.equal(hit.canonicalKey, '');
});

test('enterprise and unknown plans are not checkoutable', () => {
  const ent = resolveStripePrice('enterprise', dummyEnv({ STRIPE_PRICE_ID: 'price_test_default' }));
  assert.equal(ent.ok, false);
  assert.equal(ent.status, 400);
  const unk = resolveStripePrice('butler', dummyEnv({ STRIPE_PRICE_ID: 'price_test_default' }));
  assert.equal(unk.ok, false);
  assert.equal(unk.status, 400);
});

// ── billing-checkout handler ──────────────────────────────────────────────

async function checkoutBody(res) {
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

function checkoutForm(call) {
  return new URLSearchParams(String(call?.body || ''));
}

function assertSubscriptionMeta(form, { tenantId = 't-acme', plan }) {
  assert.equal(form.get('subscription_data[metadata][tenant_id]'), tenantId);
  assert.equal(form.get('subscription_data[metadata][plan]'), plan);
  assert.equal(form.get('metadata[tenant_id]'), tenantId);
  assert.equal(form.get('metadata[plan]'), plan);
}

test('checkout: missing STRIPE_SECRET_KEY fails closed without calling Stripe', async () => {
  setupAuth();
  clearPriceEnv();
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'starter' } })));
  assert.equal(status, 200);
  assert.equal(body.configured, false);
  assert.match(body.reason, /STRIPE_SECRET_KEY/);
  assert.equal(calls.some((c) => c.url.includes('api.stripe.com')), false);
});

test('checkout: unauthenticated request is 401 and does not call Stripe', async () => {
  setupAuth();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_STARTER = 'price_test_starter';
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', body: { plan: 'starter' } })));
  assert.equal(status, 401);
  assert.equal(calls.some((c) => c.url.includes('api.stripe.com')), false);
  assert.ok(body.error);
});

test('checkout: starter with no STRIPE_PRICE_STARTER fails closed even if STRIPE_PRICE_ID is set', async () => {
  setupAuth();
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_ID = 'price_test_default';
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'starter' } })));
  assert.equal(status, 200);
  assert.equal(body.configured, false);
  assert.equal(body.env_var, 'STRIPE_PRICE_STARTER');
  assert.match(body.reason, /STRIPE_PRICE_STARTER/);
  assert.equal(calls.some((c) => c.url.includes('api.stripe.com')), false);
});

test('checkout: growth with no STRIPE_PRICE_GROWTH fails closed', async () => {
  setupAuth();
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_STARTER = 'price_test_starter';
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'growth' } })));
  assert.equal(status, 200);
  assert.equal(body.configured, false);
  assert.equal(body.env_var, 'STRIPE_PRICE_GROWTH');
  assert.equal(calls.some((c) => c.url.includes('api.stripe.com')), false);
});

test('checkout: enterprise is rejected without calling Stripe', async () => {
  setupAuth();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_ID = 'price_test_default';
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'enterprise' } })));
  assert.equal(status, 400);
  assert.equal(body.configured, false);
  assert.equal(calls.some((c) => c.url.includes('api.stripe.com')), false);
});

test('checkout: starter session uses STRIPE_PRICE_STARTER and never a live Stripe key shape in assertions', async () => {
  setupAuth();
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_STARTER = 'price_test_starter';
  route('https://api.stripe.com/v1/checkout/sessions', () => ({
    body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' },
  }));
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'starter' } })));
  assert.equal(status, 200);
  assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const stripeCalls = calls.filter((c) => c.url.includes('api.stripe.com'));
  assert.equal(stripeCalls.length, 1);
  assert.match(stripeCalls[0].url, /checkout\/sessions/);
  assert.match(String(stripeCalls[0].body), /price_test_starter/);
  assert.equal(String(stripeCalls[0].body).includes('price_test_growth'), false);
  assertSubscriptionMeta(checkoutForm(stripeCalls[0]), { plan: 'starter' });
});

test('checkout: growth session uses STRIPE_PRICE_GROWTH', async () => {
  setupAuth();
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_GROWTH = 'price_test_growth';
  route('https://api.stripe.com/v1/checkout/sessions', () => ({
    body: { id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' },
  }));
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'growth' } })));
  assert.equal(status, 200);
  assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_2');
  const stripeCalls = calls.filter((c) => c.url.includes('api.stripe.com'));
  assert.equal(stripeCalls.length, 1);
  assert.match(String(stripeCalls[0].body), /price_test_growth/);
  assertSubscriptionMeta(checkoutForm(stripeCalls[0]), { plan: 'growth' });
});

test('checkout: Starter stamps subscription_data[metadata][tenant_id] and [plan]', async () => {
  setupAuth();
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_STARTER = 'price_test_starter';
  route('https://api.stripe.com/v1/checkout/sessions', () => ({
    body: { id: 'cs_meta_starter', url: 'https://checkout.stripe.com/c/pay/cs_meta_starter' },
  }));
  const { status } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'starter' } })));
  assert.equal(status, 200);
  const session = calls.find((c) => c.url.includes('/v1/checkout/sessions'));
  assert.ok(session);
  const form = checkoutForm(session);
  assert.equal(form.get('subscription_data[metadata][tenant_id]'), 't-acme');
  assert.equal(form.get('subscription_data[metadata][plan]'), 'starter');
  assert.equal(form.get('metadata[tenant_id]'), 't-acme');
  assert.equal(form.get('metadata[plan]'), 'starter');
  assert.equal(form.get('line_items[0][price]'), 'price_test_starter');
});

test('checkout: Growth stamps subscription_data[metadata][tenant_id] and [plan]', async () => {
  setupAuth();
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_GROWTH = 'price_test_growth';
  route('https://api.stripe.com/v1/checkout/sessions', () => ({
    body: { id: 'cs_meta_growth', url: 'https://checkout.stripe.com/c/pay/cs_meta_growth' },
  }));
  const { status } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'growth' } })));
  assert.equal(status, 200);
  const session = calls.find((c) => c.url.includes('/v1/checkout/sessions'));
  assert.ok(session);
  const form = checkoutForm(session);
  assert.equal(form.get('subscription_data[metadata][tenant_id]'), 't-acme');
  assert.equal(form.get('subscription_data[metadata][plan]'), 'growth');
  assert.equal(form.get('metadata[tenant_id]'), 't-acme');
  assert.equal(form.get('metadata[plan]'), 'growth');
  assert.equal(form.get('line_items[0][price]'), 'price_test_growth');
});

test('checkout: live-agent alias bills the live-agent or starter price and stores canonical starter', async () => {
  setupAuth();
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_LIVE_AGENT = 'price_test_live';
  route('https://api.stripe.com/v1/checkout/sessions', () => ({
    body: { id: 'cs_test_3', url: 'https://checkout.stripe.com/c/pay/cs_test_3' },
  }));
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'live-agent' } })));
  assert.equal(status, 200);
  assert.ok(body.url);
  const stripeCalls = calls.filter((c) => c.url.includes('api.stripe.com'));
  assert.equal(stripeCalls.length, 1);
  assert.match(String(stripeCalls[0].body), /price_test_live/);
  const form = checkoutForm(stripeCalls[0]);
  assertSubscriptionMeta(form, { plan: 'starter' });
  assert.equal(form.get('metadata[plan_requested]'), 'live-agent');
});

test('checkout: no plan uses STRIPE_PRICE_ID (legacy default workspace checkout)', async () => {
  setupAuth();
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_ID = 'price_test_default';
  route('https://api.stripe.com/v1/checkout/sessions', () => ({
    body: { id: 'cs_test_4', url: 'https://checkout.stripe.com/c/pay/cs_test_4' },
  }));
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: {} })));
  assert.equal(status, 200);
  assert.ok(body.url);
  const stripeCalls = calls.filter((c) => c.url.includes('api.stripe.com'));
  assert.match(String(stripeCalls[0].body), /price_test_default/);
  assertSubscriptionMeta(checkoutForm(stripeCalls[0]), { plan: 'workspace' });
});

test('checkout: stripe_customer_id PATCH failure returns 502 and does not open a Checkout Session', async () => {
  resetFetch();
  mockAuth(USERS, {
    'u-mem': [{ role: 'owner', tenant_id: 't-acme', tenants: { id: 't-acme', slug: 'acme', name: 'Acme', plan: 'trial', status: 'active' } }],
  });
  clearPriceEnv();
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_PRICE_STARTER = 'price_test_starter';
  route(`${SB}/rest/v1/tenants`, () => ({ status: 500, body: { message: 'patch failed' } }));
  route('https://api.stripe.com/v1/customers', () => ({ body: { id: 'cus_new_test' } }));
  route('https://api.stripe.com/v1/checkout/sessions', () => ({ body: { id: 'cs_should_not_create', url: 'https://checkout.stripe.com/c/pay/nope' } }));
  const { status, body } = await checkoutBody(await checkout.default(req(CHECKOUT, { method: 'POST', headers: bearer, body: { plan: 'starter' } })));
  assert.equal(status, 502);
  assert.ok(body.error);
  assert.match(String(body.error), /stripe_customer_id/);
  assert.equal(/cus_new_test|sk_test_dummy|price_test_starter/.test(JSON.stringify(body)), false, 'must not leak ids or dummy keys');
  assert.equal(calls.some((c) => c.url.includes('/v1/checkout/sessions')), false, 'must not open a session after a failed customer save');
  assert.ok(calls.some((c) => c.url.includes('/v1/customers')));
});

test('checkout OPTIONS is 204 and POST-only otherwise', async () => {
  setupAuth();
  const opt = await checkout.default(req(CHECKOUT, { method: 'OPTIONS' }));
  assert.equal(opt.status, 204);
  const get = await checkout.default(req(CHECKOUT, { method: 'GET', headers: bearer }));
  assert.equal(get.status, 405);
});

test('signup rejects an unknown plan without writing a tenant', async () => {
  setupAuth();
  const res = await signup.default(req(SIGNUP, {
    method: 'POST',
    body: { name: 'Ada', email: 'ada@acme.test', password: 'password1', company: 'Acme', slug: 'acme-co', plan: 'butler' },
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /unknown plan/i);
  assert.equal(calls.some((c) => c.url.includes('/rest/v1/tenants') && (c.method || 'GET') !== 'GET'), false);
});

// ── Pricing page consistency ──────────────────────────────────────────────

const root = new URL('..', import.meta.url);
function read(path) { return readFileSync(new URL(path, root), 'utf8'); }

function parseCards(html) {
  const cards = [];
  const re = /<div class="price-card[^"]*"([^>]*)>([\s\S]*?)<\/div>\s*(?=<div class="price-card|<\/div>\s*<\/div>)/g;
  // Simpler: pull data attributes and visible amounts independently
  const attrRe = /data-plan="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = attrRe.exec(html))) {
    const plan = m[1];
    const rest = m[2];
    const cents = /data-price-cents="(\d+)"/.exec(rest);
    const custom = /data-custom="true"/.test(rest);
    const featured = /data-featured="true"/.test(rest) || /class="price-card featured"/.test(html.slice(Math.max(0, m.index - 40), m.index + 20));
    cards.push({ plan, cents: cents ? Number(cents[1]) : null, custom, featured });
  }
  return cards;
}

for (const page of ['offers-demo.html', 'pricing.html']) {
  test(`${page} cards match _plans.mjs names, prices, and CTAs`, () => {
    const html = read(page);
    assert.equal(html.includes('{{MARK'), false, 'no leftover MARK slots');
    assert.equal(/\b\$99\b/.test(html), false, 'retired $99 Live Agent Starter price must be gone');
    assert.equal(/Live Agent Starter/.test(html), false);
    assert.match(html, /Skip to content/);
    assert.match(html, /id="main"/);

    const starter = getPlan('starter');
    const growth = getPlan('growth');
    assert.match(html, /data-plan="starter"[^>]*data-price-cents="49900"/);
    assert.match(html, /data-plan="growth"[^>]*data-price-cents="99900"/);
    assert.match(html, /data-plan="enterprise"[^>]*data-custom="true"/);
    assert.match(html, new RegExp(`\\$499<span class="period">/month</span>`));
    assert.match(html, new RegExp(`\\$999<span class="period">/month</span>`));
    assert.match(html, /Talk to us/);
    assert.match(html, /href="\/signup.html\?plan=starter"/);
    assert.match(html, /href="\/signup.html\?plan=growth"/);
    assert.match(html, /href="https:\/\/a-gent\.co\/#book-demo"/);
    assert.match(html, /Recommended/);
    for (const feature of starter.features) assert.ok(html.includes(feature), feature);
    for (const feature of growth.features) assert.ok(html.includes(feature), feature);
    for (const feature of PLANS.enterprise.features) assert.ok(html.includes(feature), feature);
    // No fabricated testimonials or customer logos
    assert.equal(/testimonial|as featured in|trusted by/i.test(html), false);
  });
}

test('signup.html plan table matches _plans.mjs and keeps the live-agent alias at $499', () => {
  const html = read('signup.html');
  assert.equal(/\b\$99\b/.test(html), false);
  assert.equal(/Live Agent Starter/.test(html), false);
  assert.match(html, /starter:\s*\{\s*label:\s*'Starter',\s*price:\s*'\$499\/month'/);
  assert.match(html, /growth:\s*\{\s*label:\s*'Growth',\s*price:\s*'\$999\/month'/);
  assert.match(html, /enterprise:\s*\{\s*label:\s*'Custom Build',\s*price:\s*'Talk to us'/);
  assert.match(html, /'live-agent':\s*\{\s*label:\s*'Starter',\s*price:\s*'\$499\/month'/);
  assert.match(html, /wantsCheckout/);
});

test('offers-demo.html and pricing.html advertise the same public prices', () => {
  const a = read('offers-demo.html');
  const b = read('pricing.html');
  for (const needle of ['data-price-cents="49900"', 'data-price-cents="99900"', '$499', '$999', 'Talk to us', 'Starter', 'Growth', 'Custom Build']) {
    assert.ok(a.includes(needle), `offers-demo missing ${needle}`);
    assert.ok(b.includes(needle), `pricing.html missing ${needle}`);
  }
});
