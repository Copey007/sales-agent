/**
 * Operator-only Stripe subscription backfill.
 *
 * POST /api/billing-reconcile  (Authorization: Bearer <operator jwt>)
 *   { tenant_id? }   optional — limit to one tenant; otherwise every tenant
 *                    that already has a stripe_customer_id
 *   → { ok, tenants, subscriptions, results[] }
 *
 * Looks up each tenant's Stripe subscriptions and runs the same upsert path
 * the webhook uses. Fail-closed: requireOperator (no internal-token bypass).
 * Returns 503 when OPERATOR_EMAILS is unset or Stripe is not configured.
 *
 * This exists because seven live tenants already have a Stripe customer id
 * but zero subscription rows (the webhook never persisted them). It does
 * not invent customers or plans.
 */

import { env } from './_mcp-connectors.mjs';
import { serviceCreds } from './_supabase-rest.mjs';
import { withCors, json as corsJson } from './_auth.mjs';
import { operatorGuard } from './_tenant.mjs';
import { reconcileTenant, SyncError } from './_billing-sync.mjs';

const json = (req, body, status = 200) => corsJson(req, body, status);

async function listStripeTenants(tenantId) {
  const { url, key } = serviceCreds();
  let path = 'tenants?stripe_customer_id=not.is.null&select=id,slug,name,plan,status,stripe_customer_id&order=created_at.asc';
  if (tenantId) path += `&id=eq.${encodeURIComponent(tenantId)}`;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SyncError(`Failed to list tenants (${res.status})${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return res.json();
}

const __handler = async (req) => {
  if (req.method !== 'POST') return json(req, { error: 'POST only' }, 405);
  if (!env('STRIPE_SECRET_KEY')) return json(req, { error: 'stripe_not_configured' }, 503);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const tenantId = typeof body?.tenant_id === 'string' ? body.tenant_id.trim() : '';

  let tenants;
  try {
    tenants = await listStripeTenants(tenantId || null);
  } catch (err) {
    console.error('[billing-reconcile] list tenants', err.message);
    return json(req, { error: 'internal_error' }, 500);
  }

  const results = [];
  let subscriptionCount = 0;
  for (const tenant of tenants) {
    try {
      const result = await reconcileTenant(tenant);
      subscriptionCount += result.subscriptions || 0;
      results.push(result);
    } catch (err) {
      console.error('[billing-reconcile]', tenant.id, err.message);
      results.push({ tenant_id: tenant.id, error: 'sync_failed' });
    }
  }

  return json(req, {
    ok: true,
    tenants: tenants.length,
    subscriptions: subscriptionCount,
    results,
  });
};

export const config = { path: '/api/billing-reconcile' };

// Operator JWT only — fail closed when OPERATOR_EMAILS is unset.
export default withCors(__handler, { guard: operatorGuard({ allowInternal: false }) });
