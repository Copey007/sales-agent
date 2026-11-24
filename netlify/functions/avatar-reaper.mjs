/**
 * Scheduled stale-session reaper.
 *
 * Closes 'active' avatar sessions that exceeded the hard cap (30 min) or went
 * silent (no heartbeat for 3 min) — an abandoned browser tab otherwise holds a
 * concurrency seat and can keep accruing cost. Also reconciles against the
 * LiveAvatar API's active-session list as a backstop.
 *
 * Scheduled every 5 minutes (see netlify.toml).
 */

import { reapStaleSessions } from './_avatar-store.mjs';

export default async () => {
  try {
    const reaped = await reapStaleSessions({ maxSessionMinutes: 30, heartbeatTimeoutMinutes: 3 });
    if (reaped) console.log(`[avatar-reaper] closed ${reaped} stale session(s)`);
    return new Response(JSON.stringify({ ok: true, reaped }), {
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
