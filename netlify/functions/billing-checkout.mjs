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
 * the trial ends. Stores the Stripe customer id on the tenant (and reuses it on
 * later checkouts — tenantFromRequest now selects stripe_customer_id). Stamps
 * tenant_id and plan onto both session metadata and subscription_data.metadata
 * so the webhook can resolve the tenant on subscription events. Pure REST against
 * the Stripe API — no SDK. Gated on STRIPE_SECRET_KEY plus the plan's
 * STRIPE_PRICE_* env var (see _plans.mjs). Fails closed when that var is missing.
 */

import { env } from './_mcp-connectors.mjs';
import { serviceCreds } from './_supabase-rest.mjs';
import { tenantFromRequest } from './_tenant.mjs';
import { withCors } from './_auth.mjs';
import { tenantGuard } from './_tenant.mjs';
import { resolveStripePrice, TRIAL_DAYS as DEFAULT_TRIAL_DAYS } from './_plans.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

// Service role only — never the anon key (fails closed if unset; see _supabase-rest.mjs).
function sbCreds() { return serviceCreds(); }
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

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const SECRET = env('STRIPE_SECRET_KEY');
  if (!SECRET) return json({ configured: false, reason: 'Stripe not configured (STRIPE_SECRET_KEY).' });

  const ctx = await tenantFromRequest(req);
  if (!ctx?.tenant?.id) return json({ error: 'unauthorized' }, 401);
  const tenant = ctx.tenant;

  let b = {}; try { b = await req.json(); } catch {}
  // Resolve the price from the selected plan (offers / pricing page), else the
  // default workspace price. Never bills a different plan's price as a fallback
  // for starter/growth — see resolveStripePrice in _plans.mjs.
  const plan = (b.plan || '').trim();
  const resolved = resolveStripePrice(plan, env);
  if (!resolved.ok) {
    return json(
      { configured: false, reason: resolved.reason, env_var: resolved.envVar || undefined },
      resolved.status || 200,
    );
  }
  const PRICE = resolved.priceId;

  const successUrl = b.success_url || 'https://missioncontrol.askarlen.com/?welcome=1';
  const cancelUrl = b.cancel_url || 'https://missioncontrol.askarlen.com/?billing=cancelled';
  const trialDays = Math.min(60, Math.max(0, parseInt(b.trial_days, 10) || DEFAULT_TRIAL_DAYS));

  try {
    // Reuse or create the Stripe customer for this tenant.
    let customerId = tenant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe(SECRET, 'customers', { name: tenant.name, email: ctx.user?.email || '', 'metadata[tenant_id]': tenant.id, 'metadata[slug]': tenant.slug });
      customerId = customer.id;
      const saved = await sbRest(`tenants?id=eq.${tenant.id}`, { method: 'PATCH', body: JSON.stringify({ stripe_customer_id: customerId }) });
      if (!saved.ok) {
        const detail = await saved.text().catch(() => '');
        throw new Error(`Failed to store stripe_customer_id (${saved.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
      }
    }

    // metadata on the session is not copied onto the Subscription object,
    // so also stamp tenant_id / plan onto subscription_data.metadata. That is
    // what customer.subscription.* events carry.
    const session = await stripe(SECRET, 'checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      'line_items[0][price]': PRICE,
      'line_items[0][quantity]': '1',
      'subscription_data[trial_period_days]': String(trialDays),
      'subscription_data[metadata][tenant_id]': tenant.id,
      'subscription_data[metadata][plan]': resolved.canonicalKey || 'workspace',
      payment_method_collection: 'always',         // card required up front
      success_url: successUrl,
      cancel_url: cancelUrl,
      'metadata[tenant_id]': tenant.id,
      'metadata[plan]': resolved.canonicalKey || 'workspace',
      'metadata[plan_requested]': plan || '',
    });

    return json({ url: session.url });
  } catch (err) {
    console.error('[billing-checkout]', err.message);
    return json({ error: err.message }, 502);
  }
};

export const config = { path: '/api/billing-checkout' };

// Security wrapper: allowlisted CORS + tenant auth guard (2026-11 lockdown).
export default withCors(__handler, { guard: tenantGuard() });
