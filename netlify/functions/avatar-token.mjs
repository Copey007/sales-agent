/**
 * LiveAvatar session token — tenant-aware + commercially guard-railed.
 *
 * For @heygen/liveavatar-web-sdk: the browser needs only a short-lived SESSION
 * TOKEN; the SDK handles start/LiveKit/attach/repeat/stop. The API key stays
 * server-side.
 *
 * POST /api/avatar-token  { slug }
 *   → { session_token, session_id, session_row, mode }
 *
 * Guardrails (this is what makes it safe to sell):
 *   - per-agent max_concurrent cap            (no oversubscription)
 *   - per-agent monthly_minute_cap            (usage billing ceiling)
 *   - per-IP rate limit                       (bots can't burn paid minutes)
 *   - one session row per start               (concurrency + metering source)
 *   - NO "stop all sessions" (that was a self-DoS at scale)
 *
 * Env: LIVEAVATAR_API_KEY (shared platform key; per-tenant keys come later)
 */

import {
  getAgentBySlug,
  countActiveSessions,
  monthlyUsageSeconds,
  recentSessionCountByIp,
  createSession,
} from './_avatar-store.mjs';

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

function clientIp(req) {
  const xf = req.headers.get('x-forwarded-for') || req.headers.get('x-nf-client-connection-ip') || '';
  return xf.split(',')[0].trim() || null;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  if (!apiKey) return json({ error: 'LIVEAVATAR_API_KEY not set' }, 500);

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const slug = body.slug || 'demo';
  const ip = clientIp(req);

  let agent;
  try {
    agent = await getAgentBySlug(slug);
  } catch (err) {
    return json({ error: `lookup_failed: ${err.message}` }, 500);
  }
  if (!agent) return json({ error: 'agent_not_found', slug }, 404);
  if (agent.status !== 'active') return json({ error: 'agent_unavailable', status: agent.status }, 403);

  // ── Guardrails ────────────────────────────────────────────────────────────
  try {
    if (await recentSessionCountByIp(ip, IP_RATE_WINDOW_SECONDS) >= IP_RATE_MAX) {
      return json({ error: 'rate_limited', retry_after: IP_RATE_WINDOW_SECONDS }, 429);
    }
    const active = await countActiveSessions(slug);
    if (active >= (agent.max_concurrent ?? 3)) {
      return json({ error: 'at_capacity', message: 'All live slots are busy. Please try again shortly.' }, 503);
    }
    if (agent.monthly_minute_cap != null) {
      const usedMin = (await monthlyUsageSeconds(slug)) / 60;
      if (usedMin >= agent.monthly_minute_cap) {
        return json({ error: 'quota_exceeded', message: 'This agent has reached its monthly limit.' }, 402);
      }
    }
  } catch (err) {
    // Guardrail checks must not hard-fail the product if the table is briefly
    // unavailable — log and continue (fail-open on metering, not on auth).
    console.warn('[avatar-token] guardrail check degraded:', err.message);
  }

  // ── Mint the LiveAvatar session token ──────────────────────────────────────
  // FULL mode requires an avatar_persona (voice). We drive our own concierge
  // brain via repeat(text), so we set the voice but omit LiveAvatar's context_id.
  // LITE mode needs only the avatar_id (caller supplies audio via repeatAudio).
  const mode = (agent.mode || 'FULL').toUpperCase();
  const tokenBody = { mode, avatar_id: agent.avatar_id, is_sandbox: false };
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
      return json({ error: `token_creation_failed: ${res.status} ${err}` }, 502);
    }
    const data = await res.json();
    const sessionToken = data.data.session_token;
    const sessionId = data.data.session_id;

    // Log the session (concurrency seat + metering anchor)
    const row = await createSession({
      slug,
      tenantId: agent.tenant_id || null,
      liveavatarSessionId: sessionId,
      ip,
    });

    return json({
      session_token: sessionToken,
      session_id: sessionId,
      session_row: row?.id || null,
      mode: agent.mode || 'FULL',
    });
  } catch (err) {
    console.error('[avatar-token]', err.message);
    return json({ error: err.message }, 500);
  }
};

export const config = { path: '/api/avatar-token' };
