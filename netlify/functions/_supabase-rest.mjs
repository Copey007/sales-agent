/**
 * Minimal Supabase PostgREST helper for Netlify functions.
 *
 * Server-side functions are trusted code and use the SERVICE ROLE key, which
 * bypasses RLS. There is deliberately NO fallback to SUPABASE_ANON_KEY: once
 * RLS is enabled (supabase/migrations/20261124_a_gent_rls_lockdown.sql) an
 * anon-key fallback would silently return empty results / fail writes. A
 * missing service-role key fails closed with a clear server error instead.
 */

import { env } from './_mcp-connectors.mjs';

export class SupabaseConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'SupabaseConfigError'; this.status = 503; }
}

/** Service-role credentials. Throws SupabaseConfigError if not configured. */
export function serviceCreds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url) throw new SupabaseConfigError('SUPABASE_URL is not configured');
  if (!key) throw new SupabaseConfigError('SUPABASE_SERVICE_ROLE_KEY is not configured (server functions never fall back to the anon key)');
  return { url, key };
}

/** apikey + Authorization headers for a trusted service-role REST/Storage call. */
export function serviceHeaders(extra = {}) {
  const { key } = serviceCreds();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

/** Back-compat alias used by existing callers. */
export function sbCreds() { return serviceCreds(); }

/** fetch() against PostgREST with service-role headers; returns the raw Response. */
export async function serviceRest(path, init = {}) {
  const { url } = serviceCreds();
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: serviceHeaders({ 'Content-Type': 'application/json', ...(init.headers || {}) }),
  });
}

/**
 * sb('contact_pool?status=eq.found&limit=100')                       — GET
 * sb('contact_pool', { method:'POST', body:[...], prefer:'resolution=ignore-duplicates' })
 * sb('contact_pool?id=eq.X', { method:'PATCH', body:{...} })
 * sb('contact_pool?select=count', { count:true })                    — exact count
 */
export async function sb(pathWithQuery, opts = {}) {
  const { url, key } = sbCreds();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  if (opts.count) headers.Prefer = [headers.Prefer, 'count=exact'].filter(Boolean).join(',');
  const res = await fetch(`${url}/rest/v1/${pathWithQuery}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) || String(text).slice(0, 200);
    const err = new Error(`Supabase ${res.status}: ${msg}`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  if (opts.count) {
    const range = res.headers.get('content-range') || '';
    const total = Number(range.split('/')[1]);
    return { data, count: Number.isFinite(total) ? total : null };
  }
  return data;
}

// ─── contact_pool tenancy probe ─────────────────────────────────────────────
// The tenant_id column lands via a manual migration in the Supabase SQL
// editor. Until it exists, tenant scoping on the pool is a no-op (everything
// behaves as one demo-tenant pool, same as before). Probe once per lambda.

let _poolTenantReady = null;
export async function poolTenantReady() {
  if (_poolTenantReady !== null) return _poolTenantReady;
  try {
    await sb('contact_pool?select=tenant_id&limit=1');
    _poolTenantReady = true;
  } catch (e) {
    // 42703 = undefined column (pre-migration). Any other error: leave the
    // probe unset so a transient failure doesn't lock in the wrong answer.
    if (e.code === '42703' || /tenant_id/i.test(e.message || '')) _poolTenantReady = false;
    else return false;
  }
  return _poolTenantReady;
}

/** Query-string fragment scoping a contact_pool query to a tenant ('' pre-migration). */
export async function poolTenantFilter(tenantId) {
  if (!tenantId) return '';
  return (await poolTenantReady()) ? `&tenant_id=eq.${tenantId}` : '';
}
