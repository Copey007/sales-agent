/**
 * Shared auth + CORS helpers for every HTTP-exposed function.
 *
 * - CORS: strict origin allowlist (ALLOWED_ORIGINS, comma-separated).
 *   Requests from other browser origins get no Access-Control-Allow-Origin.
 * - Auth: Supabase Auth JWT (Authorization: Bearer <access_token>) verified
 *   server-side against GET {SUPABASE_URL}/auth/v1/user, then checked
 *   against an operator allowlist (OPERATOR_EMAILS, comma-separated).
 * - Internal calls (queue-manager -> send-worker, etc.) use a shared secret
 *   in the X-Internal-Token header (INTERNAL_API_TOKEN). Fails closed when
 *   the secret is not configured.
 *
 * Required env vars (Netlify → Site configuration → Environment variables):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, OPERATOR_EMAILS, ALLOWED_ORIGINS,
 *   INTERNAL_API_TOKEN
 */

import { timingSafeEqual } from 'node:crypto';

function env(key, fallback = '') {
  if (typeof Netlify !== 'undefined' && Netlify.env?.get) {
    return Netlify.env.get(key) || fallback;
  }
  return process.env[key] || fallback;
}

const DEFAULT_ORIGINS = 'https://missioncontrol.a-gent.co,https://aisdr.a-gent.co,https://fleet.a-gent.co,https://a-gent.co';

function allowedOrigins() {
  return env('ALLOWED_ORIGINS', DEFAULT_ORIGINS)
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
}

/** CORS headers for this request. Only echoes the Origin when allowlisted. */
export function corsHeaders(req, { methods = 'GET, POST, OPTIONS', headers = 'Content-Type, Authorization' } = {}) {
  const origin = (req.headers.get('origin') || '').replace(/\/$/, '');
  const h = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': headers,
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
  if (origin && allowedOrigins().includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

/** Standard preflight response, or null if this is not a preflight. */
export function preflight(req, opts) {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req, opts) });
}

export function json(req, body, status = 200, opts) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req, opts) }
  });
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when the request carries the correct internal service token. */
export function isInternalCall(req) {
  const secret = env('INTERNAL_API_TOKEN');
  if (!secret) return false; // fail closed
  const got = req.headers.get('x-internal-token') || '';
  return !!got && safeEqual(got, secret);
}

/** Headers to attach to server-to-server fetches between our own functions. */
export function internalHeaders() {
  const secret = env('INTERNAL_API_TOKEN');
  return secret ? { 'X-Internal-Token': secret } : {};
}

/**
 * Verify a Supabase Auth access token and the operator allowlist.
 * Returns { ok: true, user } or { ok: false, status, error }.
 */
export async function verifyUser(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'unauthorized' };

  const url = env('SUPABASE_URL');
  const anon = env('SUPABASE_ANON_KEY');
  if (!url || !anon) return { ok: false, status: 503, error: 'auth_not_configured' };

  let user = null;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return { ok: false, status: 401, error: 'unauthorized' };
    user = await res.json();
  } catch {
    return { ok: false, status: 503, error: 'auth_unavailable' };
  }
  if (!user?.id) return { ok: false, status: 401, error: 'unauthorized' };

  const operators = env('OPERATOR_EMAILS')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!operators.length) return { ok: false, status: 503, error: 'operators_not_configured' };
  if (!operators.includes(String(user.email || '').toLowerCase())) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: true, user };
}

/**
 * Gate for operator-only endpoints. Accepts either a valid operator JWT or
 * the internal service token. Returns null when allowed, or a Response to
 * return immediately when denied.
 */
export async function requireAuth(req, { allowInternal = true, corsOpts } = {}) {
  if (allowInternal && isInternalCall(req)) return null;
  const result = await verifyUser(req);
  if (result.ok) {
    req.authUser = result.user;
    return null;
  }
  return json(req, { error: result.error }, result.status, corsOpts);
}

/** Gate for internal-only endpoints (send-worker, loop-engine POST). */
export function requireInternal(req, corsOpts) {
  if (isInternalCall(req)) return null;
  return json(req, { error: 'forbidden' }, 403, corsOpts);
}

/** Generic 500 body — never leak stack traces to clients. */
export function serverError(req, err, tag = 'api', corsOpts) {
  console.error(`[${tag}]`, err?.message, err?.stack);
  return json(req, { error: 'internal_error' }, 500, corsOpts);
}

export { env as authEnv };
