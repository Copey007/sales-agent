/**
 * Worker outreach review queue — draft → approve → send.
 *
 * SDR workers queue personalized emails as pending drafts (worker_outreach).
 * A human reviews them in Mission Control and approves; approval sends the email
 * for real via Resend from the worker's identity (e.g. james@a-gent.co on the
 * verified a-gent.co domain). Nothing is sent without an explicit approval.
 *
 *   GET    /api/worker-outreach            (JWT) → { drafts, tenants } pending drafts
 *          for every tenant the caller belongs to. Optional ?tenant=<slug>
 *          (or X-Tenant-Slug) scopes to one membership.
 *   POST   /api/worker-outreach {id, action:'approve'|'reject'}  (JWT)
 *          The draft's own tenant_id is used (must be a membership); this does
 *          not depend on an implicit first-membership pick.
 *
 * Tenant-scoped via the caller's memberships; service-role writes.
 * Nothing is sent without an explicit approve action.
 */

import { env } from './_mcp-connectors.mjs';
import { serviceCreds } from './_supabase-rest.mjs';
import { membershipsFromRequest, readTenantSlug, readRequestedTenantId, resolveTenantContext, stealthWriteBlocked, stealthDeniedBody } from './_tenant.mjs';
import { putProspect, findProspectByEmail, isEmailSuppressed, DEFAULTS } from './_campaign-store.mjs';
import { withCors } from './_auth.mjs';
import { tenantGuard } from './_tenant.mjs';
import { complianceOrBlock } from './_email-compliance.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-Slug', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

