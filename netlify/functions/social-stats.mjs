/**
 * Social (Buffer) status for the Mission Control "A-Gent Social Media" tile.
 *
 * GET /api/social-stats  (Authorization: Bearer <jwt>)
 *   → { connected:false }                              when no Buffer token is set
 *   → { connected:true, profiles:[{id,service,username,avatar,pending,sent}],
 *       queue:[{id,profile,text,scheduled_at,status}] } when connected
 *
 * Uses Buffer's API with a BUFFER_ACCESS_TOKEN (env, or per-tenant secret later).
 * Read-only: lists connected social profiles and the pending publish queue so the
 * dashboard can show what's scheduled. Posting is handled by social-post.mjs.
 */

import { userFromToken } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const BUFFER_API = 'https://api.bufferapp.com/1';
const bufferToken = () =>
  (typeof Netlify !== 'undefined' && Netlify.env?.get('BUFFER_ACCESS_TOKEN')) || process.env.BUFFER_ACCESS_TOKEN || '';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const user = await userFromToken(token);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);

  const TOKEN = bufferToken();
  if (!TOKEN) return json({ connected: false, reason: 'Buffer not connected. Add BUFFER_ACCESS_TOKEN to enable.' });

  try {
    const pRes = await fetch(`${BUFFER_API}/profiles.json?access_token=${encodeURIComponent(TOKEN)}`);
    if (pRes.status === 401 || pRes.status === 403) return json({ connected: false, reason: 'Buffer token rejected — reconnect.' });
    if (!pRes.ok) return json({ connected: false, reason: `Buffer error ${pRes.status}` });
    const profilesRaw = await pRes.json();

    const profiles = [];
    const queue = [];
    for (const p of (Array.isArray(profilesRaw) ? profilesRaw : [])) {
      const counts = p.counts || {};
      profiles.push({
        id: p.id,
        service: p.service || p.service_type || 'social',
        username: p.formatted_username || p.service_username || p.service || '—',
        avatar: p.avatar_https || p.avatar || null,
        pending: counts.pending ?? null,
        sent: counts.sent ?? null,
      });
      // Pull a few pending items per profile for the queue preview.
      try {
        const qRes = await fetch(`${BUFFER_API}/profiles/${encodeURIComponent(p.id)}/updates/pending.json?access_token=${encodeURIComponent(TOKEN)}&count=5`);
        if (qRes.ok) {
          const q = await qRes.json();
          for (const u of (q?.updates || [])) {
            queue.push({
              id: u.id,
              profile: p.formatted_username || p.service || p.id,
              service: p.service || 'social',
              text: u.text || u.text_formatted || '',
              scheduled_at: u.scheduled_at ? new Date(u.scheduled_at * 1000).toISOString() : (u.due_at ? new Date(u.due_at * 1000).toISOString() : null),
              status: u.status || 'pending',
            });
          }
        }
      } catch { /* queue preview is best-effort */ }
    }

    queue.sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));
    return json({ connected: true, profiles, queue: queue.slice(0, 12) });
  } catch (err) {
    console.error('[social-stats]', err.message);
    return json({ connected: false, reason: 'Buffer request failed.' }, 200);
  }
};

export const config = { path: '/api/social-stats' };
