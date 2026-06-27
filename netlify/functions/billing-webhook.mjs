/**
 * Stripe webhook → keep tenant billing status in sync.
 *
 * POST /api/billing-webhook   (called by Stripe, not the browser)
 *
 * Verifies the Stripe signature (STRIPE_WEBHOOK_SECRET), then reflects
 * subscription lifecycle onto our tables:
 *   - upserts subscriptions(stripe_subscription_id, plan, status, period end)
 *   - maps the Stripe status onto tenants.status (active | past_due | suspended | cancelled)
 *
 * Resolves the tenant from the event's metadata.tenant_id when present, else by
 * the tenant's stored stripe_customer_id. Always returns 200 quickly so Stripe
 * doesn't retry on our own downstream hiccups (logged instead).
 */

import crypto from 'node:crypto';
import { env } from './_mcp-connectors.mjs';

function creds() { return { url: env('SUPABASE_URL'), key: env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY') }; }
async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

// Verify Stripe's signature header against the raw body (no SDK).
function verify(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((kv) => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch { return false; }
}

// Stripe subscription status → our tenants.status
const TENANT_STATUS = { trialing: 'active', active: 'active', past_due: 'past_due', unpaid: 'suspended', canceled: 'cancelled', incomplete_expired: 'cancelled' };

async function tenantIdFor(obj) {
  if (obj?.metadata?.tenant_id) return obj.metadata.tenant_id;
  const customer = obj?.customer;
  if (!customer) return null;
  const res = await rest(`tenants?stripe_customer_id=eq.${encodeURIComponent(customer)}&select=id&limit=1`);
  if (!res.ok) return null;
  return (await res.json())[0]?.id || null;
}

async function setTenantStatus(tenantId, status) {
  if (!tenantId || !status) return;
  await rest(`tenants?id=eq.${tenantId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
}

async function upsertSubscription(tenantId, sub) {
  if (!tenantId || !sub?.id) return;
  const row = {
    tenant_id: tenantId,
    stripe_subscription_id: sub.id,
    plan: sub.items?.data?.[0]?.price?.id || 'unknown',
    status: sub.status,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
  };
  await rest('subscriptions?on_conflict=stripe_subscription_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const secret = env('STRIPE_WEBHOOK_SECRET');
  const raw = await req.text();
  const sig = req.headers.get('stripe-signature');
  if (!verify(raw, sig, secret)) return new Response('bad signature', { status: 400 });

  let event;
  try { event = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  try {
    const obj = event.data?.object || {};
    switch (event.type) {
      case 'checkout.session.completed': {
        const tenantId = await tenantIdFor(obj);
        await setTenantStatus(tenantId, 'active');
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const tenantId = await tenantIdFor(obj);
        await upsertSubscription(tenantId, obj);
        await setTenantStatus(tenantId, TENANT_STATUS[obj.status] || 'active');
        break;
      }
      case 'customer.subscription.deleted': {
        const tenantId = await tenantIdFor(obj);
        await upsertSubscription(tenantId, obj);
        await setTenantStatus(tenantId, 'cancelled');
        break;
      }
      case 'invoice.payment_failed': {
        const tenantId = await tenantIdFor(obj);
        await setTenantStatus(tenantId, 'past_due');
        break;
      }
      default:
        break; // ignore other events
    }
  } catch (err) {
    console.error('[billing-webhook]', event?.type, err.message);
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/billing-webhook' };
