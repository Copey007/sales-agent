/**
 * Avatar session lifecycle — heartbeat + end.
 *
 * POST /api/avatar-session-end
 *   { session_row, duration_seconds, event }
 *   event = "heartbeat" -> keep the session alive + record running duration
 *   event = "end"       -> close the session, finalize billable duration
 *
 * Heartbeats free the concurrency seat reliably and let the reaper tell a live
 * tab from an abandoned one. Duration_seconds is the billable meter.
 */

import { endSession, heartbeat } from './_avatar-store.mjs';
import { withCors } from './_auth.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const id = body.session_row;
  const duration = Number(body.duration_seconds) || 0;
  const event = body.event || 'end';

  if (!id) return json({ error: 'session_row required' }, 400);

  try {
    if (event === 'heartbeat') {
      await heartbeat({ id, durationSeconds: duration });
      return json({ ok: true, event: 'heartbeat' });
    }
    const row = await endSession({ id, durationSeconds: duration, status: 'ended' });
    return json({ ok: true, event: 'end', duration_seconds: row?.duration_seconds ?? duration });
  } catch (err) {
    console.error('[avatar-session-end]', err.message);
    return json({ error: 'internal_error' }, 500);
  }
};

export const config = { path: '/api/avatar-session-end', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
