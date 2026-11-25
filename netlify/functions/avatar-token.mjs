/**
 * LiveAvatar session token — tenant-aware + commercially guard-railed.
 *
 * For @heygen/liveavatar-web-sdk: the browser needs only a short-lived SESSION
 * TOKEN; the SDK handles start/LiveKit/attach/repeat/stop. The API key stays
 * server-side.
 *
 * POST /api/avatar-token  { slug }
 *   → { session_token, session_id, session_row, mode, max_session_seconds }
 *
 * POST-only: GET (and any non-POST method other than an OPTIONS preflight)
 * returns 405 with Allow: POST and never calls HeyGen / LiveAvatar.
 *
 * Guardrails:
 *   - reserve a pending seat before minting so concurrent requests cannot
 *     race past max_concurrent
 *   - platform + per-agent monthly minute cap (usage billing ceiling)
 *   - caps fail closed: a usage-store error returns 503 and does not mint
 *   - per-IP rate limit, using only the Netlify connection IP
 *   - token request includes max_session_duration so LiveAvatar enforces the cap
 *   - if the row write fails after mint, stop the session and return 503
 *   - only public slugs (a-gent, demo) may mint anonymously; any other
 *     slug requires an authenticated member of that agent's tenant
 *
 * Env: LIVEAVATAR_API_KEY (shared platform key; per-tenant keys come later)
 */

import {
  getAgentBySlug,
  monthlyUsageSeconds,
  recentSessionCountByIp,
  createSession,
  attachLiveAvatarSession,
  cancelReservation,
  listSeatHolders,
} from './_avatar-store.mjs';
import { getAvatarCaps } from './_avatar-caps.mjs';
import { stopLiveAvatarSession } from './avatar-reaper.mjs';
import { withCors } from './_auth.mjs';
import { isPublicAvatarSlug, requireAvatarLogin } from './_avatar-access.mjs';
import { canAccessTenant } from './_tenant.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

const API_URL = 'https://api.liveavatar.com';
const IP_RATE_WINDOW_SECONDS = 60;
const IP_RATE_MAX = 5; // ≤5 new sessions per IP per minute
const DEFAULT_MAX_CONCURRENT = 3;

function clientIp(req) {
  // x-forwarded-for is spoofable on this unauthenticated path. Use only the
  // connection IP Netlify sets itself.
  const raw = req.headers.get('x-nf-client-connection-ip') || '';
  return raw.split(',')[0].trim() || null;
}