// Service role only — never the anon key (fails closed if unset; see _supabase-rest.mjs).
function creds() { return serviceCreds(); }
async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // Mission Control per-account workspace: ?tenant_id=<uuid> scopes the queue
  // to exactly that tenant. Reads: operator (any tenant) or a member of it.
  // Approve/reject stays membership-only AND must match the scoped tenant.
  const requested = readRequestedTenantId(req);
  let scopedTenant = null;
  if (requested.id || requested.invalid) {
    const c = await resolveTenantContext(req);
    if (c.internal) return json({ error: 'forbidden' }, 403);
    if (c.invalid) {
      const name = c.status === 403 ? 'forbidden' : c.status === 400 ? 'bad_request' : c.status === 404 ? 'not_found' : 'unauthorized';
      return json({ error: name, reason: c.reason }, c.status || 401);
    }
    scopedTenant = c.tenant && c.tenant.id ? c.tenant : null;
    if (!scopedTenant) return json({ error: 'not_found', reason: 'tenant_not_found' }, 404);
    if (req.method === 'GET') {
      const status = new URL(req.url).searchParams.get('status') || 'pending';
      const r = await rest(`worker_outreach?tenant_id=eq.${scopedTenant.id}&status=eq.${encodeURIComponent(status)}&order=created_at.desc&select=*&limit=100`);
      const rows = r.ok ? await r.json() : [];
      const drafts = (Array.isArray(rows) ? rows : [])
        .filter((d) => d.tenant_id === scopedTenant.id)   // defence in depth
        .map((d) => ({ ...d, tenant_slug: scopedTenant.slug || null, tenant_name: scopedTenant.name || null }));
      return json({ drafts, tenants: [{ id: scopedTenant.id, slug: scopedTenant.slug || null, name: scopedTenant.name || null, role: c.role || null }], scoped_tenant_id: scopedTenant.id });
    }
  }

  const bag = await membershipsFromRequest(req);
  if (!bag?.user?.id) return json({ error: 'unauthorized' }, 401);
  if (!bag.memberships.length) return json({ error: 'forbidden', reason: 'no_membership' }, 403);

  const byId = new Map(bag.memberships.map((m) => [m.tenant.id, m]));
  const tenants = bag.memberships.map((m) => ({ id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name, role: m.role }));
  const slug = readTenantSlug(req);

  function annotate(d) {
    const m = byId.get(d.tenant_id);
    return { ...d, tenant_slug: m?.tenant?.slug || null, tenant_name: m?.tenant?.name || null };
  }

  // ── Pending queue ──
  if (req.method === 'GET') {
    if (slug && !bag.memberships.some((m) => m.tenant.slug === slug)) {
      return json({ error: 'forbidden', reason: 'not_a_member' }, 403);
    }
    const scoped = slug ? bag.memberships.filter((m) => m.tenant.slug === slug) : bag.memberships;
    const tenantIds = scoped.map((m) => m.tenant.id);
    const status = new URL(req.url).searchParams.get('status') || 'pending';
    const filter = tenantIds.length === 1
      ? `tenant_id=eq.${tenantIds[0]}`
      : `tenant_id=in.(${tenantIds.join(',')})`;
    const r = await rest(`worker_outreach?${filter}&status=eq.${encodeURIComponent(status)}&order=created_at.desc&select=*&limit=100`);
    const drafts = r.ok ? await r.json() : [];
    return json({ drafts: (Array.isArray(drafts) ? drafts : []).map(annotate), tenants });
  }

  // ── Approve (send) / reject ──
  if (req.method === 'POST') {
    let b = {}; try { b = await req.json(); } catch {}
    if (!b.id || !['approve', 'reject'].includes(b.action)) return json({ error: 'id and action (approve|reject) required' }, 400);
    const dr = await rest(`worker_outreach?id=eq.${b.id}&select=*&limit=1`);
    const draft = dr.ok ? (await dr.json())[0] : null;
    if (draft && !byId.has(draft.tenant_id)) return json({ error: 'not found' }, 404);
    if (draft && scopedTenant && draft.tenant_id !== scopedTenant.id) return json({ error: 'not found' }, 404);
    if (!draft) return json({ error: 'not found' }, 404);
    // Stealth lock: never approve or reject (or send) a draft for this tenant,
    // even when the request itself is unscoped. Operators included.
    if (stealthWriteBlocked(draft.tenant_id)) return json(stealthDeniedBody(), 403);
    if (draft.status !== 'pending') return json({ error: `already ${draft.status}` }, 409);

    if (b.action === 'reject') {
      await rest(`worker_outreach?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected', reviewed_at: new Date().toISOString() }) });
      return json({ ok: true, status: 'rejected' });
    }

    const prospectEmail = String(draft.prospect_email || '').trim().toLowerCase();
    if (prospectEmail && await isEmailSuppressed(draft.tenant_id, prospectEmail)) {
      await rest(`worker_outreach?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected', reviewed_at: new Date().toISOString() }) });
      return json({ error: 'email_on_suppression_list', suppressed: true, status: 'rejected' }, 409);
    }

    // Approve → send via Resend. Fail closed without a postal address
    // (same gate as send-worker-background); never call Resend without
    // the CAN-SPAM footer and List-Unsubscribe header.
    const RESEND = env('RESEND_API_KEY');
    if (!RESEND) return json({ error: 'RESEND_API_KEY not configured' }, 500);
    const compliance = complianceOrBlock({ replyTo: draft.from_email, toEmail: draft.prospect_email, tenantId: draft.tenant_id });
    if (!compliance.ok) {
      return json({ error: compliance.reason, blocked: true }, 503);
    }
    try {
      const send = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${draft.worker_name || 'A-Gent'} <${draft.from_email}>`,
          to: [draft.prospect_email],
          subject: draft.subject,
          text: `${draft.body || ''}${compliance.footer}`,
          reply_to: draft.from_email,
          headers: { ...compliance.headers },
        }),
      });
      const result = await send.json().catch(() => ({}));
      if (!send.ok) return json({ error: result?.message || `Resend ${send.status}` }, 502);
      await rest(`worker_outreach?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'sent', resend_id: result.id || null, reviewed_at: new Date().toISOString(), sent_at: new Date().toISOString() }) });
      // Record the contact in the shared AI SDR prospect store so future sourcing dedups against it.
      try {
        const email = String(draft.prospect_email || '').toLowerCase();
        const draftTenantId = draft.tenant_id || DEFAULTS.TENANT_ID;
        if (email && !(await findProspectByEmail(draftTenantId, email))) {
          await putProspect({ id: crypto.randomUUID(), tenant_id: draftTenantId, email, name: draft.prospect_name || null, company_name: draft.prospect_company || null, source: 'sdr-worker', contacted: true, contacted_at: new Date().toISOString(), sourced_at: new Date().toISOString(), created_at: new Date().toISOString() });
        }
      } catch (e) { console.warn('[worker-outreach] prospect record:', e.message); }
      return json({ ok: true, status: 'sent', resend_id: result.id || null });
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }

  return json({ error: 'method not allowed' }, 405);
};

export const config = { path: '/api/worker-outreach' };

// Security wrapper: allowlisted CORS + tenant auth guard (2026-11 lockdown).
export default withCors(__handler, { guard: tenantGuard() });
