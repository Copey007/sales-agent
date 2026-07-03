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
import { sb } from './_supabase-rest.mjs';

const MAX_ORGS_PER_FIND = 15;   // sync path budget; bulk path loops in background
const EMAILS_PER_ORG = 5;

const TABLE_MISSING_HINT = 'contact_pool table not found — run the setup SQL in the Supabase SQL editor first';

function tableMissing(err) {
  return err && (err.code === '42P01' || /contact_pool.*(not exist|not found)|PGRST205/i.test(err.message || ''));
}

export function hunterKey() {
  return (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
    ? Netlify.env.get('HUNTER_API_KEY') : (process.env.HUNTER_API_KEY || '');
}

// Per-ICP Discover pagination cursor (single small record — Blobs is fine).
export async function getIcpCursor(icp) {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore('contact_pool');
  let meta = {};
  try { meta = (await store.get('pool_meta', { type: 'json' })) || {}; } catch { meta = {}; }
  return meta.icp === icp ? (Number(meta.offset) || 0) : 0;
}
export async function setIcpCursor(icp, offset, extra = {}) {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore('contact_pool');
  await store.setJSON('pool_meta', { id: 'pool_meta', icp, offset, updated_at: new Date().toISOString(), ...extra });
}

/**
 * One find pass: Discover a page of companies for the ICP, domain-search each,
 * and bulk-insert new contacts into the pool. The UNIQUE email constraint +
 * ignore-duplicates means re-discovered contacts are silently skipped — the
 * database enforces "never twice", across every campaign, forever.
 * Returns { inserted, companies, market_size, exhausted }.
 */
export async function findAndPoolContacts({ icp, role, orgCount }) {
  const key = hunterKey();
  if (!key) return { error: 'HUNTER_API_KEY not configured' };

  const offset = await getIcpCursor(icp);
  const disc = await icpDiscoverCompanies(icp, role || 'CEO', key, orgCount, offset);
  if (!disc.companies.length) {
    return { inserted: 0, companies: [], market_size: disc.total || null, exhausted: true, mode: disc.mode };
  }
  await setIcpCursor(icp, disc.next_offset, { market_size: disc.total });

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
        if (await isEmailSuppressed(DEFAULTS.TENANT_ID, e.value.toLowerCase())) continue;
        rows.push({
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
    inserted = await sb('contact_pool?on_conflict=email', {
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
 *  into the send ledger. */
export async function enrollPool(campaignId) {
  const now = new Date().toISOString();
  const updated = await sb('contact_pool?selected=is.true&status=eq.found', {
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    if (req.method === 'GET') {
      const { data: pool, count: total } = await sb('contact_pool?select=*&order=found_at.desc&limit=300', { count: true });
      const { count: selectedCount } = await sb('contact_pool?select=id&selected=is.true&status=eq.found&limit=1', { count: true });
      const { count: availableCount } = await sb('contact_pool?select=id&status=eq.found&limit=1', { count: true });
      return new Response(JSON.stringify({
        pool: pool || [],
        total: total ?? (pool || []).length,
        available_count: availableCount ?? 0,
        selected_count: selectedCount ?? 0
      }), { headers: cors });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'find';

    if (action === 'find') {
      const orgCount = Math.min(Number(body.org_count) || 5, MAX_ORGS_PER_FIND);
      const result = await findAndPoolContacts({ icp: (body.icp || '').trim(), role: (body.role || 'CEO').trim(), orgCount });
      if (result.error) return new Response(JSON.stringify(result), { status: 422, headers: cors });
      return new Response(JSON.stringify({ found: result.inserted, ...result }), { headers: cors });
    }

    if (action === 'select') {
      const ids = (body.ids || []).filter(Boolean);
      if (!ids.length) return new Response(JSON.stringify({ updated: 0 }), { headers: cors });
      const updated = await sb(`contact_pool?id=in.(${ids.join(',')})&status=eq.found`, {
        method: 'PATCH', body: { selected: body.selected !== false }, prefer: 'return=representation'
      });
      return new Response(JSON.stringify({ updated: (updated || []).length }), { headers: cors });
    }

    if (action === 'select_all') {
      const updated = await sb('contact_pool?status=eq.found', {
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
