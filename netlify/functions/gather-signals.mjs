/**
 * Signal Gathering Layer — Netlify Serverless Function
 * 
 * Gathers personalization signals from web sources and LinkedIn (public/manual).
 * Returns structured, source-linked signals for use in GAP email generation.
 * 
 * Architecture: Pluggable "signal source" abstraction so enrichment APIs
 * can be dropped in later without rework.
 */

// ─── Signal Source Interface ───────────────────────────────────────────────────
// Each source implements: { name, gather(prospect) -> Signal[] }
// Signal shape: { type, title, detail, source_url, source_name, gathered_at }

class SignalSource {
  constructor(name) { this.name = name; }
  async gather(prospect) { return []; }
}

// ─── Web News Signal Source ────────────────────────────────────────────────────
class WebNewsSource extends SignalSource {
  constructor() { super('web_news'); }
  
  async gather(prospect) {
    const signals = [];
    const company = prospect.company_name;
    if (!company) return signals;
    
    const queries = [
      `${company} funding raised 2024 2025 2026`,
      `${company} news announcement`,
      `${company} partnership acquisition`,
    ];
    
    for (const query of queries) {
      try {
        const results = await webSearch(query);
        for (const r of results.slice(0, 3)) {
          if (r.title && r.url) {
            const type = detectSignalType(r.title + ' ' + (r.snippet || ''));
            signals.push({
              type: type || 'company_news',
              title: r.title,
              detail: r.snippet || r.title,
              source_url: r.url,
              source_name: extractDomain(r.url),
              gathered_at: new Date().toISOString()
            });
          }
        }
      } catch (e) { /* continue on error */ }
    }
    return dedupeSignals(signals).slice(0, 5);
  }
}

// ─── Job Postings Signal Source ────────────────────────────────────────────────
class JobPostingsSource extends SignalSource {
  constructor() { super('job_postings'); }
  
  async gather(prospect) {
    const signals = [];
    const company = prospect.company_name;
    if (!company) return signals;
    
    try {
      const results = await webSearch(`${company} hiring jobs careers 2025 2026`);
      for (const r of results.slice(0, 3)) {
        if (r.title && r.url && (r.title.toLowerCase().includes('job') || r.title.toLowerCase().includes('hiring') || r.title.toLowerCase().includes('career'))) {
          signals.push({
            type: 'hiring',
            title: `Hiring: ${r.title}`,
            detail: r.snippet || r.title,
            source_url: r.url,
            source_name: extractDomain(r.url),
            gathered_at: new Date().toISOString()
          });
        }
      }
    } catch (e) { /* continue */ }
    return signals.slice(0, 3);
  }
}

// ─── Prospect Content Signal Source (posts, podcasts, interviews) ──────────────
class ProspectContentSource extends SignalSource {
  constructor() { super('prospect_content'); }
  
  async gather(prospect) {
    const signals = [];
    const name = prospect.contact_name;
    const company = prospect.company_name;
    if (!name) return signals;
    
    const query = company ? `"${name}" "${company}" post OR interview OR podcast` : `"${name}" post OR interview OR podcast`;
    try {
      const results = await webSearch(query);
      for (const r of results.slice(0, 3)) {
        if (r.title && r.url) {
          signals.push({
            type: 'prospect_content',
            title: r.title,
            detail: r.snippet || r.title,
            source_url: r.url,
            source_name: extractDomain(r.url),
            gathered_at: new Date().toISOString()
          });
        }
      }
    } catch (e) { /* continue */ }
    return signals.slice(0, 3);
  }
}

// ─── Website / Tech Changes Signal Source ──────────────────────────────────────
class WebsiteTechSource extends SignalSource {
  constructor() { super('website_tech'); }
  
  async gather(prospect) {
    const signals = [];
    const company = prospect.company_name;
    const domain = prospect.company_domain;
    if (!company && !domain) return signals;
    
    const target = domain || company;
    try {
      const results = await webSearch(`${target} site redesign OR new feature OR product launch 2025 2026`);
      for (const r of results.slice(0, 2)) {
        if (r.title && r.url) {
          signals.push({
            type: 'tech_change',
            title: r.title,
            detail: r.snippet || r.title,
            source_url: r.url,
            source_name: extractDomain(r.url),
            gathered_at: new Date().toISOString()
          });
        }
      }
    } catch (e) { /* continue */ }
    return signals.slice(0, 2);
  }
}

