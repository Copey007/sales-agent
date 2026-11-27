/**
 * Shared security helpers for every HTTP-exposed function.
 *
 *  - CORS: strict origin allowlist (ALLOWED_ORIGINS, comma-separated). Browser
 *    requests from any other origin get no Access-Control-Allow-Origin header.
 *    `withCors(handler)` wraps a v2 handler: it answers preflights and rewrites
 *    whatever ACAO header the handler set (legacy code used "*") to either the
 *    allowlisted request origin or nothing.
 *  - Internal calls (queue-manager -> send-worker-background, workforce-hires ->
 *    workforce, campaign-admin -> send-worker-background) carry the shared
 *    secret INTERNAL_API_TOKEN in the X-Internal-Token header. Fails closed.
 *  - Admin secrets (ADMIN_SECRET, SETUP_SECRET, QUEUE_MANAGER_SECRET) are
 *    compared in constant time and fail closed when unset.
 *
 * User/tenant/operator identity lives in _tenant.mjs (resolveTenantContext,
 * requireTenant, requireOperator) so there is exactly one resolver.
 */

import { timingSafeEqual } from 'node:crypto';

export function env(key, fallback = '') {
  if (typeof Netlify !== 'undefined' && Netlify.env?.get) {
    const v = Netlify.env.get(key);
    if (v) return v;
  }
  return process.env[key] || fallback;
}

const DEFAULT_ORIGINS = [
  'https://aisdr.a-gent.co',
  'https://missioncontrol.a-gent.co',
  'https://missioncontrol.askarlen.com',
  'https://fleet.a-gent.co',
  'https://a-gent.co',
  'https://www.a-gent.co',
  'https://askarlen.com',
  'https://www.askarlen.com',
  'https://app.askarlen.com',
].join(',');

export function allowedOrigins() {
  return env('ALLOWED_ORIGINS', DEFAULT_ORIGINS)
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}

export function originAllowed(req) {
  const origin = (req.headers.get('origin') || '').replace(/\/$/, '');
  return !!origin && allowedOrigins().includes(origin);
}

/** CORS headers for this request. Only echoes the Origin when allowlisted. */
export function corsHeaders(req, {
  methods = 'GET, POST, PATCH, DELETE, OPTIONS',
  headers = 'Content-Type, Authorization, apikey',
} = {}) {
  const h = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': headers,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  if (originAllowed(req)) h['Access-Control-Allow-Origin'] = (req.headers.get('origin') || '').replace(/\/$/, '');
  return h;
}

export function preflight(req, opts) {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req, opts) });
}

export function json(req, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req), ...extra },
  });
}

/** Replace any ACAO the handler set with the allowlisted origin (or remove it). */
export function applyCors(req, res) {
  if (!(res instanceof Response)) return res;
  const headers = new Headers(res.headers);
  headers.delete('Access-Control-Allow-Origin');
  const cors = corsHeaders(req);
  for (const [k, v] of Object.entries(cors)) {
    if (k === 'Access-Control-Allow-Methods' && headers.has(k)) continue;
    if (k === 'Access-Control-Allow-Headers' && headers.has(k)) continue;
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Wrap a Netlify v2 handler with allowlist CORS + an optional guard.
 * guard(req) returns null to allow or a Response to deny.
 */
export function withCors(handler, { guard = null } = {}) {
  return async (req, context) => {
    const pf = preflight(req);
    if (pf) return pf;
    if (guard) {
      const denied = await guard(req, context);
      if (denied) return applyCors(req, denied);
    }
    const res = await handler(req, context);
    return applyCors(req, res);
  };
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when `provided` matches env[envName]; false (fail closed) when unset. */
export function secretMatches(provided, envName) {
  const secret = env(envName);
  if (!secret) return false;
  return safeEqual(String(provided || ''), secret);
}

/** True when the request carries the correct internal service token. */
export function isInternalCall(req) {
  const secret = env('INTERNAL_API_TOKEN');
  if (!secret) return false;
  return safeEqual(req.headers.get('x-internal-token') || '', secret);
}

/** Headers to attach to server-to-server fetches between our own functions. */
export function internalHeaders() {
  const secret = env('INTERNAL_API_TOKEN');
  return secret ? { 'X-Internal-Token': secret } : {};
}

/** Guard for internal-only endpoints (background workers). */
export function requireInternal(req) {
  if (isInternalCall(req)) return null;
  if (!env('INTERNAL_API_TOKEN')) return json(req, { error: 'internal_token_not_configured' }, 503);
  return json(req, { error: 'forbidden' }, 403);
}

/** Generic 500 body — never leak stack traces or upstream errors to clients. */
export function serverError(req, err, tag = 'api') {
  console.error(`[${tag}]`, err?.message, err?.stack);
  return json(req, { error: 'internal_error' }, 500);
}

/** Site base URL for server-to-server calls (Netlify sets URL). */
export function siteUrl() {
  return env('URL', 'https://aisdr.a-gent.co').replace(/\/$/, '');
}
