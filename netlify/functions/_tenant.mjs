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

  let q = `memberships?user_id=eq.${user.id}&select=role,tenant_id,tenants(id,slug,name,plan,status,stripe_customer_id)`;
  const res = await rest(q);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;

  const row = tenantSlug ? rows.find((r) => r.tenants?.slug === tenantSlug) : rows[0];
  if (!row) return null;
  return { user, role: row.role, tenant: row.tenants };
}

/** Optional workspace disambiguator: ?tenant= / ?tenant_slug= or X-Tenant-Slug. */
export function readTenantSlug(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    const q = (u.searchParams.get('tenant') || u.searchParams.get('tenant_slug') || '').trim().toLowerCase();
    if (q) return q;
  } catch { /* ignore */ }
  return String(req.headers?.get('x-tenant-slug') || '').trim().toLowerCase() || null;
}

/**
 * All of the caller's tenant memberships (stable, no implicit rows[0] pick).
 * Returns null if unauthenticated; { user, memberships: [] } if authenticated
 * with no memberships.
 */
export async function membershipsFromRequest(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const user = await userFromToken(token);
  if (!user?.id) return null;

  const q = `memberships?user_id=eq.${user.id}&select=role,tenant_id,tenants(id,slug,name,plan,status,stripe_customer_id)&order=created_at.asc`;
  const res = await rest(q);
  if (!res.ok) return null;
  const rows = await res.json();
  const memberships = (Array.isArray(rows) ? rows : [])
    .filter((r) => r.tenants?.id)
    .map((r) => ({ role: r.role, tenant: r.tenants }));
  return { user, memberships };
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

  // Mission Control per-account workspaces pass ?tenant_id=<uuid> (or
  // X-Tenant-Id). When present the request is SCOPED: an operator may act for
  // any existing tenant; anyone else must hold a membership in exactly that
  // tenant (403 otherwise). Absent → legacy behaviour below, unchanged.
  const requested = readRequestedTenantId(req);
  if (requested.invalid) return { tenantId: null, user, invalid: true, status: 400, reason: 'invalid_tenant_id' };
  if (requested.id) return scopedContext(user, requested.id);

  if (isOperatorUser(user)) {
    return { tenantId: MASTER_TENANT_ID, user, role: 'owner', operator: true, invalid: false };
  }

  const ctx = await tenantFromRequest(req);
  if (ctx?.tenant?.id) {
    return { tenantId: ctx.tenant.id, user: ctx.user, role: ctx.role, tenant: ctx.tenant, invalid: false };
  }
  return { tenantId: null, user, invalid: true, status: 403, reason: 'no_membership' };
}

// ─── Requested-tenant scoping (Mission Control per-account workspaces) ──────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The operator's own account. Its Supabase rows (memberships, hires, avatar
 * agents) live under the real `a-gent` tenant, while the operator's campaign
 * engine data (Blobs campaigns, GTM Brain, the pre-tenancy contact pool) has
 * always lived under MASTER_TENANT_ID. Scoping an operator to either id
 * resolves to the same single account, so "Mark's campaigns" stay one account.
 */
export function homeTenantId() {
  const v = String(env('OPERATOR_HOME_TENANT_ID') || '').trim().toLowerCase();
  return UUID_RE.test(v) ? v : '1169f77c-a42e-4825-8bb3-f6a698cf3b45';
}
export function isHomeTenant(id) {
  const v = String(id || '').toLowerCase();
  return v === MASTER_TENANT_ID || v === homeTenantId();
}

/**
 * Read the requested tenant: ?tenant_id= (preferred; no CORS preflight
 * change) or the X-Tenant-Id header. Returns { id: null } when absent,
 * { id } for a well-formed uuid, { invalid: true } for anything else.
 */
export function readRequestedTenantId(req) {
  let raw = '';
  try { raw = new URL(req.url, 'http://localhost').searchParams.get('tenant_id') || ''; } catch { /* ignore */ }
  if (!raw) raw = req.headers?.get?.('x-tenant-id') || '';
  raw = String(raw).trim().toLowerCase();
  if (!raw) return { id: null };
  return UUID_RE.test(raw) ? { id: raw } : { invalid: true };
}

async function membershipFor(userId, tenantId) {
  const res = await rest(`memberships?user_id=eq.${encodeURIComponent(userId)}&tenant_id=eq.${tenantId}&select=role,tenant_id,tenants(id,slug,name,plan,status,stripe_customer_id)&limit=5`);
  if (!res.ok) return null;
  const rows = await res.json();
  // Filter again client-side: never trust that the filter was applied.
  return (Array.isArray(rows) ? rows : []).find((r) => (r.tenant_id || r.tenants?.id) === tenantId && r.tenants?.id === tenantId) || null;
}

async function scopedContext(user, tenantId) {
  if (isOperatorUser(user)) {
    if (isHomeTenant(tenantId)) {
      const home = await getTenant(homeTenantId()).catch(() => null);
      // Campaign-engine data for the operator's own account lives under MASTER.
      return { tenantId: MASTER_TENANT_ID, user, role: 'owner', operator: true, scoped: true, home: true,
        tenant: home || { id: homeTenantId(), slug: 'a-gent', name: 'A-Gent' }, invalid: false };
    }
    const t = await getTenant(tenantId).catch(() => null);
    if (!t?.id || t.id !== tenantId) return { tenantId: null, user, invalid: true, status: 404, reason: 'tenant_not_found' };
    return { tenantId: t.id, user, role: 'owner', operator: true, scoped: true, home: false, tenant: t, invalid: false };
  }
  const m = await membershipFor(user.id, tenantId);
  if (!m) return { tenantId: null, user, invalid: true, status: 403, reason: 'not_a_member' };
  return { tenantId: m.tenants.id, user, role: m.role, tenant: m.tenants, scoped: true, home: false, invalid: false };
}

/**
 * For endpoints keyed on real Supabase tenant rows (workforce_hires,
 * worker_outreach, …). Returns { ctx: { user, role, tenant, operator } } or
 * { response }. Without a requested tenant it falls back to the legacy
 * membership lookup (tenantFromRequest) so existing callers are unchanged.
 */
export async function scopedTenantFromRequest(req, respond) {
  const requested = readRequestedTenantId(req);
  if (!requested.id && !requested.invalid) {
    const legacy = await tenantFromRequest(req);
    return legacy?.tenant?.id ? { ctx: legacy } : { response: respond({ error: 'unauthorized' }, 401) };
  }
  const c = await resolveTenantContext(req);
  if (c.internal) return { response: respond({ error: 'forbidden' }, 403) };
  if (c.invalid) return { response: respond({ error: errorName(c.status), reason: c.reason }, c.status || 401) };
  const tenant = c.tenant || { id: c.tenantId };
  return { ctx: { user: c.user, role: c.role, tenant, operator: !!c.operator, scoped: true, home: !!c.home } };
}

/**
 * For a SCOPED ctx, true only when the row belongs to the scoped tenant
 * (operator home account: either the a-gent row or MASTER). Unscoped ctx → true
 * (callers still apply canAccessTenant).
 */
export function scopedTenantMatches(ctx, rowTenantId) {
  if (!ctx?.scoped) return true;
  if (!rowTenantId) return false;
  if (ctx.home) return isHomeTenant(rowTenantId);
  return rowTenantId === (ctx.tenant?.id || ctx.tenantId);
}

function errorName(status) {
  return status === 403 ? 'forbidden' : status === 400 ? 'bad_request' : status === 404 ? 'not_found' : 'unauthorized';
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
    return { response: json(req, { error: errorName(ctx.status), reason: ctx.reason }, ctx.status || 401) };
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
