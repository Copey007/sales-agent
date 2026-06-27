/**
 * Billing checkout — card-required 30-day trial via Stripe Checkout.
 *
 * POST /api/billing-checkout  (Authorization: Bearer <jwt>)
 *   { success_url?, cancel_url? }
 *   → { url }                              Stripe Checkout URL (redirect the user)
 *   → { configured:false }                 Stripe not wired yet (no keys) — caller
 *                                          should proceed on trial and prompt later
 *
 * Creates a subscription Checkout Session with a 30-day trial and ALWAYS collects
 * a card (payment_method_collection: 'always'), so it converts automatically on
 * day 31. Stores the Stripe customer id on the tenant. Pure REST against the
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
  const PRICE = env('STRIPE_PRICE_ID');
  if (!SECRET || !PRICE) return json({ configured: false, reason: 'Stripe not configured (STRIPE_SECRET_KEY / STRIPE_PRICE_ID).' });

  const ctx = await tenantFromRequest(req);
  if (!ctx?.tenant?.id) return json({ error: 'unauthorized' }, 401);
  const tenant = ctx.tenant;

  let b = {}; try { b = await req.json(); } catch {}
  const successUrl = b.success_url || 'https://missioncontrol.a-gent.co/?welcome=1';
  const cancelUrl = b.cancel_url || 'https://missioncontrol.a-gent.co/?billing=cancelled';

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
      'subscription_data[trial_period_days]': '30',
      payment_method_collection: 'always',         // card required up front
      success_url: successUrl,
      cancel_url: cancelUrl,
      'metadata[tenant_id]': tenant.id,
    });

    return json({ url: session.url });
  } catch (err) {
    console.error('[billing-checkout]', err.message);
    return json({ error: err.message }, 502);
  }
};

export const config = { path: '/api/billing-checkout' };
