/**
 * ICP Agent — shared company-discovery brain.
 * Parses a free-text ICP into a Hunter Discover natural-language query,
 * paginates the full result set, and hard-screens candidates for relevance.
 */

import { callLLM, parseLLMJson } from './_llm.mjs';

// Turns the campaign's free-text ICP into a REAL company list via Hunter
// Discover, instead of the static demo domain map. Two steps:
//   1. LLM parses the ICP into Discover filters (query, headcount buckets,
//      exclusions like "no competitors like Gong").
//   2. Hunter Discover returns companies actually matching those filters.
// Returns { companies: [{domain, company_name}], mode, filters } — empty
// companies means the caller should fall back (and say so honestly).

// Per-invocation parse cache: bulk jobs call this dozens of times with the
// same ICP — parse once, reuse the query + exclusions for every page.
const parseCache = new Map();

export async function icpDiscoverCompanies(icpText, targetRole, hunterKey, max = 6, offset = 0) {
  if (!icpText || !hunterKey) return { companies: [], mode: 'no_icp_or_key' };

  let f = parseCache.get(icpText);
  if (!f) {
    try {
      const content = await callLLM([
        { role: 'system', content: `Turn an ideal-customer-profile description into a Hunter.io Discover natural-language search. Return ONLY JSON:
{"query":"<one natural-language sentence describing the companies, INCLUDING industry AND the employee-count range verbatim, e.g. 'B2B SaaS software companies with 15 to 100 employees'>","exclude_domains":["gong.io"],"exclude_keywords":["gong"]}
Hunter Discover understands company size in plain language, so always state the employee range inside the query.
Use CONCRETE segment words (e.g. "SaaS software", "fintech", "cybersecurity") — never the generic word "technology" alone, it matches universities and consumer brands.
exclude_domains/exclude_keywords: any companies or categories the ICP explicitly excludes (e.g. named competitors and their well-known peers).` },
        { role: 'user', content: `ICP: ${icpText}\nTarget buyer: ${targetRole || 'decision maker'}` }
      ], { model: 'claude-haiku-4-5', maxTokens: 400 });
      f = parseLLMJson(content);
      if (f && f.query) parseCache.set(icpText, f);
    } catch (e) {
      return { companies: [], mode: `icp_parse_failed: ${e.message}`, transient: true };
    }
  }
  f = f || {};

  const query = f.query || icpText.slice(0, 120);

  // Natural-language query only: Hunter Discover's semantic mode honors the
  // size/industry constraints in the sentence but IGNORES structured filters
  // when a query is present (verified live), so we never mix the two.
  // limit/offset paginate the full match set (verified: 13k+ results for a
  // typical ICP) — the caller advances offset per run to walk the market.
  const pageSize = Math.max(max * 3, 20);
  let orgs = null, mode = '';
  try {
    let res = await fetch(`https://api.hunter.io/v2/discover?api_key=${hunterKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: pageSize, offset })
    });
    if (res.ok) { orgs = await res.json(); mode = 'hunter_discover_query'; }
    else {
      const params = new URLSearchParams({ api_key: hunterKey, query, limit: String(pageSize), offset: String(offset) });
      res = await fetch(`https://api.hunter.io/v2/discover?${params}`);
      if (res.ok) { orgs = await res.json(); mode = 'hunter_discover_get'; }
      else return { companies: [], mode: `discover_http_${res.status}` };
    }
  } catch (e) {
    return { companies: [], mode: `discover_failed: ${e.message}` };
  }

  const list = orgs?.data?.organizations || orgs?.data || orgs?.organizations || [];
  const exDom = (f.exclude_domains || []).map(d => String(d).toLowerCase());
  const exKw = (f.exclude_keywords || []).map(k => String(k).toLowerCase());
  let companies = (Array.isArray(list) ? list : [])
    .map(o => ({ domain: o.domain, company_name: o.organization || o.name || o.company_name || o.domain }))
    .filter(c => c.domain)
    .filter(c => !exDom.some(d => c.domain.toLowerCase().includes(d)))
    .filter(c => !exKw.some(k => `${c.domain} ${c.company_name}`.toLowerCase().includes(k)));

  // Relevance gate: Discover's semantic search can surface universities,
  // consumer brands, or media sites. Screen candidates against the ICP and
  // keep only plausible fits before spending Hunter domain-search credits.
  // The gate is MANDATORY: LLM screen with one retry, then a heuristic
  // fallback — never pass candidates through unscreened.
  if (companies.length) {
    let gated = null;
    for (let attempt = 0; attempt < 2 && gated === null; attempt++) {
      try {
        const content = await callLLM([
          { role: 'system', content: 'You screen companies against an ideal customer profile. Return ONLY JSON: {"keep":["domain1.com","domain2.com"]} — the exact domains (verbatim from the list) that PLAUSIBLY match the ICP (right industry AND a plausible commercial fit). Reject universities, government bodies, standards organizations, consumer-product brands, media/news sites, and anything clearly outside the stated industry. An empty keep list is valid if nothing fits.' },
          { role: 'user', content: `ICP: ${icpText}\n\nCandidates:\n${companies.slice(0, 20).map(c => `- ${c.domain} (${c.company_name})`).join('\n')}` }
        ], { model: 'claude-haiku-4-5', maxTokens: 300 });
        const parsed = parseLLMJson(content);
        if (parsed && Array.isArray(parsed.keep)) {
          const keep = new Set(parsed.keep.map(d => String(d).toLowerCase().replace(/^www\./, '')));
          gated = companies.filter(c => keep.has(c.domain.toLowerCase().replace(/^www\./, '')));
        }
      } catch (e) { /* retry once, then heuristic */ }
    }
    if (gated === null) {
      // Heuristic fallback: drop obvious non-commercial fits
      const junk = /(\.edu|\.gov|\.mil|\.ac\.[a-z]{2})$|\.(ru|by)$|university|institute|college|w3\.org|wikipedia/i;
      gated = companies.filter(c => !junk.test(c.domain) && !junk.test(c.company_name || ''));
    }
    companies = gated;
  }
  companies = companies.slice(0, max);

  const rawCount = Array.isArray(list) ? list.length : 0;
  const total = orgs?.meta?.results ?? null;
  // exhausted = Discover itself returned nothing at this offset (true end of
  // market). A page where the gate rejected every candidate is NOT exhaustion
  // — the cursor advanced and the next page may be full of fits.
  return {
    companies, mode,
    raw_count: rawCount,
    total,
    next_offset: offset + rawCount,
    exhausted: rawCount === 0,
    filters: { query, offset }
  };
}

// ─── AI SDR / CRM Feed ───────────────────────────────────────────────────────
// Campaign-sourced prospects also flow into the shared Supabase `contacts`
// table so the AI SDR dashboard Prospects metric and the CRM see them.
// Best-effort: a Supabase hiccup never blocks campaign enrollment.
