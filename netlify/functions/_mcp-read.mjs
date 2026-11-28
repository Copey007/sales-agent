/**
 * MCP Phase-A tenant-scoped READ surface (AskArlen MCP server → A-Gent).
 *
 * Read-only by construction: this module has no write calls (no PATCH/POST/
 * DELETE, no Resend, no Hunter, no LLM). Tenant resolution lives in
 * _tenant.mjs (resolveMcpReadScope). See /workspace/handoffs/mcp-phase-a-contract.md.
 */
import { serviceCreds } from './_supabase-rest.mjs';
import { resolveMcpReadScope, isHomeTenant, MASTER_TENANT_ID } from './_tenant.mjs';
import { json, withCors } from './_auth.mjs';
import { listCampaigns, listRecords, getProspect, getFeatureFlag } from './_campaign-store.mjs';

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;
export const WORKER_OUTREACH_STATUSES = ['pending', 'approved', 'rejected', 'sent'];

async function sbGet(path, { count = false } = {}) {
  const { url, key } = serviceCreds();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  if (count) headers.Prefer = 'count=exact';
  const res = await fetch(`${url}/rest/v1/${path}`, { method: 'GET', headers });
  return res;
}

/** Campaign-engine (Blobs) key. The operator home account's campaigns live under MASTER. Stealth is never aliased. */
export function campaignKeyFor(tenantId) {
  return isHomeTenant(tenantId) ? MASTER_TENANT_ID : tenantId;
}

const publicTenant = (ctx) => ({ id: ctx.tenant.id, slug: ctx.tenant.slug || null, name: ctx.tenant.name || null, role: ctx.role });