async function cleanup(apiKey, reserved, mintedSessionId, reason = 'ZOMBIE_SESSION_REAP') {
  if (mintedSessionId && apiKey) {
    try {
      await stopLiveAvatarSession(apiKey, mintedSessionId, { reason });
    } catch (err) {
      console.error('[avatar-token] minted session cleanup stop failed:', err.message);
    }
  }
  if (reserved?.id) {
    try { await cancelReservation(reserved.id); } catch { /* best effort */ }
  }
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors, Allow: 'POST' },
    });
  }

  const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  if (!apiKey) return json({ error: 'LIVEAVATAR_API_KEY not set' }, 500);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const slug = body.slug || 'demo';
  const ip = clientIp(req);

  // Private slugs require a login before we even look the agent up, so an
  // anonymous caller cannot probe tenant names or trigger a mint.
  let memberCtx = null;
  if (!isPublicAvatarSlug(slug)) {
    const login = await requireAvatarLogin(req);
    if (!login.ok) return json({ error: login.error, reason: login.reason }, login.status);
    memberCtx = login.ctx;
  }

  let agent;
  try {
    agent = await getAgentBySlug(slug);
  } catch (err) {
    return json({ error: `lookup_failed: ${err.message}` }, 500);
  }
  if (!agent) return json({ error: 'agent_not_found', slug }, 404);
  if (memberCtx && !canAccessTenant(memberCtx, agent.tenant_id || null)) {
    return json({ error: 'agent_not_found' }, 404);
  }
  if (agent.status !== 'active') return json({ error: 'agent_unavailable', status: agent.status }, 403);

  const caps = getAvatarCaps(agent);
  const maxConcurrent = Number.isFinite(Number(agent.max_concurrent)) && Number(agent.max_concurrent) > 0
    ? Math.floor(Number(agent.max_concurrent))
    : DEFAULT_MAX_CONCURRENT;

  let reserved = null;
  let mintedSessionId = null;

  try {
    if (await recentSessionCountByIp(ip, IP_RATE_WINDOW_SECONDS) >= IP_RATE_MAX) {
      return json({ error: 'rate_limited', retry_after: IP_RATE_WINDOW_SECONDS }, 429);
    }
    const usedMin = (await monthlyUsageSeconds(slug)) / 60;
    if (usedMin >= caps.monthlyMinuteCap) {
      return json({ error: 'quota_exceeded', message: 'This agent has reached its monthly limit.' }, 402);
    }

    // Reserve a seat before minting so concurrent requests cannot all
    // pass a check-then-insert race and start more than max_concurrent sessions.
    reserved = await createSession({ slug, tenantId: agent.tenant_id || null, ip, status: 'pending' });
    if (!reserved?.id) {
      return json({ error: 'usage_store_unavailable' }, 503);
    }
    const seats = await listSeatHolders(slug);
    const rank = seats.findIndex((s) => s.id === reserved.id);
    if (rank === -1 || rank >= maxConcurrent) {
      await cancelReservation(reserved.id);
      reserved = null;
      return json({ error: 'at_capacity', message: 'All live slots are busy. Please try again shortly.', max_concurrent: maxConcurrent }, 503);
    }
  } catch (err) {
    console.error('[avatar-token] guardrail or reservation failed:', err.message);
    if (reserved?.id) {
      try { await cancelReservation(reserved.id); } catch { /* best effort */ }
    }
    return json({ error: 'usage_store_unavailable' }, 503);
  }

  // FULL mode requires an avatar_persona (voice). We drive our own concierge
  // brain via repeat(text), so we set the voice but omit LiveAvatar's context_id.
  // LITE mode needs only the avatar_id (caller supplies audio via repeatAudio).
  const mode = (agent.mode || 'FULL').toUpperCase();
  const tokenBody = {
    mode,
    avatar_id: agent.avatar_id,
    is_sandbox: false,
    max_session_duration: caps.maxSessionSeconds,
  };
  if (mode === 'FULL') {
    if (!agent.voice_id) return json({ error: 'agent_misconfigured', detail: 'FULL mode requires voice_id' }, 500);
    tokenBody.avatar_persona = { voice_id: agent.voice_id, language: 'en' };
  } else {
    tokenBody.video_settings = { quality: 'high', encoding: 'H264' };
  }

  try {
    const res = await fetch(`${API_URL}/v1/sessions/token`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenBody),
    });
    if (!res.ok) {
      const err = await res.text();
      await cleanup(apiKey, reserved, null);
      reserved = null;
      return json({ error: `token_creation_failed: ${res.status} ${err}` }, 502);
    }
    const data = await res.json();
    const sessionToken = data.data.session_token;
    mintedSessionId = data.data.session_id;

    let row;
    try {
      row = await attachLiveAvatarSession(reserved.id, mintedSessionId);
    } catch (err) {
      console.error('[avatar-token] attach failed after mint:', err.message);
      await cleanup(apiKey, reserved, mintedSessionId);
      reserved = null;
      mintedSessionId = null;
      return json({ error: 'usage_store_unavailable' }, 503);
    }
    if (!row?.id) {
      await cleanup(apiKey, reserved, mintedSessionId);
      reserved = null;
      mintedSessionId = null;
      return json({ error: 'usage_store_unavailable' }, 503);
    }

    return json({
      session_token: sessionToken,
      session_id: mintedSessionId,
      session_row: row.id,
      mode: agent.mode || 'FULL',
      max_session_seconds: caps.maxSessionSeconds,
    });
  } catch (err) {
    console.error('[avatar-token]', err.message);
    await cleanup(apiKey, reserved, mintedSessionId);
    if (mintedSessionId) return json({ error: 'usage_store_unavailable' }, 503);
    return json({ error: 'internal_error' }, 500);
  }
};

export const config = { path: '/api/avatar-token', rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
