/**
 * Publish/schedule a social post through Buffer.
 *
 * POST /api/social-post  (Authorization: Bearer <jwt>)
 *   { text, profile_ids:[...], scheduled_at?:ISO, now?:bool }
 *   → { ok:true, updates:[...] }   (Buffer adds the update to each profile's queue)
 *
 * Requires BUFFER_ACCESS_TOKEN. Side-effectful (posts on the user's behalf) so it
 * is JWT-guarded. `now:true` posts immediately; otherwise Buffer schedules per the
 * profile's posting schedule (or the explicit scheduled_at).
 */

import { userFromToken, readRequestedTenantId, isHomeTenant } from './_tenant.mjs';
import { withCors } from './_auth.mjs';
import { operatorGuard } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const BUFFER_API = 'https://api.bufferapp.com/1';
const bufferToken = () =>
  (typeof Netlify !== 'undefined' && Netlify.env?.get('BUFFER_ACCESS_TOKEN')) || process.env.BUFFER_ACCESS_TOKEN || '';

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const user = await userFromToken(token);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);
  // Buffer is connected for the operator's own account only. A workspace
  // scoped to any other tenant never sees (or posts to) those channels.
  const scope = readRequestedTenantId(req);
  if (scope.invalid) return json({ error: 'bad_request', reason: 'invalid_tenant_id' }, 400);
  if (scope.id && !isHomeTenant(scope.id)) return json({ error: 'forbidden', reason: 'social_not_connected_for_tenant' }, 403);

  const TOKEN = bufferToken();
  if (!TOKEN) return json({ error: 'Buffer not connected.' }, 503);

  let b = {};
  try { b = await req.json(); } catch {}
  const text = (b.text || '').trim();
  const profileIds = Array.isArray(b.profile_ids) ? b.profile_ids.filter(Boolean) : [];
  if (!text) return json({ error: 'text required' }, 400);
  if (!profileIds.length) return json({ error: 'profile_ids required' }, 400);

  const form = new URLSearchParams();
  form.set('text', text);
  for (const id of profileIds) form.append('profile_ids[]', id);
  if (b.now) form.set('now', 'true');
  else if (b.scheduled_at) form.set('scheduled_at', String(Math.floor(new Date(b.scheduled_at).getTime() / 1000)));
  form.set('access_token', TOKEN);

  try {
    const res = await fetch(`${BUFFER_API}/updates/create.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      return json({ error: data.message || `Buffer error ${res.status}` }, 502);
    }
    return json({ ok: true, updates: data.updates || [], buffer_count: data.buffer_count ?? null });
  } catch (err) {
    console.error('[social-post]', err.message);
    return json({ error: 'Buffer request failed.' }, 502);
  }
};

export const config = { path: '/api/social-post' };

// Security wrapper: allowlisted CORS + operator auth guard (2026-11 lockdown).
export default withCors(__handler, { guard: operatorGuard() });
