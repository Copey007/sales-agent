/**
 * Avatar session lifecycle — heartbeat + end + LiveAvatar stop.
 *
 * POST /api/avatar-session-end
 *   { session_row, duration_seconds?, event }
 *   event = "heartbeat" -> keep the session alive + record running duration;
 *                          if the per-session max is reached, stop LiveAvatar
 *                          and close the row.
 *   event = "end"       -> stop the LiveAvatar session, then close the local
 *                          row (tab close / sendBeacon / user hang-up).
 *
 * Duration is computed on the server from started_at (the client value is
 * only a lower bound). Heartbeat and end update only active/pending rows.
 * The LiveAvatar session id always comes from the row, never the client.
 * A failed stop leaves the row open so the reaper can retry.
 *
 * Accepts application/json (fetch or sendBeacon).
 */

import { endSession, heartbeat, getSession } from './_avatar-store.mjs';
import { getAvatarCaps, sessionOverMax, serverDurationSeconds } from './_avatar-caps.mjs';
import { stopLiveAvatarSession } from './avatar-reaper.mjs';
import { withCors } from './_auth.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

function isOpen(row) {
  return row && (row.status === 'active' || row.status === 'pending');
}

async function parseBody(req) {
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const body = await parseBody(req);
  const id = body.session_row;
  const event = body.event || 'end';

  if (!id) return json({ error: 'session_row required' }, 400);

  const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  const caps = getAvatarCaps();

  try {
    const row = await getSession(id);
    if (!row) return json({ error: 'session_not_found' }, 404);
    if (!isOpen(row)) {
      return json({
        ok: true,
        event: 'already_ended',
        status: row.status,
        duration_seconds: row.duration_seconds ?? 0,
      });
    }

    const durationSeconds = serverDurationSeconds(row, body.duration_seconds, caps.maxSessionSeconds);
    const over = sessionOverMax({
      startedAt: row.started_at,
      durationSeconds,
      maxSessionSeconds: caps.maxSessionSeconds,
    });
    const liveId = row.liveavatar_session_id || null;

    if (event === 'heartbeat' && !over) {
      await heartbeat({ id, durationSeconds });
      return json({ ok: true, event: 'heartbeat', max_session_seconds: caps.maxSessionSeconds, duration_seconds: durationSeconds });
    }

    const reason = event === 'heartbeat' || over ? 'max_session' : 'end';
    let stopped = false;
    if (liveId) {
      if (!apiKey) return json({ error: 'LIVEAVATAR_API_KEY not set' }, 503);
      try {
        await stopLiveAvatarSession(apiKey, liveId, {
          reason: reason === 'max_session' ? 'MAX_DURATION_REACHED' : 'USER_CLOSED',
        });
        stopped = true;
      } catch (err) {
        console.error('[avatar-session-end] stop failed; leaving row open:', err.message);
        return json({ error: 'stop_failed', message: 'Could not stop the LiveAvatar session. It will be retried.' }, 502);
      }
    }

    const ended = await endSession({
      id,
      durationSeconds,
      status: reason === 'max_session' ? 'reaped' : 'ended',
    });
    return json({
      ok: true,
      event: reason === 'max_session' ? 'stopped' : 'end',
      reason,
      stopped,
      duration_seconds: ended?.duration_seconds ?? durationSeconds,
    });
  } catch (err) {
    console.error('[avatar-session-end]', err.message);
    return json({ error: 'internal_error' }, 500);
  }
};

export const config = { path: '/api/avatar-session-end', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
