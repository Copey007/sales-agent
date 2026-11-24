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
import { serviceCreds } from './_supabase-rest.mjs';
import { isInternalCall, json } from './_auth.mjs';

let _init = false;
function ensureInit() { if (!_init) { initConnectors(); _init = true; } }
// Trusted server reads/writes: service role only (no anon fallback — see _supabase-rest.mjs).
function creds() { return serviceCreds(); }
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
  // GET /auth/v1/user validates the *user's* JWT (Authorization header); the
  // apikey header only identifies the project, so the public anon/publishable
  // key is sufficient and preferred. Falls back to the service key if only
  // that is configured.
  const url = env('SUPABASE_URL');
  const apikey = env('SUPABASE_ANON_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !apikey) return null;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
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

/**
 * Per-request tenant resolution for the campaign engine.
 *
 * SECURITY (2026-11 lockdown): there is NO unauthenticated fallback any more.
 *   internal X-Internal-Token        → { internal: true, tenantId: null }   (caller decides scope)
 *   no / bad Authorization header    → { invalid: true, status: 401 }
 *   platform operator (allowlist)    → { tenantId: MASTER, role: 'owner', operator: true }
 *   valid membership                 → { tenantId, user, role, tenant }
 *   valid login, no membership       → { invalid: true, status: 403 }   (was: master-tenant owner)
 *
 * Operators are ONLY the emails in OPERATOR_EMAILS (or legacy
 * PLATFORM_OPERATOR_EMAILS), comma-separated, with a confirmed email. The old
 * blanket "any @a-gent.co address is an operator" rule is removed — /api/signup
 * auto-confirms new users, so anyone could have registered x@a-gent.co.
 * No allowlist configured → nobody is an operator (fail closed).
 */

const MASTER_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export { MASTER_TENANT_ID };

export function operatorEmails() {
  const raw = [env('OPERATOR_EMAILS') || '', env('PLATFORM_OPERATOR_EMAILS') || ''].join(',');
  return new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export function isOperatorUser(user) {
  if (!user?.id) return false;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return false;
  if (!user.email_confirmed_at && !user.confirmed_at) return false;
  return operatorEmails().has(email);
}

function bearer(req) {
  const auth = req.headers.get('authorization') || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

export async function resolveTenantContext(req) {
  if (isInternalCall(req)) {
    return { tenantId: null, user: null, internal: true, invalid: false };
  }
  const token = bearer(req);
  if (!token) return { tenantId: null, user: null, invalid: true, status: 401, reason: 'missing_token' };
  const user = await userFromToken(token);
  if (!user?.id) return { tenantId: null, user: null, invalid: true, status: 401, reason: 'invalid_token' };

  if (isOperatorUser(user)) {
    return { tenantId: MASTER_TENANT_ID, user, role: 'owner', operator: true, invalid: false };
  }

  const ctx = await tenantFromRequest(req);
  if (ctx?.tenant?.id) {
    return { tenantId: ctx.tenant.id, user: ctx.user, role: ctx.role, tenant: ctx.tenant, invalid: false };
  }
  return { tenantId: null, user, invalid: true, status: 403, reason: 'no_membership' };
}

/**
 * Guard: verified tenant member (or operator). Internal calls are allowed only
 * when allowInternal is set. Returns { ctx } or { response }.
 */
export async function requireTenant(req, { allowInternal = false } = {}) {
  const ctx = await resolveTenantContext(req);
  if (ctx.internal) {
    return allowInternal ? { ctx } : { response: json(req, { error: 'forbidden' }, 403) };
  }
  if (ctx.invalid) {
    return { response: json(req, { error: ctx.status === 403 ? 'forbidden' : 'unauthorized', reason: ctx.reason }, ctx.status || 401) };
  }
  return { ctx };
}

/** Guard: platform operator JWT (allowlist) or, if allowed, the internal token. */
export async function requireOperator(req, { allowInternal = true } = {}) {
  if (allowInternal && isInternalCall(req)) return { ctx: { internal: true, tenantId: null } };
  const token = bearer(req);
  if (!token) return { response: json(req, { error: 'unauthorized' }, 401) };
  const user = await userFromToken(token);
  if (!user?.id) return { response: json(req, { error: 'unauthorized' }, 401) };
  if (!operatorEmails().size) return { response: json(req, { error: 'operators_not_configured' }, 503) };
  if (!isOperatorUser(user)) return { response: json(req, { error: 'forbidden' }, 403) };
  return { ctx: { tenantId: MASTER_TENANT_ID, user, role: 'owner', operator: true } };
}

/** True if the ctx may act on a row owned by tenantId. */
export function canAccessTenant(ctx, tenantId) {
  if (!ctx) return false;
  if (ctx.internal || ctx.operator) return true;
  return !!tenantId && ctx.tenantId === tenantId;
}

/** withCors guard factories (see _auth.mjs withCors). */
export const tenantGuard = (opts = {}) => async (req) => (await requireTenant(req, opts)).response || null;
export const operatorGuard = (opts = {}) => async (req) => (await requireOperator(req, opts)).response || null;
