/**
 * Provision a tenant + its avatar agent in one call — the "add a customer"
 * endpoint for the multi-tenant avatar product.
 *
 * POST /api/provision-agent  { secret, slug, name, ... }
 *   Creates/updates: tenants -> tenant_modules(avatar) -> avatar_agents
 *   Returns { tenant_id, agent_url }
 *
 * Admin-guarded by env ADMIN_SECRET (fail-closed). Runs with the service-role
 * key, so it bypasses RLS to do trusted provisioning. Later this is what the
 * Stripe webhook / self-serve signup calls.
 */

import { env } from './_mcp-connectors.mjs';
import { withCors, safeEqual } from './_auth.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

function creds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return { url, key };
}
async function sb(url, key, path, body, prefer = 'return=representation') {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: prefer },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return null; }
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const adminSecret = env('ADMIN_SECRET');
  if (!adminSecret) return json({ error: 'provisioning disabled: ADMIN_SECRET not set' }, 503);

  let b = {};
  try { b = await req.json(); } catch {}
  if (!safeEqual(String(b.secret || ''), adminSecret)) return json({ error: 'unauthorized' }, 401);

  if (!b.slug || !b.name || !b.avatar_id || !b.voice_id) {
    return json({ error: 'slug, name, avatar_id, voice_id are required' }, 400);
  }

  const { url, key } = creds();
  if (!url || !key) return json({ error: 'missing supabase creds' }, 500);

  try {
    // 1) tenant
    const tenant = (await sb(url, key, 'tenants?on_conflict=slug',
      { slug: b.slug, name: b.name, plan: b.plan || 'trial', status: 'active' },
      'return=representation,resolution=merge-duplicates'))[0];

    // 2) avatar module entitlement
    await sb(url, key, 'tenant_modules?on_conflict=tenant_id,module',
      { tenant_id: tenant.id, module: 'avatar', enabled: true,
        limits: b.limits || { monthly_minutes: 500, max_concurrent: 3 } },
      'return=minimal,resolution=merge-duplicates');

    // 3) avatar agent (the public /a/<slug> surface)
    const agent = (await sb(url, key, 'avatar_agents?on_conflict=slug',
      {
        slug: b.slug, tenant_id: tenant.id, name: b.name, status: 'active',
        avatar_id: b.avatar_id, voice_id: b.voice_id, mode: b.mode || 'FULL',
        system_prompt: b.system_prompt || `You are ${b.name}'s live AI agent. Be helpful, concise, and on-brand.`,
        greeting: b.greeting || `Hi! I'm ${b.name}'s AI agent. Ask me anything.`,
        chips: b.chips || ['What can you do?', 'Tell me more', 'Book a demo'],
        theme: b.theme || {},
        max_concurrent: (b.limits && b.limits.max_concurrent) || 3,
        monthly_minute_cap: (b.limits && b.limits.monthly_minutes) || 500,
      },
      'return=representation,resolution=merge-duplicates'))[0];

    return json({
      ok: true,
      tenant_id: tenant.id,
      slug: b.slug,
      agent_url: `https://aisdr.a-gent.co/a/${b.slug}`,
      agent_id: agent.id,
    });
  } catch (err) {
    console.error('[provision-agent]', err.message);
    return json({ error: 'internal_error' }, 500);
  }
};

export const config = { path: '/api/provision-agent', rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
