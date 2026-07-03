/**
 * Researcher Find — the "Find Contacts" workflow behind the Mission Control
 * A-Gent Researcher panel.
 *
 * POST /api/researcher-find {action:"find", icp, role, org_count}
 *   ICP Agent discovers org_count companies (paginated per-ICP so repeat
 *   searches surface NEW companies), Hunter domain-searches each for
 *   decision-maker contacts, and saves them to the contact_pool store.
 *
 * GET  /api/researcher-find                 — list the pool (newest first)
 * POST {action:"select", ids:[], selected}  — toggle selection
 * POST {action:"select_all", selected}      — select/clear every available contact
 *
 * Selected contacts are what the Campaign Agent offers when creating a
 * campaign. Enrolling marks them status:"in_campaign".
 */

import { icpDiscoverCompanies, syncContactToSupabase } from './researcher-background.mjs';
import { isEmailSuppressed, findProspectByEmail, logActivity, DEFAULTS } from './_campaign-store.mjs';

const MAX_ORGS_PER_FIND = 15;   // stays inside the 26s foreground budget
const EMAILS_PER_ORG = 3;

async function poolStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore('contact_pool');
}

export async function poolList() {
  const store = await poolStore();
  const { blobs = [] } = await store.list();
  const rows = [];
  for (const b of blobs) {
    try { const r = await store.get(b.key, { type: 'json' }); if (r) rows.push(r); } catch { /* skip */ }
  }
  return rows.sort((a, b) => String(b.found_at || '').localeCompare(String(a.found_at || '')));
}

export async function poolGetMany(ids) {
  const store = await poolStore();
  const out = [];
  for (const id of ids || []) {
    try { const r = await store.get(id, { type: 'json' }); if (r) out.push(r); } catch { /* skip */ }
  }
  return out;
}

export async function poolUpdate(id, patch) {
  const store = await poolStore();
  const r = await store.get(id, { type: 'json' });
  if (!r) return null;
  const next = { ...r, ...patch };
  await store.setJSON(id, next);
  return next;
}

function hunterKey() {
  return (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
    ? Netlify.env.get('HUNTER_API_KEY') : (process.env.HUNTER_API_KEY || '');
}

async function runFind({ icp, role, org_count }) {
  const key = hunterKey();
  if (!key) return { error: 'HUNTER_API_KEY not configured' };
  const orgCount = Math.min(Number(org_count) || 5, MAX_ORGS_PER_FIND);

  // Per-ICP pagination: repeat searches with the same ICP continue where the
  // last one stopped instead of re-reading page 1.
  const store = await poolStore();
  const metaKey = 'pool_meta';
  let meta = {};
  try { meta = (await store.get(metaKey, { type: 'json' })) || {}; } catch { meta = {}; }
  const offset = meta.icp === icp ? (Number(meta.offset) || 0) : 0;

  const disc = await icpDiscoverCompanies(icp, role || 'CEO', key, orgCount, offset);
  if (!disc.companies.length) {
    return { error: `ICP discovery returned no companies (${disc.mode})`, mode: disc.mode };
  }
  await store.setJSON(metaKey, { id: metaKey, icp, offset: disc.next_offset, market_size: disc.total, updated_at: new Date().toISOString() });

  // Existing pool emails for dedup
  const existing = new Set((await poolList()).map(c => (c.email || '').toLowerCase()));

  const found = [];
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
        const email = e.value.toLowerCase();
        if (existing.has(email)) continue;
        if (await isEmailSuppressed(DEFAULTS.TENANT_ID, email)) continue;
        const already = await findProspectByEmail(DEFAULTS.TENANT_ID, email);
        const contact = {
          id: crypto.randomUUID(),
          email: e.value,
          name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null,
          first_name: e.first_name || null,
          last_name: e.last_name || null,
          title: e.position || role || null,
          company_name: org,
          company_domain: domain,
          hunter_confidence: e.confidence || null,
          icp,
          status: already ? 'already_in_campaigns' : 'found',
          selected: false,
          found_at: now
        };
        await store.setJSON(contact.id, contact);
        existing.add(email);
        found.push(contact);
        await syncContactToSupabase({ ...contact, contact_name: contact.name }, null);
      }
    } catch { /* continue with next org */ }
  }

  await logActivity({
    type: 'researcher_find',
    contacts_found: found.length,
    companies_searched: disc.companies.length,
    market_size: disc.total,
    icp
  });

  return {
    found: found.length,
    companies: disc.companies,
    market_size: disc.total,
    next_offset: disc.next_offset,
    contacts: found
  };
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
      const pool = await poolList();
      return new Response(JSON.stringify({
        pool: pool.filter(c => c.id !== 'pool_meta'),
        selected_count: pool.filter(c => c.selected && c.status === 'found').length
      }), { headers: cors });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'find';

    if (action === 'find') {
      const result = await runFind(body);
      return new Response(JSON.stringify(result), { status: result.error ? 422 : 200, headers: cors });
    }

    if (action === 'select') {
      let updated = 0;
      for (const id of body.ids || []) {
        if (await poolUpdate(id, { selected: body.selected !== false })) updated++;
      }
      return new Response(JSON.stringify({ updated }), { headers: cors });
    }

    if (action === 'select_all') {
      const pool = await poolList();
      let updated = 0;
      for (const c of pool) {
        if (c.id === 'pool_meta' || c.status !== 'found') continue;
        await poolUpdate(c.id, { selected: body.selected !== false });
        updated++;
      }
      return new Response(JSON.stringify({ updated }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
};

export const config = { path: '/api/researcher-find' };
