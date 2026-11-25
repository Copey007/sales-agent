/**
 * Avatar session lifecycle — heartbeat + end + LiveAvatar stop.
 *
 * POST /api/avatar-session-end
 *   { session_row, duration_seconds, event, session_id? }
 *   event = "heartbeat" -> keep the session alive + record running duration;
 *                          if the per-session max is reached, stop LiveAvatar
 *                          and close the row.
 *   event = "end"       -> stop the LiveAvatar session, then close the local
 *                          row (tab close / sendBeacon / user hang-up).
 *
 * Accepts application/json (fetch or sendBeacon).
 */

import { endSession, heartbeat, getSession } from './_avatar-store.mjs';
import { getAvatarCaps, sessionOverMax } from './_avatar-caps.mjs';
import { stopLiveAvatarSession } from './avatar-reaper.mjs';
import { withCors } from './_auth.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

async function parseBody(req) {
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function stopIfKnown(apiKey, sessionId, reason) {
  if (!apiKey || !sessionId) return false;
  try {
    await stopLiveAvatarSession(apiKey, sessionId);
    return true;
  } catch (err) {
    console.error(`[avatar-session-end] LiveAvatar stop failed (${reason}):`, err.message);
    return false;
  }
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const body = await parseBody(req);
  const id = body.session_row;
  const duration = Number(body.duration_seconds) || 0;
  const event = body.event || 'end';
  const clientSessionId = body.session_id || body.liveavatar_session_id || null;

  if (!id) return json({ error: 'session_row required' }, 400);

  const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  const caps = getAvatarCaps();

  try {
    const row = await getSession(id);
    const liveId = clientSessionId || row?.liveavatar_session_id || null;
    const startedAt = row?.started_at;
    const over = sessionOverMax({
      startedAt,
      durationSeconds: duration || row?.duration_seconds,
      maxSessionSeconds: caps.maxSessionSeconds,
    });

    if (event === 'heartbeat' && !over) {
      await heartbeat({ id, durationSeconds: duration });
      return json({ ok: true, event: 'heartbeat', max_session_seconds: caps.maxSessionSeconds });
    }

    const reason = event === 'heartbeat' || over ? 'max_session' : 'end';
    const stopped = await stopIfKnown(apiKey, liveId, reason);
    const ended = await endSession({
      id,
      durationSeconds: duration || row?.duration_seconds || 0,
      status: reason === 'max_session' ? 'reaped' : 'ended',
    });
    return json({
      ok: true,
      event: reason === 'max_session' ? 'stopped' : 'end',
      reason,
      stopped,
      duration_seconds: ended?.duration_seconds ?? duration,
    });
  } catch (err) {
    console.error('[avatar-session-end]', err.message);
    return json({ error: 'internal_error' }, 500);
  }
};

export const config = { path: '/api/avatar-session-end', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
