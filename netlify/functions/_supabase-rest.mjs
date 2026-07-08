/**
 * Minimal Supabase PostgREST helper for Netlify functions.
 * Uses SUPABASE_SERVICE_ROLE_KEY when present, else the anon key.
 */

import { env } from './_mcp-connectors.mjs';

export function sbCreds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / key not configured');
  return { url, key };
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
