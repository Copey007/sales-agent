/**
 * Researcher Find — the "Find Contacts" workflow behind the Mission Control
 * A-Gent Researcher panel. Pool lives in the Supabase `contact_pool` table:
 * a UNIQUE email constraint makes cross-campaign dedup a database guarantee —
 * a contact can only ever exist once, and once enrolled (status in_campaign)
 * no other campaign can take them.
 *
 * GET  /api/researcher-find                — pool page + totals
 * POST {action:"find", icp, role, org_count}         — synchronous find (≤15 orgs)
 * POST {action:"select", ids:[], selected}           — toggle selection
 * POST {action:"select_all", selected}               — select/clear all available
 *
 * Bulk finds (hundreds–1000 contacts) run in researcher-background
 * ({action:"bulk_find"}) which reuses findAndPoolContacts below.
 */

import { icpDiscoverCompanies } from './_icp-agent.mjs';
import { isEmailSuppressed, logActivity, DEFAULTS } from './_campaign-store.mjs';
import { sb, poolTenantReady, poolTenantFilter } from './_supabase-rest.mjs';
import { resolveTenantContext } from './_tenant.mjs';

const MAX_ORGS_PER_FIND = 15;   // sync path budget; bulk path loops in background
const EMAILS_PER_ORG = 5;

const TABLE_MISSING_HINT = 'One-time setup needed: the contact_pool table does not exist yet. Run the setup SQL (provided in chat) in the Supabase SQL editor, then refresh this panel.';

function tableMissing(err) {
  return err && (
    err.code === '42P01' || err.code === 'PGRST205' ||
    /contact_pool/i.test(err.message || '') && /(not exist|not found|could not find|schema cache)/i.test(err.message || '')
  );
}

