/**
 * Canonical A-Gent Fleet workspace plans.
 *
 * Single source of truth for plan keys, public names, monthly prices,
 * checkout eligibility, Stripe price env-var mapping, and pricing-page copy.
 * Stripe Price IDs are never hardcoded — Mark sets them in Netlify as
 * STRIPE_PRICE_STARTER / STRIPE_PRICE_GROWTH (and legacy fallbacks).
 *
 * tenants.plan remains: trial | starter | growth | enterprise.
 * "live-agent" is a legacy checkout alias for Starter ($499/mo, the previous
 * featured "Live Agent" price). It is normalized to "starter" when stored.
 *
 * Blended target: Mark approved ~$700/mo blended across Starter/Growth.
 * Starter $499 + Growth $999 at a 60/40 mix = $699/mo.
 */

export const TRIAL_DAYS = 15;
export const CURRENCY = 'usd';
export const BILLING_INTERVAL = 'month';
export const BLENDED_TARGET_CENTS = 70000;
export const BLENDED_STARTER_SHARE = 0.6;

export const PLANS = Object.freeze({
  starter: Object.freeze({
    key: 'starter',
    name: 'Starter',
    tagline: 'For founder-led sales and small teams running their first always-on outbound.',
    monthlyCents: 49900,
    checkout: true,
    featured: false,
    custom: false,
    priceEnv: 'STRIPE_PRICE_STARTER',
    ctaLabel: 'Start 15-day trial',
    ctaHref: '/signup.html?plan=starter',
    features: Object.freeze([
      '15-day free trial; card required, no charge until the trial ends',
      'Human-approval Review Queue',
      'Signal Engine with source-linked reasons',
      'Included prospecting volume and a connected sending mailbox',
      'Deliverability guardrails (SPF/DKIM/DMARC checks, daily send caps)',
      'Email support',
    ]),
  }),
  growth: Object.freeze({
    key: 'growth',
    name: 'Growth',
    tagline: 'For SDR and AE teams that want a supervised AI SDR running every day.',
    monthlyCents: 99900,
    checkout: true,
    featured: true,
    custom: false,
    priceEnv: 'STRIPE_PRICE_GROWTH',
    ctaLabel: 'Start 15-day trial',
    ctaHref: '/signup.html?plan=growth',
    features: Object.freeze([
      'Everything in Starter',
      'Higher included prospecting volume, seats, and mailboxes',
      'Loop Engine',
      'CRM sync (A-Gent CRM, HubSpot, and Salesforce)',
      'Mission Control dashboard',
      'Priority support',
    ]),
  }),
  enterprise: Object.freeze({
    key: 'enterprise',
    name: 'Enterprise',
    publicName: 'Custom Build',
    tagline: 'For revenue leaders who want a bespoke AI GTM system designed and run with A-Gent Consulting.',
    monthlyCents: null,
    checkout: false,
    featured: false,
    custom: true,
    priceEnv: null,
    priceLabel: 'Talk to us',
    ctaLabel: 'Book a demo',
    ctaHref: 'https://askarlen.com/demo',
    features: Object.freeze([
      'CRO diagnostic and GTM Brain setup',
      'Custom integrations and workflow design',
      'Managed operations on A-Gent Fleet',
      'Built on The GTM REVolution methodology',
    ]),
  }),
});

/** Legacy public/checkout aliases → canonical tenants.plan key. */
export const PLAN_ALIASES = Object.freeze({
  'live-agent': 'starter',
});

export function canonicalPlanKey(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return '';
  return PLAN_ALIASES[key] || key;
}

export function getPlan(raw) {
  const key = canonicalPlanKey(raw);
  return key && PLANS[key] ? PLANS[key] : null;
}

export function formatMonthlyUsd(cents) {
  if (cents == null) return null;
  return `$${Math.round(cents / 100)}`;
}

export function publicPriceLabel(plan) {
  if (!plan) return '';
  if (plan.custom || plan.monthlyCents == null) return plan.priceLabel || 'Talk to us';
  return `${formatMonthlyUsd(plan.monthlyCents)}/month`;
}

/** 60/40 Starter/Growth mix, in cents (defaults to the approved ~$700 target). */
export function blendedMonthlyCents(starterShare = BLENDED_STARTER_SHARE) {
  return Math.round(PLANS.starter.monthlyCents * starterShare + PLANS.growth.monthlyCents * (1 - starterShare));
}

/**
 * Normalize a signup `plan` field to a tenants.plan value.
 * Empty → trial. Known keys and aliases are accepted. Anything else fails closed.
 */
export function normalizeSignupPlan(raw) {
  const requested = String(raw || '').trim();
  if (!requested) return { ok: true, key: 'trial' };
  const key = canonicalPlanKey(requested);
  if (key === 'trial' || PLANS[key]) return { ok: true, key, requested };
  return { ok: false, reason: 'Unknown plan.', requested };
}

function envValue(envFn, name) {
  const v = envFn ? envFn(name) : '';
  return (v && String(v).trim()) || '';
}

/**
 * Resolve the Stripe Price id for a checkout request.
 *
 * Fail-closed rules:
 *   - starter  → STRIPE_PRICE_STARTER only (never silently bill another plan)
 *   - growth   → STRIPE_PRICE_GROWTH only
 *   - enterprise / unknown paid plan → not checkoutable
 *
 * Backward-compatible fallbacks:
 *   - no plan (legacy default workspace checkout) → STRIPE_PRICE_ID
 *   - live-agent → STRIPE_PRICE_LIVE_AGENT, then STRIPE_PRICE_STARTER, then STRIPE_PRICE_ID
 *
 * Returns the Price id string in `priceId` (tests must never log or assert live secrets;
 * tests supply dummy `price_test_*` values). Does not call Stripe.
 */
export function resolveStripePrice(planRaw, envFn) {
  const requested = String(planRaw || '').trim();

  if (!requested) {
    const envVar = 'STRIPE_PRICE_ID';
    const priceId = envValue(envFn, envVar);
    if (!priceId) {
      return { ok: false, configured: false, reason: 'No Stripe price configured for this plan.', envVar };
    }
    return { ok: true, configured: true, planKey: '', canonicalKey: '', priceId, envVar };
  }

  if (requested === 'live-agent') {
    const fallbacks = ['STRIPE_PRICE_LIVE_AGENT', 'STRIPE_PRICE_STARTER', 'STRIPE_PRICE_ID'];
    for (const envVar of fallbacks) {
      const priceId = envValue(envFn, envVar);
      if (priceId) {
        return { ok: true, configured: true, planKey: 'live-agent', canonicalKey: 'starter', priceId, envVar };
      }
    }
    return {
      ok: false,
      configured: false,
      reason: 'STRIPE_PRICE_LIVE_AGENT is not configured.',
      envVar: 'STRIPE_PRICE_LIVE_AGENT',
    };
  }

  const plan = getPlan(requested);
  if (!plan || !plan.checkout) {
    return { ok: false, configured: false, status: 400, reason: 'This plan cannot be checked out online.', envVar: null };
  }

  const envVar = plan.priceEnv;
  const priceId = envValue(envFn, envVar);
  if (!priceId) {
    return { ok: false, configured: false, reason: `${envVar} is not configured.`, envVar };
  }
  return { ok: true, configured: true, planKey: plan.key, canonicalKey: plan.key, priceId, envVar };
}

export const PUBLIC_CHECKOUT_PLANS = Object.freeze(['starter', 'growth']);
