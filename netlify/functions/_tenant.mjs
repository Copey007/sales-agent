/**
 * Tenant context helper — the single place every function resolves "who is
 * this request acting for, what are they allowed to do, and how do we meter
 * it." Built on the Platform Core tables (see platform-schema.sql).
 *
 * Public/hosted surfaces resolve the tenant implicitly (e.g. avatar pages via
 * the agent's tenant_id). Authenticated control-plane endpoints resolve it
 * from a Supabase Auth JWT. All trusted reads/writes use the service-role key
 * and therefore bypass RLS.
 */

import { env, initConnectors } from './_mcp-connectors.mjs';

let _init = false;
function ensureInit() { if (!_init) { initConnectors(); _init = true; } }
function creds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return { url, key };
}
async function rest(path, init = {}) {
  ensureInit();
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

// ─── Tenant + entitlements ──────────────────────────────────────────────────

/** Fetch a tenant by id or slug. */
export async function getTenant(idOrSlug) {
  if (!idOrSlug) return null;
  const col = /^[0-9a-f-]{36}$/i.test(idOrSlug) ? 'id' : 'slug';
  const res = await rest(`tenants?${col}=eq.${encodeURIComponent(idOrSlug)}&limit=1`);
  if (!res.ok) return null;
  return (await res.json())[0] || null;
}

/** Fetch a tenant's module entitlement (enabled flag, config, limits). */
export async function getTenantModule(tenantId, module) {
  if (!tenantId) return null;
  const res = await rest(`tenant_modules?tenant_id=eq.${tenantId}&module=eq.${encodeURIComponent(module)}&limit=1`);
  if (!res.ok) return null;
  return (await res.json())[0] || null;
}

/** True if the tenant has the module enabled (defaults open if the table isn't there yet). */
export async function moduleEnabled(tenantId, module) {
  try {
    const m = await getTenantModule(tenantId, module);
    return m ? !!m.enabled : true;
  } catch { return true; }
}

// ─── Usage metering (unified billing basis) ─────────────────────────────────

/** Record a usage event. Non-fatal — never breaks the product if metering fails. */
export async function recordUsage({ tenantId, module, metric, quantity = 0, metadata = {} }) {
  if (!tenantId || !module || !metric) return false;
  try {
    const res = await rest('usage_events', {
      method: 'POST',
      body: JSON.stringify({ tenant_id: tenantId, module, metric, quantity, metadata }),
    });
    return res.ok;
  } catch (e) {
    console.warn('[tenant] recordUsage failed:', e.message);
    return false;
  }
}

/** Sum a usage metric for the current calendar month. */
export async function monthlyUsage(tenantId, module, metric) {
  const start = new Date();
  const monthStart = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00Z`;
  const res = await rest(
    `usage_events?tenant_id=eq.${tenantId}&module=eq.${encodeURIComponent(module)}&metric=eq.${encodeURIComponent(metric)}` +
    `&occurred_at=gte.${monthStart}&select=quantity&limit=100000`
  );
  if (!res.ok) return 0;
  return (await res.json()).reduce((s, r) => s + Number(r.quantity || 0), 0);
}

// ─── Identity (authenticated control plane) ─────────────────────────────────

/** Validate a Supabase Auth JWT and return the user, or null. */
export async function userFromToken(token) {
  if (!token) return null;
  ensureInit();
  const { url, key } = creds();
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Resolve {tenant, role, user} from a request's Bearer JWT. Optional tenantSlug
 * disambiguates when a user belongs to multiple tenants. Returns null if
 * unauthenticated or not a member.
 */
export async function tenantFromRequest(req, { tenantSlug = null } = {}) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const user = await userFromToken(token);
  if (!user?.id) return null;

  let q = `memberships?user_id=eq.${user.id}&select=role,tenant_id,tenants(id,slug,name,plan,status)`;
  const res = await rest(q);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;

  const row = tenantSlug ? rows.find((r) => r.tenants?.slug === tenantSlug) : rows[0];
  if (!row) return null;
  return { user, role: row.role, tenant: row.tenants };
}
