/**
 * Grant a person an account + membership on a tenant (team invites / owner
 * bootstrap). Admin-guarded, service-role.
 *
 * POST /api/grant-access  { secret, email, password, tenant_slug, role? }
 *   - creates (or finds) the Supabase Auth user
 *   - links them to the tenant with a role (default 'owner')
 */

import { env } from './_mcp-connectors.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const adminSecret = env('ADMIN_SECRET');
  if (!adminSecret) return json({ error: 'disabled: ADMIN_SECRET not set' }, 503);

  let b = {};
  try { b = await req.json(); } catch {}
  if (b.secret !== adminSecret) return json({ error: 'unauthorized' }, 401);
  const email = (b.email || '').trim().toLowerCase();
  const password = b.password || '';
  const tenantSlug = (b.tenant_slug || '').trim().toLowerCase();
  const role = b.role || 'owner';
  if (!email || !password || !tenantSlug) return json({ error: 'email, password, tenant_slug required' }, 400);

  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const aHead = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  try {
    // tenant
    const tRes = await fetch(`${url}/rest/v1/tenants?slug=eq.${encodeURIComponent(tenantSlug)}&select=id&limit=1`, { headers: aHead });
    const tenant = (await tRes.json())[0];
    if (!tenant) return json({ error: `tenant "${tenantSlug}" not found` }, 404);

    // create or find user
    let userId;
    const cRes = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST', headers: aHead,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const cBody = await cRes.json().catch(() => ({}));
    if (cRes.ok) {
      userId = cBody.id || cBody.user?.id;
    } else if (/already|exists|registered/i.test(JSON.stringify(cBody))) {
      // find the existing user by email
      const lRes = await fetch(`${url}/auth/v1/admin/users?per_page=200`, { headers: aHead });
      const lBody = await lRes.json().catch(() => ({}));
      const found = (lBody.users || []).find((u) => (u.email || '').toLowerCase() === email);
      if (!found) return json({ error: 'user exists but could not be located' }, 500);
      userId = found.id;
      // (re)set password so they can log in
      await fetch(`${url}/auth/v1/admin/users/${userId}`, { method: 'PUT', headers: aHead, body: JSON.stringify({ password, email_confirm: true }) });
    } else {
      return json({ error: cBody.msg || 'could not create user' }, 400);
    }

    // membership (upsert)
    await fetch(`${url}/rest/v1/memberships?on_conflict=tenant_id,user_id`, {
      method: 'POST',
      headers: { ...aHead, Prefer: 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify({ tenant_id: tenant.id, user_id: userId, role }),
    });

    return json({ ok: true, user_id: userId, tenant_id: tenant.id, tenant_slug: tenantSlug, role });
  } catch (err) {
    console.error('[grant-access]', err.message);
    return json({ error: err.message }, 500);
  }
};

export const config = { path: '/api/grant-access' };
