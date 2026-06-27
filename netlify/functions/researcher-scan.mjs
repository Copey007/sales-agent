/**
 * On-demand Researcher ICP scan.
 *
 * The Researcher's Hunter.io sourcing normally runs as an hourly background job
 * (researcher-background.mjs). This endpoint exposes the SAME Hunter pipeline as
 * a synchronous, click-to-run scan for the Mission Control "Run ICP Scan" tile:
 * pick ICP-fit company domains from a role/vertical (or a domain you pass),
 * run Hunter Domain Search, and return verified-ish prospects immediately.
 *
 * POST /api/researcher-scan  (Authorization: Bearer <jwt>)
 *   { role?, vertical?, domain? }
 *   → { prospects:[{name,title,email,company_name,company_domain,confidence,linkedin_url}], stats, source }
 *
 * Kept deliberately small (a few domains, 5 emails each, no verifier pass) so it
 * returns well within the 26s function limit and sips Hunter quota. The hourly
 * background job remains the bulk sourcing path.
 */

import { userFromToken } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

// Compact ICP → company-domain map (mirrors researcher-background.mjs segments).
const ICP = {
  sales: [['gong.io','Gong'],['outreach.io','Outreach'],['salesloft.com','Salesloft'],['apollo.io','Apollo.io'],['clari.com','Clari']],
  marketing: [['hubspot.com','HubSpot'],['klaviyo.com','Klaviyo'],['activecampaign.com','ActiveCampaign'],['intercom.com','Intercom'],['braze.com','Braze']],
  executive: [['rippling.com','Rippling'],['deel.com','Deel'],['gusto.com','Gusto'],['lattice.com','Lattice'],['remote.com','Remote']],
  engineering: [['sentry.io','Sentry'],['launchdarkly.com','LaunchDarkly'],['amplitude.com','Amplitude'],['grafana.com','Grafana'],['honeycomb.io','Honeycomb']],
  default: [['pipedrive.com','Pipedrive'],['close.com','Close'],['freshsales.io','Freshsales'],['zoho.com','Zoho'],['copper.com','Copper']],
};

function pickSegment(role = '', vertical = '') {
  const r = role.toLowerCase(), v = vertical.toLowerCase();
  if (/sales|revenue|revops|sdr|\bae\b/.test(r) || /sales|crm|revenue/.test(v)) return 'sales';
  if (/marketing|growth|demand|cmo/.test(r) || /marketing|email|growth/.test(v)) return 'marketing';
  if (/ceo|founder|president|coo|owner/.test(r)) return 'executive';
  if (/cto|engineer|tech|product/.test(r)) return 'engineering';
  return 'default';
}
function seniorityFor(role = '') {
  const r = role.toLowerCase();
  if (/ceo|cto|cfo|founder|president/.test(r)) return 'executive';
  if (/vp|vice president|director|head of/.test(r)) return 'senior,executive';
  return 'senior,executive';
}
function deptFor(role = '') {
  const r = role.toLowerCase();
  if (/sales|revenue|revops|sdr|\bae\b/.test(r)) return 'sales';
  if (/marketing|growth|demand/.test(r)) return 'marketing';
  if (/engineer|tech|cto|product/.test(r)) return 'it';
  if (/ceo|founder|president|coo/.test(r)) return 'executive';
  return 'executive,sales';
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const user = await userFromToken(token);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);

  const HUNTER_KEY = (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY')) || process.env.HUNTER_API_KEY || '';
  if (!HUNTER_KEY) return json({ error: 'Hunter.io is not configured (HUNTER_API_KEY missing).' }, 503);

  let b = {};
  try { b = await req.json(); } catch {}
  const role = (b.role || '').trim();
  const vertical = (b.vertical || '').trim();
  const domainIn = (b.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const targets = domainIn
    ? [[domainIn, domainIn]]
    : ICP[pickSegment(role, vertical)].slice(0, 4);

  const seniority = seniorityFor(role);
  const department = deptFor(role);
  const prospects = [];
  const stats = { companies_searched: 0, emails_found: 0 };

  for (const [domain, company] of targets) {
    if (prospects.length >= 15) break;
    stats.companies_searched++;
    try {
      const params = new URLSearchParams({ api_key: HUNTER_KEY, domain, type: 'personal', seniority, department, limit: '5' });
      const res = await fetch(`https://api.hunter.io/v2/domain-search?${params}`);
      if (!res.ok) continue;
      const data = await res.json();
      const org = data?.data?.organization || company;
      for (const e of (data?.data?.emails || [])) {
        if (!e.value) continue;
        prospects.push({
          name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null,
          title: e.position || role || null,
          email: e.value,
          company_name: org,
          company_domain: domain,
          confidence: e.confidence ?? null,
          linkedin_url: e.linkedin || null,
        });
        stats.emails_found++;
      }
    } catch (err) {
      console.warn('[researcher-scan]', domain, err.message);
    }
  }

  prospects.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return json({
    prospects: prospects.slice(0, 15),
    stats,
    source: domainIn ? `Hunter.io · ${domainIn}` : `Hunter.io · ${pickSegment(role, vertical)} ICP`,
  });
};

export const config = { path: '/api/researcher-scan' };
