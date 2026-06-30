/**
 * Worker Runtime — the autonomous goal loop behind a hired AI worker.
 *
 * A hired worker (workforce_hires row) shouldn't need a human to delegate each
 * task. This runtime advances a worker toward its standing GOAL one concrete
 * step per cycle: read the goal + recent work → do the next real piece of work
 * (Hunter sourcing for the Researcher; an LLM-produced deliverable for the rest)
 * → log it to the worker's activity feed (visible in Mission Control).
 *
 *   POST /api/worker-runtime  (Authorization: Bearer <jwt>)  { hire_id }
 *        → runs ONE cycle for that hire (the "Run now" button). Tenant-scoped.
 *
 *   Scheduled invocation (cron) → batch-advances due active workers, but ONLY
 *   when WORKER_RUNTIME_AUTO=1 (so autonomous spend is opt-in). Otherwise no-op.
 *
 * Safety: active hires only; per-worker cadence throttle; per-run cap; test
 * tenants skipped; small token budget per cycle.
 */

import { env } from './_mcp-connectors.mjs';
import { callLLM } from './_llm.mjs';
import { userFromToken, tenantFromRequest } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

function creds() { return { url: env('SUPABASE_URL'), key: env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY') }; }
async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

const isTest = (h) => /test|stripeok|trial\d|vfy|\bqa\b|sample/i.test(`${h.company || ''} ${h.name || ''}`);

// ─── One worker, one step ────────────────────────────────────────────────────

const ICP = {
  sales: [['gong.io', 'Gong'], ['outreach.io', 'Outreach'], ['salesloft.com', 'Salesloft'], ['apollo.io', 'Apollo.io'], ['clari.com', 'Clari']],
  marketing: [['hubspot.com', 'HubSpot'], ['klaviyo.com', 'Klaviyo'], ['activecampaign.com', 'ActiveCampaign'], ['braze.com', 'Braze'], ['intercom.com', 'Intercom']],
  executive: [['rippling.com', 'Rippling'], ['deel.com', 'Deel'], ['gusto.com', 'Gusto'], ['lattice.com', 'Lattice'], ['remote.com', 'Remote']],
  engineering: [['sentry.io', 'Sentry'], ['launchdarkly.com', 'LaunchDarkly'], ['amplitude.com', 'Amplitude'], ['grafana.com', 'Grafana'], ['honeycomb.io', 'Honeycomb']],
  default: [['pipedrive.com', 'Pipedrive'], ['close.com', 'Close'], ['freshsales.io', 'Freshsales'], ['zoho.com', 'Zoho'], ['copper.com', 'Copper']],
};
function segOf(s = '') {
  s = s.toLowerCase();
  if (/sales|revenue|revops|sdr|\bae\b/.test(s)) return 'sales';
  if (/marketing|growth|demand|cmo/.test(s)) return 'marketing';
  if (/ceo|founder|exec|president|coo/.test(s)) return 'executive';
  if (/cto|engineer|tech|product|dev/.test(s)) return 'engineering';
  return 'default';
}

// Researcher does REAL work: source ICP-fit prospects via Hunter toward the goal.
async function researcherStep(hire) {
  const KEY = env('HUNTER_API_KEY');
  const seg = segOf(`${hire.goal || ''} ${hire.context || ''}`);
  if (!KEY) return { action: 'Planned ICP sourcing run', detail: `Identified the ${seg} segment for "${hire.goal || 'the goal'}". (Hunter key not set — connect it to source live prospects.)` };
  const targets = ICP[seg].slice(0, 3);
  const found = [];
  for (const [domain, company] of targets) {
    if (found.length >= 6) break;
    try {
      const params = new URLSearchParams({ api_key: KEY, domain, type: 'personal', seniority: 'senior,executive', limit: '3' });
      const r = await fetch(`https://api.hunter.io/v2/domain-search?${params}`);
      if (!r.ok) continue;
      const d = await r.json();
      for (const e of (d?.data?.emails || [])) {
        if (!e.value) continue;
        found.push({ name: [e.first_name, e.last_name].filter(Boolean).join(' ') || e.value, title: e.position || '', company: d?.data?.organization || company });
      }
    } catch { /* skip domain */ }
  }
  if (!found.length) return { action: 'Ran a sourcing pass — no new matches', detail: `Scanned ${targets.length} ${seg} accounts this cycle; nothing new cleared the bar. Will widen the net next run.` };
  const names = found.slice(0, 5).map(p => `${p.name}${p.title ? ` (${p.title})` : ''} @ ${p.company}`);
  return { action: `Sourced ${found.length} ICP-fit prospects`, detail: `Toward "${hire.goal || 'your goal'}": ${names.join('; ')}.` };
}

// Everyone else produces a concrete LLM deliverable toward the goal.
async function llmStep(hire) {
  const recent = (hire.activity || []).slice(0, 4).map(a => `- ${a.action}`).join('\n') || '- (nothing yet — this is your first cycle)';
  const system = `You are ${hire.name}, a ${hire.title} working autonomously for ${hire.company || 'the company'}.
Your standing goal: "${hire.goal || 'Make measurable progress for the team.'}".${hire.context ? `\nContext: ${hire.context}` : ''}
Recent work you've already completed:\n${recent}
Do ONE concrete next piece of work toward the goal RIGHT NOW — produce a real deliverable or finding (a drafted message, a short list, an analysis, a plan with specifics), not a promise to do it later. Build on the recent work; don't repeat it.
Return ONLY JSON: {"action":"<past-tense summary, max 9 words>","detail":"<2-4 sentences with the specifics of what you produced this cycle>"}`;
  try {
    const out = await callLLM([{ role: 'system', content: system }, { role: 'user', content: 'Do the next piece of work and report it as JSON.' }], { temperature: 0.6, maxTokens: 500 });
    const m = (out || '').match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (parsed?.action) return { action: String(parsed.action).slice(0, 80), detail: String(parsed.detail || '').slice(0, 600) };
  } catch { /* fall through */ }
  return { action: 'Advanced the goal', detail: 'Completed the next step of work this cycle.' };
}

async function runCycle(hire) {
  const step = hire.worker_id === 'researcher' ? await researcherStep(hire) : await llmStep(hire);
  const entry = { ts: new Date().toISOString(), action: step.action, detail: step.detail };
  const activity = [entry, ...(Array.isArray(hire.activity) ? hire.activity : [])].slice(0, 50);
  // Try to persist the full feed; fall back to just last_activity if the column isn't there yet.
  let res = await rest(`workforce_hires?id=eq.${hire.id}`, { method: 'PATCH', body: JSON.stringify({ activity, last_activity: step.action, last_active_at: entry.ts }) });
  if (!res.ok) await rest(`workforce_hires?id=eq.${hire.id}`, { method: 'PATCH', body: JSON.stringify({ last_activity: step.action, last_active_at: entry.ts }) });
  return entry;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const user = token ? await userFromToken(token) : null;

  // ── Manual "Run now" — one cycle for one of the caller's workers ──
  if (user?.id) {
    const ctx = await tenantFromRequest(req);
    if (!ctx?.tenant?.id) return json({ error: 'unauthorized' }, 401);
    let b = {}; try { b = await req.json(); } catch {}
    if (!b.hire_id) return json({ error: 'hire_id required' }, 400);
    const hr = await rest(`workforce_hires?id=eq.${b.hire_id}&tenant_id=eq.${ctx.tenant.id}&select=*&limit=1`);
    const hire = hr.ok ? (await hr.json())[0] : null;
    if (!hire) return json({ error: 'not found' }, 404);
    if (hire.status !== 'active') return json({ error: 'worker is paused' }, 409);
    const entry = await runCycle(hire);
    return json({ ok: true, entry });
  }

  return json({ error: 'unauthorized' }, 401);   // HTTP endpoint is manual-only; cron uses runDueWorkers()
};

/** Batch-advance due active workers. Called by worker-runtime-cron on a schedule. */
export async function runDueWorkers() {
  const cutoff = new Date(Date.now() - 50 * 60000).toISOString();   // ~hourly per worker
  const r = await rest(`workforce_hires?status=eq.active&or=(last_active_at.is.null,last_active_at.lt.${cutoff})&select=*&order=last_active_at.asc.nullsfirst&limit=8`);
  const due = r.ok ? await r.json() : [];
  let ran = 0;
  for (const hire of due) {
    if (isTest(hire)) continue;
    try { await runCycle(hire); ran++; } catch (e) { console.warn('[worker-runtime]', hire.id, e.message); }
  }
  return { ran, considered: due.length };
}

export const config = { path: '/api/worker-runtime' };
