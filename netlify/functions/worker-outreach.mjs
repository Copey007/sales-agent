/**
 * Worker outreach review queue — draft → approve → send.
 *
 * SDR workers queue personalized emails as pending drafts (worker_outreach).
 * A human reviews them in Mission Control and approves; approval sends the email
 * for real via Resend from the worker's identity (e.g. james@a-gent.co on the
 * verified a-gent.co domain). Nothing is sent without an explicit approval.
 *
 *   GET    /api/worker-outreach            (JWT) → { drafts:[...] } pending, this tenant
 *   POST   /api/worker-outreach {id, action:'approve'|'reject'}  (JWT)
 *
 * Tenant-scoped via the caller's membership; service-role writes.
 */

import { env } from './_mcp-connectors.mjs';
import { serviceCreds } from './_supabase-rest.mjs';
import { tenantFromRequest } from './_tenant.mjs';
import { putProspect, findProspectByEmail, DEFAULTS } from './_campaign-store.mjs';
import { withCors } from './_auth.mjs';
import { tenantGuard } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

// Service role only — never the anon key (fails closed if unset; see _supabase-rest.mjs).
function creds() { return serviceCreds(); }
async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const ctx = await tenantFromRequest(req);
  if (!ctx?.tenant?.id) return json({ error: 'unauthorized' }, 401);
  const tenantId = ctx.tenant.id;

  // ── Pending queue ──
  if (req.method === 'GET') {
    const status = new URL(req.url).searchParams.get('status') || 'pending';
    const r = await rest(`worker_outreach?tenant_id=eq.${tenantId}&status=eq.${encodeURIComponent(status)}&order=created_at.desc&select=*&limit=100`);
    const drafts = r.ok ? await r.json() : [];
    return json({ drafts });
  }

  // ── Approve (send) / reject ──
  if (req.method === 'POST') {
    let b = {}; try { b = await req.json(); } catch {}
    if (!b.id || !['approve', 'reject'].includes(b.action)) return json({ error: 'id and action (approve|reject) required' }, 400);
    const dr = await rest(`worker_outreach?id=eq.${b.id}&tenant_id=eq.${tenantId}&select=*&limit=1`);
    const draft = dr.ok ? (await dr.json())[0] : null;
    if (!draft) return json({ error: 'not found' }, 404);
    if (draft.status !== 'pending') return json({ error: `already ${draft.status}` }, 409);

    if (b.action === 'reject') {
      await rest(`worker_outreach?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected', reviewed_at: new Date().toISOString() }) });
      return json({ ok: true, status: 'rejected' });
    }

    // Approve → send via Resend
    const RESEND = env('RESEND_API_KEY');
    if (!RESEND) return json({ error: 'RESEND_API_KEY not configured' }, 500);
    try {
      const send = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${draft.worker_name || 'A-Gent'} <${draft.from_email}>`,
          to: [draft.prospect_email],
          subject: draft.subject,
          text: draft.body,
          reply_to: draft.from_email,
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
