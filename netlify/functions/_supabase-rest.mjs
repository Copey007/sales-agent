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