// ─── LinkedIn Public Signal Source (NO AUTH, best-effort) ──────────────────────
class LinkedInPublicSource extends SignalSource {
  constructor() { super('linkedin_public'); }
  
  async gather(prospect) {
    const signals = [];
    const name = prospect.contact_name;
    const company = prospect.company_name;
    if (!name) return signals;
    
    // Best-effort: search for public LinkedIn content via web search
    const query = `site:linkedin.com "${name}" ${company || ''} post OR article`;
    try {
      const results = await webSearch(query);
      for (const r of results.slice(0, 2)) {
        if (r.title && r.url && r.url.includes('linkedin.com')) {
          signals.push({
            type: 'linkedin_activity',
            title: r.title,
            detail: r.snippet || r.title,
            source_url: r.url,
            source_name: 'LinkedIn',
            gathered_at: new Date().toISOString()
          });
        }
      }
    } catch (e) { /* continue */ }
    return signals.slice(0, 2);
  }
}

// ─── LinkedIn Manual Paste Source ──────────────────────────────────────────────
class LinkedInManualSource extends SignalSource {
  constructor() { super('linkedin_manual'); }
  
  async gather(prospect) {
    const signals = [];
    const text = prospect.linkedin_profile_text;
    if (!text) return signals;
    
    // Extract signals from pasted profile text
    const extracted = extractLinkedInSignals(text, prospect.linkedin_url);
    return extracted.slice(0, 5);
  }
}

// ─── Enrichment API Placeholder (drop-in ready) ───────────────────────────────
class EnrichmentAPISource extends SignalSource {
  constructor() { super('enrichment_api'); }
  
  async gather(prospect) {
    // PLACEHOLDER: When a compliant enrichment provider is configured,
    // implement the API call here. The interface is:
    //   Input: prospect { company_name, company_domain, contact_name, contact_email }
    //   Output: Signal[] with { type, title, detail, source_url, source_name, gathered_at }
    //
    // Example providers: Clearbit, Apollo, ZoomInfo, etc.
    // const apiKey = Netlify.env.get('ENRICHMENT_API_KEY');
    // if (!apiKey) return [];
    // const response = await fetch(ENRICHMENT_URL, { ... });
    // return mapToSignals(response);
    return [];
  }
}

// ─── Signal Orchestrator ───────────────────────────────────────────────────────
const ALL_SOURCES = [
  new WebNewsSource(),
  new JobPostingsSource(),
  new ProspectContentSource(),
  new WebsiteTechSource(),
  new LinkedInPublicSource(),
  new LinkedInManualSource(),
  new EnrichmentAPISource(),
];

async function gatherAllSignals(prospect, options = {}) {
  const sourcesToUse = options.sources 
    ? ALL_SOURCES.filter(s => options.sources.includes(s.name))
    : ALL_SOURCES;
  
  const results = await Promise.allSettled(
    sourcesToUse.map(source => 
      Promise.race([
        source.gather(prospect),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
      ])
    )
  );
  
  const allSignals = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled' && Array.isArray(results[i].value)) {
      allSignals.push(...results[i].value);
    }
  }
  
  return dedupeSignals(allSignals);
}

