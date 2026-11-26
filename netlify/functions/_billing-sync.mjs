/**
 * Shared Stripe → A-Gent billing sync.
 *
 * Used by billing-webhook (Stripe events) and billing-reconcile (operator
 * backfill). Writes subscriptions + tenants.plan/status. Callers must treat
 * SyncError as a failed sync (do not swallow — Stripe should retry).
 *
 * Price/MRR columns are optional until migrations/20261126_subscriptions_price_mrr.sql
 * is applied; a failed optional PATCH is logged and is not a hard failure.
 */
import { env } from './_mcp-connectors.mjs';
import { serviceCreds } from './_supabase-rest.mjs';

export const TENANT_STATUS = {
  trialing: 'active',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'suspended',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  incomplete: 'active',
  incomplete_expired: 'cancelled',
  paused: 'suspended',
};

/** Product plan names we will write onto tenants.plan / subscriptions.plan. */
export const KNOWN_PLANS = new Set(['trial', 'starter', 'growth', 'enterprise', 'live-agent']);

export class SyncError extends Error {
  constructor(message, { status = 500, retry = true } = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.retry = retry;
  }
}

/** Stripe IDs arrive as a string or an expanded { id }. */
export function stripeId(value) {
  if (!value) return null;
  if (typeof value === 'string' && value !== '[object Object]') return value;
  if (typeof value === 'object' && value.id) return String(value.id);
  return null;
}

/**
 * current_period_end lived on the Subscription object until Stripe's 2025
 * API versions moved it onto subscription items. Accept either shape.
 */
