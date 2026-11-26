/**
 * Stripe webhook → keep tenant billing status in sync.
 *
 * POST /api/billing-webhook   (called by Stripe, not the browser)
 *
 * Verifies the Stripe signature (STRIPE_WEBHOOK_SECRET), then reflects
 * subscription lifecycle onto our tables:
 *   - upserts subscriptions(stripe_subscription_id, plan, status, period end,
 *     and price/MRR fields when the optional migration has been applied)
 *   - maps the Stripe status onto tenants.status (active | past_due | suspended | cancelled)
 *   - updates tenants.plan from confirmed subscription metadata / price mapping
 *
 * Resolves the tenant from the event's metadata.tenant_id when present, else by
 * the tenant's stored stripe_customer_id (customer may be a string or { id }).
 *
 * Signature failures return 400. Database / hard sync failures return 500 so
 * Stripe retries — they are no longer swallowed behind a 200.
 */

import crypto from 'node:crypto';
import { env } from './_mcp-connectors.mjs';
import { handleStripeEvent, SyncError } from './_billing-sync.mjs';

// verify lives here historically (tests import it from this module). Keep a
// local implementation that also remains the source of truth for tests, and
// re-export it. (The shared module does not own signature checks.)

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

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
    const result = await handleStripeEvent(event);
    return json({ received: true, ...(result || {}) }, 200);
  } catch (err) {
    console.error('[billing-webhook]', event?.type, err?.message || err);
    const retry = !(err instanceof SyncError) || err.retry !== false;
    return json({ received: false, error: 'sync_failed' }, retry ? 500 : 400);
  }
};

export const config = { path: '/api/billing-webhook' };

// 2026-11 lockdown: Stripe signature + timestamp tolerance.
export default __handler;  // server-to-server webhook: no CORS