// ─── Utility Functions ─────────────────────────────────────────────────────────
async function webSearch(query) {
  // Use a simple web search via Google Custom Search or SerpAPI if configured
  const serpApiKey = typeof Netlify !== 'undefined' ? Netlify.env.get('SERP_API_KEY') : process.env.SERP_API_KEY;
  
  if (serpApiKey) {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${serpApiKey}&num=5`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      return (data.organic_results || []).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet
      }));
    }
  }
  
  // Fallback: Use Google's public search (limited, may be rate-limited)
  // In production, configure SERP_API_KEY for reliable results
  const fallbackUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${typeof Netlify !== 'undefined' ? Netlify.env.get('GOOGLE_SEARCH_KEY') || '' : process.env.GOOGLE_SEARCH_KEY || ''}&cx=${typeof Netlify !== 'undefined' ? Netlify.env.get('GOOGLE_SEARCH_CX') || '' : process.env.GOOGLE_SEARCH_CX || ''}`;
  
  try {
    const res = await fetch(fallbackUrl);
    if (res.ok) {
      const data = await res.json();
      return (data.items || []).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet
      }));
    }
  } catch (e) { /* fallback failed */ }
  
  // Final fallback: return empty (signal gathering degrades gracefully)
  return [];
}

function detectSignalType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('funding') || lower.includes('raised') || lower.includes('series')) return 'funding';
  if (lower.includes('hiring') || lower.includes('job') || lower.includes('career')) return 'hiring';
  if (lower.includes('ceo') || lower.includes('cto') || lower.includes('cfo') || lower.includes('appointed') || lower.includes('joined')) return 'executive_change';
  if (lower.includes('partnership') || lower.includes('partner')) return 'partnership';
  if (lower.includes('acquisition') || lower.includes('acquired') || lower.includes('merger')) return 'acquisition';
  if (lower.includes('launch') || lower.includes('released') || lower.includes('announced')) return 'product_launch';
  if (lower.includes('podcast') || lower.includes('interview') || lower.includes('webinar')) return 'media_appearance';
  return 'company_news';
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

function dedupeSignals(signals) {
  const seen = new Set();
  return signals.filter(s => {
    const key = `${s.type}:${s.source_url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractLinkedInSignals(text, profileUrl) {
  const signals = [];
  const url = profileUrl || 'https://linkedin.com';
  
  // Extract job changes
  const jobChangeMatch = text.match(/(?:started|joined|new role|promoted to)\s+(.+?)(?:\n|$)/i);
  if (jobChangeMatch) {
    signals.push({
      type: 'job_change',
      title: `Role change: ${jobChangeMatch[1].trim()}`,
      detail: jobChangeMatch[0].trim(),
      source_url: url,
      source_name: 'LinkedIn (manual)',
      gathered_at: new Date().toISOString()
    });
  }
  
  // Extract recent posts/activity
  const postMatch = text.match(/(?:posted|shared|published|wrote)[\s:]+(.{20,150})/gi);
  if (postMatch) {
    for (const p of postMatch.slice(0, 2)) {
      signals.push({
        type: 'linkedin_activity',
        title: `LinkedIn post: ${p.slice(0, 80).trim()}`,
        detail: p.trim(),
        source_url: url,
        source_name: 'LinkedIn (manual)',
        gathered_at: new Date().toISOString()
      });
    }
  }
  
  // Extract headline/about for context
  const headlineMatch = text.match(/(?:headline|title|about)[\s:]+(.{10,200})/i);
  if (headlineMatch) {
    signals.push({
      type: 'profile_context',
      title: `Profile: ${headlineMatch[1].trim().slice(0, 80)}`,
      detail: headlineMatch[1].trim(),
      source_url: url,
      source_name: 'LinkedIn (manual)',
      gathered_at: new Date().toISOString()
    });
  }
  
  return signals;
}

// ─── Netlify Function Handler ──────────────────────────────────────────────────
export default async (req, context) => {
  // CORS headers for the frontend
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  };
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const body = await req.json();
    const { prospect, sources } = body;
    
    if (!prospect || (!prospect.company_name && !prospect.contact_name)) {
      return new Response(JSON.stringify({ 
        error: 'prospect object with company_name or contact_name is required' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const signals = await gatherAllSignals(prospect, { sources });
    
    return new Response(JSON.stringify({
      success: true,
      prospect: {
        company_name: prospect.company_name,
        contact_name: prospect.contact_name,
      },
      signals,
      signal_count: signals.length,
      sources_queried: (sources || ALL_SOURCES.map(s => s.name)),
      gathered_at: new Date().toISOString()
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

export const config = {
  path: "/api/gather-signals"
};
