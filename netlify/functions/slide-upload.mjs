/**
 * Upload a presentation slide image for an avatar agent.
 *
 * POST /api/slide-upload   (Authorization: Bearer <supabase jwt>)
 *   { agent_slug, filename, content_type, data_base64 }
 *   → { url }   (public Supabase Storage URL)
 *
 * Auth: must be a logged-in Supabase user. Uses the service-role key to write
 * to Storage (auto-creates the public 'slides' bucket on first use).
 */

import { env } from './_mcp-connectors.mjs';
import { userFromToken } from './_tenant.mjs';
import { withCors } from './_auth.mjs';
import { tenantGuard, resolveTenantContext, canAccessTenant, scopedTenantMatches } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const BUCKET = 'slides';
const MAX_BYTES = 6 * 1024 * 1024; // 6MB
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // must be authenticated
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const user = await userFromToken(token);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);

  let b = {};
  try { b = await req.json(); } catch {}
  const slug = (b.agent_slug || 'agent').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'agent';
  const ct = (b.content_type || '').toLowerCase();
  const ext = EXT[ct];
  if (!ext) return json({ error: 'Unsupported file type. Use PNG, JPG, WEBP, GIF, or PDF.' }, 400);
  if (!b.data_base64) return json({ error: 'data_base64 required' }, 400);

  const bytes = Buffer.from(b.data_base64, 'base64');
  if (bytes.length > MAX_BYTES) return json({ error: 'File too large (max 6MB). Please compress it.' }, 413);

  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const sHead = { apikey: key, Authorization: `Bearer ${key}` };
  if (!url || !key) return json({ error: 'Server not configured.' }, 503);

  // Ownership: a tenant may only attach slides under its own agent's slug.
  if (slug !== 'agent') {
    const ctx = await resolveTenantContext(req);
    if (ctx.invalid) return json({ error: 'forbidden' }, ctx.status || 403);
    const r = await fetch(`${url}/rest/v1/avatar_agents?slug=eq.${encodeURIComponent(slug)}&select=tenant_id&limit=1`, { headers: sHead });
    const rows = r.ok ? await r.json() : [];
    if (rows.length && !canAccessTenant(ctx, rows[0].tenant_id)) return json({ error: 'forbidden' }, 403);
    // Workspace scoped via ?tenant_id=: the agent must belong to that tenant.
    if (rows.length && !scopedTenantMatches(ctx, rows[0].tenant_id)) return json({ error: 'forbidden' }, 403);
  }

  try {
    // ensure the public bucket exists (idempotent)
    await fetch(`${url}/storage/v1/bucket`, {
      method: 'POST', headers: { ...sHead, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    }).catch(() => {});

    const path = `${slug}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const up = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...sHead, 'Content-Type': ct, 'x-upsert': 'true' },
      body: bytes,
    });
    if (!up.ok) { console.error('[slide-upload] storage', up.status, await up.text()); return json({ error: 'upload failed' }, 502); }

    return json({ url: `${url}/storage/v1/object/public/${BUCKET}/${path}` });
  } catch (err) {
    console.error('[slide-upload]', err.message);
    return json({ error: 'internal_error' }, 500);
  }
};

export const config = { path: '/api/slide-upload' };

// Security wrapper: allowlisted CORS + tenant auth guard (2026-11 lockdown).
export default withCors(__handler, { guard: tenantGuard() });
