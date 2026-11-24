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
import { serviceCreds } from './_supabase-rest.mjs';

// Service role only — never the anon key (fails closed if unset; see _supabase-rest.mjs).
function creds() { return serviceCreds(); }
async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

// Verify Stripe's signature header against the raw body (no SDK).
// Accepts any of multiple v1 signatures (secret rotation) and rejects
// timestamps older/newer than 5 minutes (replay protection).
export function verify(rawBody, sigHeader, secret, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!sigHeader || !secret) return false;
  let t = null; const v1s = [];
  for (const kv of String(sigHeader).split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') v1s.push(v);
  }
  if (!t || !v1s.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return v1s.some((v1) => { const got = Buffer.from(v1); return got.length === expected.length && crypto.timingSafeEqual(got, expected); });
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

const __handler = async (req) => {
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

// 2026-11 lockdown: Stripe signature + timestamp tolerance.
export default __handler;  // server-to-server webhook: no CORS
