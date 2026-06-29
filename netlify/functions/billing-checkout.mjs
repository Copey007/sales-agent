/**
 * Billing checkout — card-required free trial via Stripe Checkout.
 *
 * POST /api/billing-checkout  (Authorization: Bearer <jwt>)
 *   { success_url?, cancel_url?, trial_days? }   trial_days defaults to 15 (0–60)
 *   → { url }                              Stripe Checkout URL (redirect the user)
 *   → { configured:false }                 Stripe not wired yet (no keys) — caller
 *                                          should proceed on trial and prompt later
 *
 * Creates a subscription Checkout Session with a free trial and ALWAYS collects
 * a card (payment_method_collection: 'always'), so it converts automatically when
 * the trial ends. Stores the Stripe customer id on the tenant. Pure REST against the
 * Stripe API — no SDK. Gated on STRIPE_SECRET_KEY + STRIPE_PRICE_ID.
 */

import { env } from './_mcp-connectors.mjs';
import { tenantFromRequest } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

function sbCreds() { return { url: env('SUPABASE_URL'), key: env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY') }; }
async function sbRest(path, init = {}) {
  const { url, key } = sbCreds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

// Stripe form-encoded POST helper.
async function stripe(secret, path, form) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${res.status}`);
  return data;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const SECRET = env('STRIPE_SECRET_KEY');
  if (!SECRET) return json({ configured: false, reason: 'Stripe not configured (STRIPE_SECRET_KEY).' });

  const ctx = await tenantFromRequest(req);
  if (!ctx?.tenant?.id) return json({ error: 'unauthorized' }, 401);
  const tenant = ctx.tenant;

  let b = {}; try { b = await req.json(); } catch {}
  // Resolve the price from the selected plan (offers page), else the default
  // workspace price. Each plan's price id lives in its own env var.
  const plan = (b.plan || '').trim();
  const PLAN_PRICE_ENV = { 'live-agent': 'STRIPE_PRICE_LIVE_AGENT', 'starter': 'STRIPE_PRICE_STARTER' };
  const PRICE = (PLAN_PRICE_ENV[plan] && env(PLAN_PRICE_ENV[plan])) || env('STRIPE_PRICE_ID');
  if (!PRICE) return json({ configured: false, reason: 'No Stripe price configured for this plan.' });

  const successUrl = b.success_url || 'https://missioncontrol.a-gent.co/?welcome=1';
  const cancelUrl = b.cancel_url || 'https://missioncontrol.a-gent.co/?billing=cancelled';
  const trialDays = Math.min(60, Math.max(0, parseInt(b.trial_days, 10) || 15));

  try {
    // Reuse or create the Stripe customer for this tenant.
    let customerId = tenant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe(SECRET, 'customers', { name: tenant.name, email: ctx.user?.email || '', 'metadata[tenant_id]': tenant.id, 'metadata[slug]': tenant.slug });
      customerId = customer.id;
      await sbRest(`tenants?id=eq.${tenant.id}`, { method: 'PATCH', body: JSON.stringify({ stripe_customer_id: customerId }) });
    }

    const session = await stripe(SECRET, 'checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      'line_items[0][price]': PRICE,
      'line_items[0][quantity]': '1',
      'subscription_data[trial_period_days]': String(trialDays),
      payment_method_collection: 'always',         // card required up front
      success_url: successUrl,
      cancel_url: cancelUrl,
      'metadata[tenant_id]': tenant.id,
      'metadata[plan]': plan || 'workspace',
    });

    return json({ url: session.url });
  } catch (err) {
    console.error('[billing-checkout]', err.message);
    return json({ error: err.message }, 502);
  }
};

export const config = { path: '/api/billing-checkout' };