/** Wrap a GET-only MCP read handler: method gate, scope resolution, generic errors. */
export function mcpReadEndpoint(handle) {
  const inner = async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(req, { error: 'method_not_allowed', reason: 'read_only' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
    }
    const scope = await resolveMcpReadScope(req);
    if (!scope.ctx) return json(req, scope.body, scope.status);
    try {
      const out = await handle(req, scope.ctx);
      // Handlers return the payload, or { __error: status, body } for a 4xx.
      if (out && out.__error) return json(req, out.body, out.__error, { 'Cache-Control': 'no-store' });
      return json(req, out, 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      console.error('[mcp-read]', e.message);
      return json(req, { error: 'internal_error' }, 500);
    }
  };
  return withCors(inner);
}

// ─── account_status ─────────────────────────────────────────────────────────

async function countWhere(table, filter) {
  try {
    const res = await sbGet(`${table}?select=id&${filter}&limit=1`, { count: true });
    if (!res.ok) return null;
    const range = res.headers.get('content-range') || '';
    const n = Number(range.split('/')[1]);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export async function accountStatus(req, ctx) {
  const tenantId = ctx.tenant.id;
  const key = campaignKeyFor(tenantId);

  const [campaigns, flagOrch, flagQueue, hiresRes, tenantRes, woPending, sends] = await Promise.all([
    listCampaigns(key),
    getFeatureFlag('multi_campaign_orchestration'),
    getFeatureFlag('queue_manager_active'),
    sbGet(`workforce_hires?tenant_id=eq.${tenantId}&order=created_at.desc&select=id,tenant_id,worker_id,name,title,status,last_activity,last_active_at,created_at`),
    sbGet(`tenants?id=eq.${tenantId}&select=trial_ends_at,plan,status&limit=1`),
    countWhere('worker_outreach', `tenant_id=eq.${tenantId}&status=eq.pending`),
    listRecords('email_sends'),
  ]);

  const ownIds = new Set(campaigns.map((c) => c.id));
  const campaignDraftsPending = sends.filter((s) => s.status === 'pending_approval' && ownIds.has(s.campaign_id)).length;

  const hiresRaw = hiresRes.ok ? await hiresRes.json() : [];
  const hires = (Array.isArray(hiresRaw) ? hiresRaw : []).filter((h) => h.tenant_id === tenantId)
    .map((h) => ({ id: h.id, worker_id: h.worker_id, name: h.name, title: h.title || null, status: h.status,
      last_activity: h.last_activity || null, last_active_at: h.last_active_at || null, created_at: h.created_at || null }));
  const t = tenantRes.ok ? (await tenantRes.json())[0] : null;

  const active = campaigns.filter((c) => c.status === 'active');
  return {
    tenant: publicTenant(ctx),
    stealth_readonly: !!ctx.stealth,
    as_of: new Date().toISOString(),
    campaigns: {
      total: campaigns.length,
      active: active.length,
      items: active.map((c) => ({
        id: c.id, name: c.name, status: c.status, created_at: c.created_at || null,
        launched_at: c.launched_at || null, daily_send_limit: c.daily_send_limit ?? null,
        // Allowlisted metrics only — never pass through the raw campaign record
        // (it may carry provider ids such as resend_id).
        metrics: {
          prospects_enrolled: Number(c.metrics?.prospects_enrolled ?? c.agent_status?.researcher?.prospects_found ?? 0) || 0,
          queued_sends: Number(c.metrics?.queued_sends ?? c.agent_status?.ops?.sends_queued ?? 0) || 0,
          sent_today: Number(c.metrics?.sent_today ?? 0) || 0,
        },
      })),
    },
    engine: { multi_campaign_orchestration: !!flagOrch, queue_manager_active: !!flagQueue },
    workforce: {
      total: hires.length,
      active: hires.filter((h) => h.status === 'active').length,
      hires,
      trial: t ? { ends_at: t.trial_ends_at || null, plan: t.plan || null, status: t.status || null } : null,
    },
    drafts: { worker_outreach_pending: woPending, campaign_sends_pending: campaignDraftsPending },
  };
}

// ─── lookup_drafts ──────────────────────────────────────────────────────────

function clampLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export async function lookupDrafts(req, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const source = (url.searchParams.get('source') || 'all').toLowerCase();
  const status = (url.searchParams.get('status') || 'pending').toLowerCase();
  const campaignId = url.searchParams.get('campaign_id') || null;
  const limit = clampLimit(url.searchParams.get('limit'));
  if (!['all', 'worker_outreach', 'campaign_sends'].includes(source)) return { __error: 400, body: { error: 'bad_request', reason: 'invalid_source' } };
  if (!WORKER_OUTREACH_STATUSES.includes(status)) return { __error: 400, body: { error: 'bad_request', reason: 'invalid_status' } };
  if (campaignId && !/^[A-Za-z0-9_-]{1,80}$/.test(campaignId)) return { __error: 400, body: { error: 'bad_request', reason: 'invalid_campaign_id' } };

  const tenantId = ctx.tenant.id;
  const drafts = [];
  let woTotal = null;
  let csTotal = null;

  if (source === 'all' || source === 'worker_outreach') {
    const res = await sbGet(`worker_outreach?tenant_id=eq.${tenantId}&status=eq.${encodeURIComponent(status)}&order=created_at.desc&select=id,tenant_id,hire_id,worker_id,worker_name,from_email,prospect_name,prospect_email,prospect_company,subject,body,status,created_at,reviewed_at,sent_at&limit=${limit}`, { count: true });
    const rows = res.ok ? await res.json() : [];
    const range = res.headers.get('content-range') || '';
    woTotal = Number.isFinite(Number(range.split('/')[1])) ? Number(range.split('/')[1]) : null;
    for (const d of (Array.isArray(rows) ? rows : [])) {
      if (d.tenant_id !== tenantId) continue; // defence in depth
      drafts.push({
        kind: 'worker_outreach', id: d.id, status: d.status,
        subject: d.subject || null, body: d.body || null,
        from: d.from_email || null,
        to: { email: d.prospect_email || null, name: d.prospect_name || null, company: d.prospect_company || null },
        worker: { id: d.worker_id || null, name: d.worker_name || null, hire_id: d.hire_id || null },
        campaign_id: null, step_number: null,
        created_at: d.created_at || null, reviewed_at: d.reviewed_at || null, sent_at: d.sent_at || null,
      });
    }
  }

  // Campaign-engine drafts exist only as pending approval (same as campaign-admin list_pending).
  if ((source === 'all' || source === 'campaign_sends') && status === 'pending') {
    const key = campaignKeyFor(tenantId);
    const ownIds = new Set((await listCampaigns(key)).map((c) => c.id));
    const sends = (await listRecords('email_sends'))
      .filter((s) => s.status === 'pending_approval' && ownIds.has(s.campaign_id) && (!campaignId || s.campaign_id === campaignId));
    csTotal = sends.length;
    sends.sort((a, b) => String(b.drafted_at || '').localeCompare(String(a.drafted_at || '')));
    for (const s of sends.slice(0, limit)) {
      const p = await getProspect(s.prospect_id);
      drafts.push({
        kind: 'campaign_send', id: s.id, status: 'pending',
        subject: s.email_subject || null, body: s.email_body || null, from: null,
        to: { email: p?.email || null, name: p?.contact_name || null, company: p?.company_name || p?.company || null },
        worker: null, campaign_id: s.campaign_id, step_number: s.step_number ?? null,
        created_at: s.drafted_at || null, reviewed_at: null, sent_at: null,
      });
    }
  } else if (source === 'campaign_sends') {
    csTotal = 0;
  }

  return {
    tenant: publicTenant(ctx),
    stealth_readonly: !!ctx.stealth,
    status, source, limit,
    counts: { worker_outreach: woTotal, campaign_sends: csTotal, returned: drafts.length },
    truncated: (woTotal != null && woTotal > drafts.filter((d) => d.kind === 'worker_outreach').length)
      || (csTotal != null && csTotal > drafts.filter((d) => d.kind === 'campaign_send').length),
    drafts,
  };
}
