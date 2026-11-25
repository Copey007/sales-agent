/**
 * Scheduled stale-session reaper.
 *
 * Closes 'active' avatar sessions that exceeded the hard cap (30 min) or went
 * silent (no heartbeat for 3 min) — an abandoned browser tab otherwise holds a
 * concurrency seat and can keep accruing cost. Stops each session on the
 * LiveAvatar API first (POST /v1/sessions/stop), then closes the local row.
 *
 * Scheduled every 5 minutes (see netlify.toml).
 */

import { listStaleSessions, endSession } from './_avatar-store.mjs';

const API_URL = 'https://api.liveavatar.com';

/** Stop one LiveAvatar session. Uses the same endpoint and { session_id } body as avatar-session.mjs. */
export async function stopLiveAvatarSession(apiKey, sessionId) {
  const res = await fetch(`${API_URL}/v1/sessions/stop`, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LiveAvatar stop failed: ${res.status} ${err}`);
  }
  return true;
}

export async function reap() {
  const stale = await listStaleSessions({ maxSessionMinutes: 30, heartbeatTimeoutMinutes: 3 });
  const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  let reaped = 0;
  let stopped = 0;
  for (const s of stale) {
    if (s.liveavatar_session_id) {
      if (!apiKey) {
        console.error('[avatar-reaper] LIVEAVATAR_API_KEY not set; cannot stop LiveAvatar session', s.liveavatar_session_id);
      } else {
        try {
          await stopLiveAvatarSession(apiKey, s.liveavatar_session_id);
          stopped++;
        } catch (err) {
          console.error('[avatar-reaper] LiveAvatar stop failed for', s.liveavatar_session_id, err.message);
        }
      }
    }
    const elapsed = (Date.now() - new Date(s.started_at).getTime()) / 1000;
    const dur = Math.max(s.duration_seconds || 0, 0) || elapsed;
    const ok = await endSession({ id: s.id, durationSeconds: dur, status: 'reaped' });
    if (ok) reaped++;
  }
  return { reaped, stopped, stale: stale.length };
}

export default async () => {
  try {
    const result = await reap();
    if (result.reaped || result.stopped) {
      console.log(`[avatar-reaper] closed ${result.reaped} stale session(s), stopped ${result.stopped} LiveAvatar session(s)`);
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

export const config = { schedule: '*/5 * * * *' };
