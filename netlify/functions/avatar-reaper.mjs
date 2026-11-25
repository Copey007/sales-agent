/**
 * Scheduled stale-session reaper.
 *
 * Closes active/pending avatar sessions that exceeded the per-session max
 * (default 3 min, AVATAR_MAX_SESSION_SECONDS) or went silent (no heartbeat
 * for AVATAR_HEARTBEAT_TIMEOUT_SECONDS, default 60s). Stops each session on
 * the LiveAvatar API first (POST /v1/sessions/stop). The local row is closed
 * only after the stop succeeds or the session is already gone (404). A failed
 * stop leaves the row open so the next tick can retry.
 *
 * Schedule lives in netlify.toml only (functions."avatar-reaper").
 *
 * Session IDs come from avatar_sessions.liveavatar_session_id, written when
 * /api/avatar-token attaches a reserved row. Pending reservations with no
 * remote session are cancelled locally without a stop call.
 */

import { listStaleSessions, endSession } from './_avatar-store.mjs';
import { getAvatarCaps, serverDurationSeconds } from './_avatar-caps.mjs';

const API_URL = 'https://api.liveavatar.com';

function alreadyStopped(status, text) {
  if (status === 404) return true;
  const body = String(text || '').toLowerCase();
  return /not found|already.?stop|session.?not.?exist|no such session|does not exist/.test(body);
}

/**
 * Stop one LiveAvatar session. 2xx and "already gone" (404 / already-stopped)
 * count as success. Any other failure throws so the caller can leave the
 * local row open and retry.
 */
export async function stopLiveAvatarSession(apiKey, sessionId, { reason } = {}) {
  if (!apiKey || !sessionId) return false;
  const body = { session_id: sessionId };
  if (reason) body.reason = reason;
  const res = await fetch(`${API_URL}/v1/sessions/stop`, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify(body),
  });
  if (res.ok) return true;
  const text = await res.text().catch(() => '');
  if (alreadyStopped(res.status, text)) return true;
  throw new Error(`LiveAvatar stop failed: ${res.status} ${text}`.trim());
}

function stopReasonFor(session, maxSessionSeconds) {
  const startedAt = session.started_at;
  if (startedAt) {
    const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
    if (Number.isFinite(elapsed) && elapsed >= maxSessionSeconds) return 'MAX_DURATION_REACHED';
  }
  return 'IDLE_TIMEOUT';
}

export async function reap() {
  const caps = getAvatarCaps();
  const stale = await listStaleSessions({
    maxSessionSeconds: caps.maxSessionSeconds,
    heartbeatTimeoutSeconds: caps.heartbeatTimeoutSeconds,
  });
  const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  let reaped = 0;
  let stopped = 0;
  let skipped = 0;
  for (const s of stale) {
    const durationSeconds = serverDurationSeconds(s, s.duration_seconds, caps.maxSessionSeconds);
    const reason = stopReasonFor(s, caps.maxSessionSeconds);

    if (s.liveavatar_session_id) {
      if (!apiKey) {
        console.error('[avatar-reaper] LIVEAVATAR_API_KEY not set; leaving session', s.id, 'retryable');
        skipped++;
        continue;
      }
      try {
        await stopLiveAvatarSession(apiKey, s.liveavatar_session_id, { reason });
        stopped++;
      } catch (err) {
        console.error('[avatar-reaper] stop failed; leaving session', s.id, 'retryable:', err.message);
        skipped++;
        continue;
      }
    }

    const ok = await endSession({ id: s.id, durationSeconds, status: 'reaped' });
    if (ok) reaped++;
    else skipped++;
  }
  return { reaped, stopped, skipped, stale: stale.length };
}

export default async () => {
  try {
    const result = await reap();
    if (result.reaped || result.stopped || result.skipped) {
      console.log(`[avatar-reaper] closed ${result.reaped} local row(s), stopped ${result.stopped} LiveAvatar session(s), skipped ${result.skipped}`);
    }
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[avatar-reaper]', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