export function periodEndIso(sub) {
  const item = sub?.items?.data?.[0];
  const sec = sub?.current_period_end ?? item?.current_period_end ?? item?.current_period?.end ?? item?.period?.end;
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

export function priceOf(sub) {
  return sub?.items?.data?.[0]?.price || null;
}

export function quantityOf(sub) {
  const q = Number(sub?.items?.data?.[0]?.quantity);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

/**
 * Map a Stripe price + checkout metadata onto a product plan name.
 * Does not invent price IDs — only reads env vars if they are already set.
 */
export function resolvePlan({ metadataPlan, priceId } = {}, getEnv = env) {
  const meta = String(metadataPlan || '').trim();
  if (KNOWN_PLANS.has(meta)) return meta;
  const id = String(priceId || '').trim();
  if (id) {
    const mapped = [
      [getEnv('STRIPE_PRICE_LIVE_AGENT'), 'live-agent'],
      [getEnv('STRIPE_PRICE_STARTER'), 'starter'],
      [getEnv('STRIPE_PRICE_GROWTH'), 'growth'],
      [getEnv('STRIPE_PRICE_ENTERPRISE'), 'enterprise'],
    ];
    for (const [envId, name] of mapped) {
      if (envId && envId === id) return name;
    }
  }
  if (meta && meta !== 'workspace' && meta !== 'unknown') return meta;
  return null;
}

/** Monthly recurring revenue in cents, or null when the price has no recurring amount. */
export function mrrCents(price, quantity = 1) {
  if (!price) return null;
  const unit = Number(price.unit_amount);
  if (!Number.isFinite(unit) || unit < 0) return null;
  const recurring = price.recurring || {};
  const interval = recurring.interval || price.interval || null;
  const count = Number(recurring.interval_count || price.interval_count || 1) || 1;
  const q = Number(quantity || 1) || 1;
  if (!interval) return null;
  const months =
    interval === 'year' ? 12 * count
    : interval === 'week' ? (count * 12) / 52
    : interval === 'day' ? (count * 12) / 365
    : count; // month (and any unknown treated as month-count)
  if (!months) return null;
  return Math.round((unit * q) / months);
}

export function priceFields(sub) {
  const price = priceOf(sub);
  if (!price) return null;
  const quantity = quantityOf(sub);
  return {
    stripe_price_id: price.id || null,
    currency: price.currency || null,
    unit_amount: Number.isFinite(Number(price.unit_amount)) ? Number(price.unit_amount) : null,
    interval: price.recurring?.interval || null,
    interval_count: price.recurring?.interval_count ?? null,
    quantity,
    mrr_cents: mrrCents(price, quantity),
  };
}

export function subscriptionCoreRow(tenantId, sub, plan) {
  return {
    tenant_id: tenantId,
    stripe_subscription_id: stripeId(sub) || sub?.id,
    plan: plan || 'unknown',
    status: sub?.status || 'unknown',
    current_period_end: periodEndIso(sub),
  };
}

function creds() { return serviceCreds(); }

export async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

export async function restOk(path, init = {}) {
  const res = await rest(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SyncError(`Supabase ${init.method || 'GET'} ${path.split('?')[0]} → ${res.status}${body ? ': ' + body.slice(0, 300) : ''}`, { status: res.status });
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Resolve the tenant for a Stripe object.
 * 1. metadata.tenant_id (session, subscription, or invoice.subscription_details)
 * 2. expanded subscription.metadata.tenant_id
 * 3. tenants.stripe_customer_id (customer may be a string or { id })
 */
export async function tenantIdFor(obj) {
  const direct = obj?.metadata?.tenant_id
    || obj?.subscription_details?.metadata?.tenant_id
    || (typeof obj?.subscription === 'object' && obj.subscription?.metadata?.tenant_id)
    || null;
  if (direct) return direct;
  const customer = stripeId(obj?.customer);
  if (!customer) return null;
  const rows = await restOk(`tenants?stripe_customer_id=eq.${encodeURIComponent(customer)}&select=id&limit=1`);
  return rows?.[0]?.id || null;
}

export async function upsertSubscription(tenantId, sub, { plan } = {}) {
  const subId = stripeId(sub) || sub?.id;
  if (!tenantId || !subId) throw new SyncError('upsertSubscription: missing tenant or subscription id');
  const resolvedPlan = plan || resolvePlan({
    metadataPlan: sub?.metadata?.plan,
    priceId: priceOf(sub)?.id,
  }) || 'unknown';
  const core = subscriptionCoreRow(tenantId, { ...sub, id: subId }, resolvedPlan);
  await restOk('subscriptions?on_conflict=stripe_subscription_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(core),
  });
  const extra = priceFields(sub);
  if (extra) {
    try {
      await restOk(`subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(extra),
      });
    } catch (err) {
      // Optional columns land only after the unapplied migration is run.
      console.warn('[billing-sync] price/MRR columns not written (migration may be pending):', err.message);
    }
  }
  return { ...core, ...(extra || {}) };
}

/** PATCH only `status` on an existing subscription row — never touches plan or period end. */
export async function patchSubscriptionStatus(subscriptionId, status) {
  const subId = stripeId(subscriptionId) || subscriptionId;
  if (!subId || !status) throw new SyncError('patchSubscriptionStatus: missing id or status');
  await restOk(`subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status }),
  });
}

export async function updateTenantBilling(tenantId, { status, plan } = {}) {
  if (!tenantId) return;
  const patch = {};
  if (status) patch.status = status;
  // Never write unknown/workspace/empty onto tenants.plan. Keep signup plan
  // until a confirmed product plan is known.
  if (plan && KNOWN_PLANS.has(plan)) patch.plan = plan;
  if (!Object.keys(patch).length) return;
  await restOk(`tenants?id=eq.${encodeURIComponent(tenantId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

export async function stripeGet(path) {
  const secret = env('STRIPE_SECRET_KEY');
  if (!secret) throw new SyncError('STRIPE_SECRET_KEY is not set', { status: 503, retry: false });
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SyncError(data?.error?.message || `Stripe GET ${path.split('?')[0]} → ${res.status}`, { status: res.status });
  }
  return data;
}

export async function retrieveSubscription(id) {
  const subId = stripeId(id) || id;
  if (!subId) return null;
  const data = await stripeGet(`subscriptions/${encodeURIComponent(subId)}?expand[]=items.data.price`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.id) {
    throw new SyncError('Stripe subscription retrieve returned an unexpected payload');
  }
  return data;
}

export async function listCustomerSubscriptions(customerId) {
  const id = stripeId(customerId) || customerId;
  if (!id) return [];
  const data = await stripeGet(`subscriptions?customer=${encodeURIComponent(id)}&status=all&limit=100&expand[]=data.items.data.price`);
  return data?.data || [];
}

export async function syncSubscription(tenantId, sub) {
  const plan = resolvePlan({
    metadataPlan: sub?.metadata?.plan,
    priceId: priceOf(sub)?.id,
  });
  await upsertSubscription(tenantId, sub, { plan });
  const tenantStatus = TENANT_STATUS[sub?.status] || null;
  await updateTenantBilling(tenantId, { status: tenantStatus, plan });
  return { plan, status: sub?.status, tenantStatus };
}

function attachSessionPlan(sub, obj) {
  if (!sub) return sub;
  const plan = obj?.metadata?.plan;
  if (plan && !sub.metadata?.plan) {
    sub = { ...sub, metadata: { ...(sub.metadata || {}), plan, tenant_id: sub.metadata?.tenant_id || obj?.metadata?.tenant_id } };
  }
  return sub;
}

/**
 * Reflect one verified Stripe event onto subscriptions + tenants.
 * Returns a small result object. Throws SyncError on DB (or hard) failure.
 * Unknown events and unmapped tenants are ignored (no throw) so Stripe does
 * not retry forever for objects that are not in this database.
 */
export async function handleStripeEvent(event) {
  const obj = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed': {
      const tenantId = await tenantIdFor(obj);
      if (!tenantId) return { ignored: 'no_tenant' };
      let sub = (typeof obj.subscription === 'object' && obj.subscription?.id) ? obj.subscription : null;
      const subId = stripeId(obj.subscription);
      let retrieveFailed = false;
      if (!sub && subId) {
        try {
          sub = await retrieveSubscription(subId);
        } catch (err) {
          console.warn('[billing-sync] checkout retrieve failed:', err.message);
          sub = { id: subId, status: 'active', metadata: { plan: obj.metadata?.plan, tenant_id: tenantId } };
          retrieveFailed = true;
        }
      }
      sub = attachSessionPlan(sub, obj);
      if (sub) await syncSubscription(tenantId, sub);
      else await updateTenantBilling(tenantId, { status: 'active', plan: resolvePlan({ metadataPlan: obj.metadata?.plan }) });
      if (retrieveFailed) {
        throw new SyncError('checkout.session.completed: subscription retrieve failed after writing a stub; Stripe should retry', { status: 502 });
      }
      return { tenantId, synced: !!sub };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const tenantId = await tenantIdFor(obj);
      if (!tenantId) return { ignored: 'no_tenant' };
      await syncSubscription(tenantId, obj);
      return { tenantId };
    }
    case 'customer.subscription.deleted': {
      const tenantId = await tenantIdFor(obj);
      if (!tenantId) return { ignored: 'no_tenant' };
      await upsertSubscription(tenantId, { ...obj, status: obj.status || 'canceled' });
      await updateTenantBilling(tenantId, { status: 'cancelled' });
      return { tenantId };
    }
    case 'invoice.paid': {
      const tenantId = await tenantIdFor(obj);
      if (!tenantId) return { ignored: 'no_tenant' };
      const subId = stripeId(obj.subscription);
      if (subId) {
        let sub;
        try {
          sub = await retrieveSubscription(subId);
        } catch (err) {
          console.warn('[billing-sync] invoice.paid retrieve failed:', err.message);
          // Do not write a sparse row (it would clobber plan / current_period_end).
          throw new SyncError('invoice.paid: subscription retrieve failed; Stripe should retry', { status: 502 });
        }
        await syncSubscription(tenantId, sub);
      } else {
        await updateTenantBilling(tenantId, { status: 'active' });
      }
      return { tenantId };
    }
    case 'invoice.payment_failed': {
      const tenantId = await tenantIdFor(obj);
      if (!tenantId) return { ignored: 'no_tenant' };
      const subId = stripeId(obj.subscription);
      if (subId) {
        try {
          const sub = await retrieveSubscription(subId);
          await syncSubscription(tenantId, { ...sub, status: 'past_due' });
        } catch (err) {
          console.warn('[billing-sync] invoice.payment_failed retrieve failed; status-only patch:', err.message);
          // Existing plan and current_period_end must stay intact.
          await patchSubscriptionStatus(subId, 'past_due');
        }
      }
      await updateTenantBilling(tenantId, { status: 'past_due' });
      return { tenantId };
    }
    default:
      return { ignored: 'unhandled_event' };
  }
}

/**
 * Backfill one tenant that already has a Stripe customer id. Used by the
 * operator-only reconciliation endpoint for the existing unsynced customers.
 */
export async function reconcileTenant(tenant) {
  const customerId = tenant?.stripe_customer_id;
  if (!tenant?.id || !customerId) return { tenant_id: tenant?.id, skipped: 'no_stripe_customer' };
  const subs = await listCustomerSubscriptions(customerId);
  const synced = [];
  for (const sub of subs) {
    await syncSubscription(tenant.id, sub);
    synced.push({ stripe_subscription_id: sub.id, status: sub.status, plan: resolvePlan({ metadataPlan: sub.metadata?.plan, priceId: priceOf(sub)?.id }) });
  }
  if (!subs.length) {
    // Customer exists in Stripe but has no subscription — do not invent one.
    return { tenant_id: tenant.id, subscriptions: 0, note: 'stripe_customer_has_no_subscriptions' };
  }
  return { tenant_id: tenant.id, subscriptions: synced.length, synced };
}
