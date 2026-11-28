/**
 * GET /api/admin-subaccounts
 *
 * Fail-closed operator directory of every tenant / sub-account. The caller's
 * Supabase JWT email must be in OPERATOR_EMAILS (confirmed). Non-operators
 * get 403; unauthenticated gets 401. Cross-tenant rows are never returned
 * to non-operators. No password hashes, tokens, or secrets in the payload.
 *
 * Query: ?q= / ?search= (name, slug, or id)  ?status=  ?plan=
 */

import { json, serverError, withCors } from './_auth.mjs';
import { requireOperator, homeTenantId } from './_tenant.mjs';
import { sb, serviceCreds, serviceHeaders, SupabaseConfigError } from './_supabase-rest.mjs';

export function parseFilters(url) {
  const u = new URL(url, 'https://aisdr.a-gent.co');
  return {
    q: (u.searchParams.get('q') || u.searchParams.get('search') || '').trim().toLowerCase(),
    status: (u.searchParams.get('status') || '').trim().toLowerCase(),
    plan: (u.searchParams.get('plan') || '').trim().toLowerCase(),
  };
}

export function matchesFilters(tenant, { q = '', status = '', plan = '' } = {}) {
  if (status && String(tenant?.status || '').toLowerCase() !== status) return false;
  if (plan && String(tenant?.plan || '').toLowerCase() !== plan) return false;
  if (q) {
    const hay = `${tenant?.name || ''} ${tenant?.slug || ''} ${tenant?.id || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function countByTenantStatus(rows, tenantId, status) {
  return (rows || []).filter((r) => r && r.tenant_id === tenantId && String(r.status || '') === status).length;
}

export function sanitizeMembers(members) {
  return (members || []).map((m) => ({
    email: m?.email ? String(m.email) : null,
    role: String(m?.role || 'member'),
  }));
}

export function shapeTenant(tenant, { members = [], outreach = [], hires = [] } = {}) {
  const sanitized = sanitizeMembers(members);
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    plan: tenant.plan,
    created_at: tenant.created_at,
    member_count: sanitized.length,
    members: sanitized,
    outreach_pending_count: countByTenantStatus(outreach, tenant.id, 'pending'),
    outreach_sent_count: countByTenantStatus(outreach, tenant.id, 'sent'),
    active_workers_count: countByTenantStatus(hires, tenant.id, 'active'),
  };
}

function emailFromAdminUser(body) {
  if (!body || typeof body !== 'object') return null;
  const email = body.email || body.user?.email || null;
  return email ? String(email) : null;
}

export async function emailsForUserIds(ids, fetchImpl = fetch) {
  const unique = [...new Set((ids || []).filter(Boolean).map(String))];
  const map = {};
  if (!unique.length) return map;
  const { url } = serviceCreds();
  const headers = serviceHeaders();
  await Promise.all(unique.map(async (id) => {
    try {
      const res = await fetchImpl(`${url}/auth/v1/admin/users/${encodeURIComponent(id)}`, { headers });
      if (!res.ok) { map[id] = null; return; }
      map[id] = emailFromAdminUser(await res.json());
    } catch {
      map[id] = null;
    }
  }));
  return map;
}

async function handler(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(req, { error: 'method_not_allowed' }, 405);
  }

  // No internal-token bypass: this endpoint returns every tenant's members.
  const op = await requireOperator(req, { allowInternal: false });
  if (op.response) return op.response;

  try {
    const filters = parseFilters(req.url);
    const [tenants, memberships, outreach, hires] = await Promise.all([
      sb('tenants?select=id,name,slug,status,plan,created_at&order=created_at.asc'),
      sb('memberships?select=tenant_id,user_id,role,created_at'),
      sb('worker_outreach?select=tenant_id,status'),
      sb('workforce_hires?select=tenant_id,status'),
    ]);

    const emailMap = await emailsForUserIds((memberships || []).map((m) => m.user_id));
    const membersByTenant = {};
    for (const m of memberships || []) {
      if (!m?.tenant_id) continue;
      (membersByTenant[m.tenant_id] ||= []).push({
        email: emailMap[m.user_id] || null,
        role: m.role,
      });
    }

    const shaped = (Array.isArray(tenants) ? tenants : [])
      .filter((t) => matchesFilters(t, filters))
      .map((t) => shapeTenant(t, {
        members: membersByTenant[t.id] || [],
        outreach,
        hires,
      }))
      // The operator's own account (campaigns incl. the live master-tenant
      // ones) is flagged and listed first; it is one account like any other.
      .map((t) => ({ ...t, home: t.id === homeTenantId() }))
      .sort((a, b) => (b.home ? 1 : 0) - (a.home ? 1 : 0));

    return json(req, { tenants: shaped, total: shaped.length, home_tenant_id: homeTenantId() });
  } catch (err) {
    if (err instanceof SupabaseConfigError) return json(req, { error: 'misconfigured' }, 503);
    return serverError(req, err, 'admin-subaccounts');
  }
}

export default withCors(handler);
export const config = { path: '/api/admin-subaccounts' };
