/**
 * Per-lead Hunter.io email finder (fail-closed).
 *
 *   POST /api/hunter-find-email
 *     { domain, first_name, last_name }  or  { domain, full_name }
 *
 * Auth: valid Supabase JWT + tenant membership (tenantGuard).
 *   missing/invalid token → 401
 *   authenticated non-member → 403
 *
 * Config: HUNTER_API_KEY must be present in server env. A missing key returns
 * 503 `hunter_not_configured`. Client-supplied api_key / token fields are
 * ignored. The key and raw Hunter response bodies are never returned or logged.
 *
 * Success (200): { email, score, status, domain, first_name, last_name,
 *   position, sources_count }. `email` is null and `status` is `not_found`
 *   when Hunter has no match.
 */

import { env, json, serverError, withCors } from './_auth.mjs';
import { tenantGuard } from './_tenant.mjs';

const HUNTER_FINDER = 'https://api.hunter.io/v2/email-finder';
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function splitFullName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: '', last_name: '' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

export function normalizeDomain(raw) {
  let d = String(raw || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.replace(/:\d+$/, '').replace(/\.$/, '');
  return d;
}

export function parseFindEmailInput(body) {
  const domain = normalizeDomain(body?.domain);
  if (!domain || !DOMAIN_RE.test(domain) || domain.includes('..')) {
    return { error: 'invalid_input', message: 'domain is required' };
  }

  let first = String(body?.first_name ?? body?.firstName ?? '').trim();
  let last = String(body?.last_name ?? body?.lastName ?? '').trim();
  const full = String(body?.full_name ?? body?.fullName ?? '').trim();
  if ((!first || !last) && full) {
    const split = splitFullName(full);
    if (!first) first = split.first_name;
    if (!last) last = split.last_name;
  }
  if (!first || !last) {
    return { error: 'invalid_input', message: 'first_name and last_name, or full_name, are required' };
  }
  return { domain, first_name: first, last_name: last };
}

function hunterApiKey() {
  return String(env('HUNTER_API_KEY') || '').trim();
}

function normalizeResult(parsed, payload) {
  const d = payload && typeof payload === 'object' ? (payload.data || {}) : {};
  const email = d.email ? String(d.email) : null;
  const score = Number.isFinite(Number(d.score)) ? Number(d.score) : null;
  const verification = d.verification && typeof d.verification === 'object' ? d.verification.status : null;
  const status = verification || (email ? 'unknown' : 'not_found');
  const sources = Array.isArray(d.sources) ? d.sources : [];
  return {
    email,
    score,
    status,
    domain: d.domain || parsed.domain,
    first_name: d.first_name || parsed.first_name,
    last_name: d.last_name || parsed.last_name,
    position: d.position || null,
    sources_count: sources.length,
  };
}

const __handler = async (req) => {
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);

  const apiKey = hunterApiKey();
  if (!apiKey) return json(req, { error: 'hunter_not_configured' }, 503);

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json(req, { error: 'invalid_input', message: 'JSON body required' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(req, { error: 'invalid_input', message: 'JSON object required' }, 400);
  }

  const parsed = parseFindEmailInput(body);
  if (parsed.error) return json(req, { error: parsed.error, message: parsed.message }, 400);

  const url = new URL(HUNTER_FINDER);
  url.searchParams.set('domain', parsed.domain);
  url.searchParams.set('first_name', parsed.first_name);
  url.searchParams.set('last_name', parsed.last_name);

  try {
    const res = await fetch(url.href, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });

    if (res.status === 404) {
      await res.text().catch(() => '');
      return json(req, normalizeResult(parsed, null), 200);
    }
    if (!res.ok) {
      await res.text().catch(() => '');
      console.error('[hunter-find-email] upstream status', res.status);
      return json(req, { error: 'hunter_upstream_error' }, 502);
    }

    const payload = await res.json().catch(() => null);
    if (!payload || typeof payload !== 'object') {
      console.error('[hunter-find-email] upstream invalid json');
      return json(req, { error: 'hunter_upstream_error' }, 502);
    }
    return json(req, normalizeResult(parsed, payload), 200);
  } catch (err) {
    const safe = new Error('hunter_request_failed');
    safe.stack = err?.stack;
    return serverError(req, safe, 'hunter-find-email');
  }
};

export const config = {
  path: '/api/hunter-find-email',
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

export default withCors(__handler, { guard: tenantGuard() });