export function hunterKey() {
  return (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
    ? Netlify.env.get('HUNTER_API_KEY') : (process.env.HUNTER_API_KEY || '');
}

// Per-ICP Discover pagination cursor. Each distinct ICP text gets its OWN
// cursor record (hashed key) so two searches never thrash each other's
// progress — the bug that made concurrent bulk jobs re-read page 1 forever.
// Non-demo tenants get their own cursor namespace so a trial user's search
// never advances (or inherits) the demo tenant's Discover progress.
async function cursorKey(icp, tenantId) {
  const { createHash } = await import('node:crypto');
  const ns = tenantId && tenantId !== DEFAULTS.TENANT_ID ? `${tenantId}|` : '';
  return 'pool_meta_' + createHash('sha1').update(ns + icp).digest('hex').slice(0, 12);
}
export async function getIcpCursor(icp, tenantId) {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore('contact_pool');
  const key = await cursorKey(icp, tenantId);
  try {
    const meta = await store.get(key, { type: 'json' });
    if (meta) return Number(meta.offset) || 0;
  } catch { /* fall through */ }
  // Adopt the legacy single-cursor record if it belongs to this ICP
  // (demo-tenant only — the legacy cursor predates tenancy).
  if (!tenantId || tenantId === DEFAULTS.TENANT_ID) {
    try {
      const legacy = (await store.get('pool_meta', { type: 'json' })) || {};
      if (legacy.icp === icp) return Number(legacy.offset) || 0;
    } catch { /* new ICP */ }
  }
  return 0;
}
export async function setIcpCursor(icp, offset, extra = {}, tenantId) {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore('contact_pool');
  const key = await cursorKey(icp, tenantId);
  await store.setJSON(key, { id: key, icp, offset, updated_at: new Date().toISOString(), ...extra });
}

// Single-flight lock so only one bulk job runs at a time (concurrent jobs
// waste Hunter credits re-finding each other's contacts).
const BULK_LOCK_TTL_MS = 14 * 60 * 1000;
export async function getBulkLock() {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore('contact_pool');
  try {
    const lock = await store.get('bulk_lock', { type: 'json' });
    if (lock && lock.started_at && (Date.now() - new Date(lock.started_at).getTime()) < BULK_LOCK_TTL_MS && !lock.released_at) return lock;
  } catch { /* no lock */ }
  return null;
}
export async function setBulkLock(fields) {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore('contact_pool');
  await store.setJSON('bulk_lock', { id: 'bulk_lock', ...fields });
}

/**
 * One find pass: Discover a page of companies for the ICP, domain-search each,
 * and bulk-insert new contacts into the pool. The UNIQUE email constraint +
 * ignore-duplicates means re-discovered contacts are silently skipped — the
 * database enforces "never twice", across every campaign, forever.
 * Returns { inserted, companies, market_size, exhausted }.
 */
export async function findAndPoolContacts({ icp, role, orgCount, tenantId }) {
  const key = hunterKey();
  if (!key) return { error: 'HUNTER_API_KEY not configured' };
  tenantId = tenantId || DEFAULTS.TENANT_ID;
  const tenantColReady = await poolTenantReady();

  const offset = await getIcpCursor(icp, tenantId);
  const disc = await icpDiscoverCompanies(icp, role || 'CEO', key, orgCount, offset);
  // Always advance the cursor past pages Discover actually returned — a page
  // where the relevance gate rejected everything is skipped, not terminal.
  if (disc.raw_count > 0) await setIcpCursor(icp, disc.next_offset, { market_size: disc.total }, tenantId);
  if (!disc.companies.length) {
    return {
      inserted: 0, companies: [],
      market_size: disc.total || null,
      exhausted: disc.exhausted === true,
      transient: disc.transient === true,
      mode: disc.mode
    };
  }

  const rows = [];
  const now = new Date().toISOString();
  for (const { domain, company_name } of disc.companies) {
    try {
      const params = new URLSearchParams({
        api_key: key, domain, type: 'personal',
        seniority: 'executive,senior', limit: String(EMAILS_PER_ORG)
      });
      const res = await fetch(`https://api.hunter.io/v2/domain-search?${params}`);
      if (!res.ok) continue;
      const data = await res.json();
      const org = data?.data?.organization || company_name;
      for (const e of (data?.data?.emails || [])) {
        if (!e.value) continue;
        if (await isEmailSuppressed(tenantId, e.value.toLowerCase())) continue;
        rows.push({
          ...(tenantColReady ? { tenant_id: tenantId } : {}),
          email: e.value.toLowerCase(),
          name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null,
          first_name: e.first_name || null,
          last_name: e.last_name || null,
          title: e.position || role || null,
          company_name: org,
          company_domain: domain,
          hunter_confidence: e.confidence || null,
          icp,
          status: 'found',
          selected: false,
          found_at: now
        });
      }
    } catch { /* next org */ }
  }

  let inserted = [];
  if (rows.length) {
    // Post-migration the unique constraint is (tenant_id,email) — dedup is
    // per-tenant. Pre-migration it's the legacy global (email) constraint.
    const conflictTarget = tenantColReady ? 'tenant_id,email' : 'email';
    inserted = await sb(`contact_pool?on_conflict=${conflictTarget}`, {
      method: 'POST', body: rows,
      prefer: 'resolution=ignore-duplicates,return=representation'
    });
    // CRM feed (contacts table has no unique email — dedupe by lookup)
    try {
      const emails = inserted.map(r => r.email);
      if (emails.length) {
        const existing = await sb(`contacts?select=email&email=in.(${emails.map(e => `"${e}"`).join(',')})`);
        const have = new Set((existing || []).map(r => (r.email || '').toLowerCase()));
        const fresh = inserted.filter(r => !have.has(r.email)).map(r => ({
          name: r.name || r.email.split('@')[0],
          email: r.email,
          company_name: r.company_name,
          type: 'Prospect',
          source: 'Researcher'
        }));
        if (fresh.length) await sb('contacts', { method: 'POST', body: fresh, prefer: 'return=minimal' });
      }
    } catch { /* CRM feed is best-effort */ }
  }

  await logActivity({
    type: 'researcher_find',
    contacts_found: inserted.length,
    companies_searched: disc.companies.length,
    market_size: disc.total,
    icp
  });

  return {
    inserted: inserted.length,
    contacts: inserted,
    companies: disc.companies,
    market_size: disc.total,
    exhausted: false
  };
}

/** Bulk-PATCH every selected available contact into a campaign — instant even
 *  at 1k because it's one UPDATE. The feeder (queue-manager) then drips them
 *  into the send ledger. Tenant-scoped so one tenant's enroll can never grab
 *  another tenant's selected contacts. */
export async function enrollPool(campaignId, tenantId) {
  const now = new Date().toISOString();
  const tf = await poolTenantFilter(tenantId || DEFAULTS.TENANT_ID);
  const updated = await sb(`contact_pool?selected=is.true&status=eq.found${tf}`, {
    method: 'PATCH',
    body: { status: 'in_campaign', campaign_id: campaignId, sdr_state: 'awaiting', selected: false, enrolled_at: now },
    prefer: 'return=representation'
  });
  return Array.isArray(updated) ? updated.length : 0;
}

export default async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    // Tenant scope: JWT → caller's tenant; no auth header → demo tenant
    // (internal calls); a bad token must 401, never fall back to demo.
    const authCtx = await resolveTenantContext(req);
    if (authCtx.invalid) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });
    const tenantId = authCtx.tenantId || DEFAULTS.TENANT_ID;
    const tf = await poolTenantFilter(tenantId);

    if (req.method === 'GET') {
      const { data: pool, count: total } = await sb(`contact_pool?select=*&order=found_at.desc&limit=300${tf}`, { count: true });
      const { count: selectedCount } = await sb(`contact_pool?select=id&selected=is.true&status=eq.found&limit=1${tf}`, { count: true });
      const { count: availableCount } = await sb(`contact_pool?select=id&status=eq.found&limit=1${tf}`, { count: true });
      const lock = await getBulkLock();
      return new Response(JSON.stringify({
        pool: pool || [],
        total: total ?? (pool || []).length,
        available_count: availableCount ?? 0,
        selected_count: selectedCount ?? 0,
        bulk_running: !!lock,
        bulk_job: lock ? { icp: lock.icp, target: lock.target, started_at: lock.started_at } : null
      }), { headers: cors });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'find';

    if (action === 'find') {
      const orgCount = Math.min(Number(body.org_count) || 5, MAX_ORGS_PER_FIND);
      const result = await findAndPoolContacts({ icp: (body.icp || '').trim(), role: (body.role || 'CEO').trim(), orgCount, tenantId });
      if (result.error) return new Response(JSON.stringify(result), { status: 422, headers: cors });
      return new Response(JSON.stringify({ found: result.inserted, ...result }), { headers: cors });
    }

    if (action === 'select') {
      const ids = (body.ids || []).filter(Boolean);
      if (!ids.length) return new Response(JSON.stringify({ updated: 0 }), { headers: cors });
      const updated = await sb(`contact_pool?id=in.(${ids.join(',')})&status=eq.found${tf}`, {
        method: 'PATCH', body: { selected: body.selected !== false }, prefer: 'return=representation'
      });
      return new Response(JSON.stringify({ updated: (updated || []).length }), { headers: cors });
    }

    if (action === 'select_all') {
      const updated = await sb(`contact_pool?status=eq.found${tf}`, {
        method: 'PATCH', body: { selected: body.selected !== false }, prefer: 'return=representation'
      });
      return new Response(JSON.stringify({ updated: (updated || []).length }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: cors });
  } catch (err) {
    const msg = tableMissing(err) ? TABLE_MISSING_HINT : err.message;
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: cors });
  }
};

export const config = { path: '/api/researcher-find' };
