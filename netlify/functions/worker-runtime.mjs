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
import { findProspectByEmail, isEmailSuppressed, DEFAULTS, listCampaigns, listRecords, putProspect, putCampaignProspect, putEmailSend, logActivity } from './_campaign-store.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

function creds() { return { url: env('SUPABASE_URL'), key: env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY') }; }
async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

const isTest = (h) => /test|stripeok|trial\d|vfy|\bqa\b|sample/i.test(`${h.company || ''} ${h.name || ''}`);

// Has a worker already drafted/sent to this email? (avoid re-contacting across cycles)
async function outreachExists(tenantId, email) {
  try { const r = await rest(`worker_outreach?tenant_id=eq.${tenantId}&prospect_email=eq.${encodeURIComponent(email)}&select=id&limit=1`); return r.ok ? (await r.json()).length > 0 : false; }
  catch { return false; }
}

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

// Researcher: source ICP-fit prospects via Hunter, dedup, and ENROLL the new ones
// into the AI SDR campaign (loaded for the SDR to work).
async function researcherStep(hire) {
  const KEY = env('HUNTER_API_KEY');
  const tenantId = hire.tenant_id || DEFAULTS.TENANT_ID;
  const seg = segOf(`${hire.goal || ''} ${hire.context || ''}`);
  if (!KEY) return { action: 'Planned ICP sourcing run', detail: `Identified the ${seg} segment for "${hire.goal || 'the goal'}". (Hunter key not set — connect it to source live.)` };
  const found = [];
  for (const [domain, company] of ICP[seg].slice(0, 3)) {
    if (found.length >= 8) break;
    try {
      const params = new URLSearchParams({ api_key: KEY, domain, type: 'personal', seniority: 'senior,executive', limit: '3' });
      const r = await fetch(`https://api.hunter.io/v2/domain-search?${params}`);
      if (!r.ok) continue;
      const d = await r.json();
      for (const e of (d?.data?.emails || [])) {
        if (e?.value) found.push({ name: [e.first_name, e.last_name].filter(Boolean).join(' ') || e.value, title: e.position || '', company: d?.data?.organization || company, email: e.value });
      }
    } catch { /* skip domain */ }
  }
  if (!found.length) return { action: 'Ran a sourcing pass — no new matches', detail: `Scanned ${seg} accounts; nothing cleared the bar. Widening next run.` };
  let camp = null;
  try { camp = (await listCampaigns(tenantId)).find(c => c.status === 'active') || null; } catch { /* no campaigns */ }
  const newly = [];
  for (const p of found) {
    const email = (p.email || '').toLowerCase(); if (!email) continue;
    try {
      if (await isEmailSuppressed(tenantId, email)) continue;
      if (await findProspectByEmail(tenantId, email)) continue;   // already known → dedup
      const pr = { id: crypto.randomUUID(), tenant_id: tenantId, email, name: p.name, company_name: p.company, role: p.title, source: 'researcher-worker', sourced_at: new Date().toISOString(), created_at: new Date().toISOString() };
      await putProspect(pr); newly.push(p);
      if (camp) await putCampaignProspect({ campaign_id: camp.id, prospect_id: pr.id, enrolled_at: new Date().toISOString(), status: 'active' });
    } catch { /* skip prospect */ }
  }
  if (!newly.length) return { action: `Reviewed ${found.length} prospects — all already known`, detail: 'Every match is already a prospect in your AI SDR — no duplicates added.' };
  const names = newly.slice(0, 5).map(p => `${p.name}${p.title ? ` (${p.title})` : ''} @ ${p.company}`);
  return { action: `Sourced & enrolled ${newly.length} new prospects${camp ? ` into "${camp.name}"` : ''}`, detail: `Loaded into ${camp ? `the "${camp.name}" campaign` : 'your prospect list'} for the AI SDR: ${names.join('; ')}.` };
}

// SDR: source an ICP-fit prospect via Hunter, then draft a personalized opener for it.
async function sdrStep(hire) {
  const KEY = env('HUNTER_API_KEY');
  const seg = segOf(`${hire.goal || ''} ${hire.context || ''}`);
  // Gather candidates from Hunter…
  const candidates = [];
  if (KEY) {
    for (const [domain, company] of ICP[seg].slice(0, 3)) {
      if (candidates.length >= 8) break;
      try {
        const params = new URLSearchParams({ api_key: KEY, domain, type: 'personal', seniority: 'senior,executive', limit: '3' });
        const r = await fetch(`https://api.hunter.io/v2/domain-search?${params}`);
        if (!r.ok) continue;
        for (const e of ((await r.json())?.data?.emails || [])) {
          if (e?.value) candidates.push({ name: [e.first_name, e.last_name].filter(Boolean).join(' ') || e.value, title: e.position || '', company, email: e.value });
        }
      } catch { /* next domain */ }
    }
  }
  if (!candidates.length) return llmStep(hire);   // no Hunter/matches → generic step
  // …then keep only a prospect NOT already in your AI SDR campaign / suppressed / previously contacted.
  let prospect = null;
  const sdrTenantId = hire.tenant_id || DEFAULTS.TENANT_ID;
  for (const c of candidates) {
    const email = c.email.toLowerCase();
    try {
      if (await findProspectByEmail(sdrTenantId, email)) continue;   // already a prospect in the AI SDR
      if (await isEmailSuppressed(sdrTenantId, email)) continue;      // suppressed / unsubscribed
    } catch { /* campaign store unavailable — don't block */ }
    if (await outreachExists(hire.tenant_id, email)) continue;              // a worker already contacted them
    prospect = c; break;
  }
  if (!prospect) return { action: `Checked ${candidates.length} prospects — all already in your pipeline`, detail: `Every prospect sourced this cycle is already enrolled in your AI SDR campaign, suppressed, or previously contacted — no duplicate created. Widening the ICP next run.` };
  const sys = `You are ${hire.name}, an SDR for ${hire.company || 'the company'}.${hire.context ? ` What you sell / context: ${hire.context}.` : ''} Goal: ${hire.goal || 'book qualified meetings'}.
Write a short, genuinely personalized cold outreach email to ${prospect.name}${prospect.title ? ` (${prospect.title})` : ''} at ${prospect.company}. 2–3 sentences, specific to their role/company, no fluff, one clear low-friction CTA.
Return ONLY JSON: {"subject":"<6-9 words>","body":"<the email>"}`;
  let email = null;
  try { const out = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: 'Write the email as JSON.' }], { temperature: 0.6, maxTokens: 420 }); const m = (out || '').match(/\{[\s\S]*\}/); email = m ? JSON.parse(m[0]) : null; } catch { /* ignore */ }
  if (!email?.subject) return { action: `Sourced ${prospect.name} @ ${prospect.company}`, detail: `${prospect.name} (${prospect.title}) <${prospect.email}>; personalizing the opener next cycle.` };
  // The worker's own identity on the verified sending domain.
  const fromEmail = `${(hire.name.split(' ')[0] || 'worker').toLowerCase().replace(/[^a-z0-9]/g, '')}@a-gent.co`;
  // Queue the email as a PENDING draft for human review (best-effort; needs the worker_outreach table).
  try {
    await rest('worker_outreach', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      tenant_id: hire.tenant_id, hire_id: hire.id, worker_id: hire.worker_id, worker_name: hire.name, from_email: fromEmail,
      prospect_name: prospect.name, prospect_email: prospect.email, prospect_company: prospect.company,
      subject: email.subject, body: email.body, status: 'pending',
    }) });
  } catch { /* table not present yet — still report the draft */ }
  return {
    action: `Drafted outreach to ${prospect.name.split(' ')[0]} @ ${prospect.company} — pending review`,
    detail: `From ${fromEmail} → ${prospect.name} <${prospect.email}>. Subject: "${email.subject}". Approve it in Outreach review to send.`,
  };
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

// Live business snapshot from the AI SDR (for Manager / RevOps / Success).
async function businessSnapshot(tenantId = DEFAULTS.TENANT_ID) {
  try {
    const camps = await listCampaigns(tenantId);
    const active = camps.filter(c => c.status === 'active');
    const prospects = (await listRecords('prospects')).filter(p => (p.tenant_id || DEFAULTS.TENANT_ID) === tenantId);
    const sends = (await listRecords('email_sends')).filter(s => (s.tenant_id || DEFAULTS.TENANT_ID) === tenantId);
    const replies = (await listRecords('replies')).filter(r => (r.tenant_id || DEFAULTS.TENANT_ID) === tenantId);
    return `${active.length} active campaign(s)${active.length ? ` (${active.slice(0, 4).map(c => c.name).join(', ')})` : ''}, ${prospects.length} prospects, ${sends.filter(s => s.status === 'sent').length} emails sent, ${replies.length} replies`;
  } catch { return 'no campaign data available yet'; }
}

// Role-specific brains — each worker does its own job.
const ROLE_BRIEFS = {
  manager: { data: true, brief: (h, s) => `You are ${h.name}, Mission Control Manager for ${h.company || 'the company'}. You run the AI workforce and own the growth plan. Live business snapshot: ${s}. Do the next concrete planning move: name ONE gap ("what we're not doing yet") and ONE specific thing to put in place to grow, with a short rationale.` },
  ops: { data: true, brief: (h, s) => `You are ${h.name}, Revenue Operations. You watch every campaign — whether they're running, what's been sent, what's replied. Snapshot: ${s}. Produce the next concrete ops finding: a health check, a flag (stalled campaign, low reply rate, no sends), or a specific fix to recommend.` },
  success: { data: true, brief: (h, s) => `You are ${h.name}, Customer Success. You watch how customers get value and any churn signals. Signals: ${s}. Produce the next concrete CS action: a value highlight to surface, a churn-risk flag, or a check-in to run.` },
  social: { data: false, brief: (h) => `You are ${h.name}, Social Media Manager for ${h.company || 'the company'}. Draft the next concrete piece of content — a ready-to-post update for X or LinkedIn, on-brand for an AI SDR / AI workforce product. (Scheduling + engagement analytics connect once the Social integration is enabled.)` },
  support: { data: false, brief: (h) => `You are ${h.name}, Customer Support. Produce the next concrete support-readiness deliverable — a crisp answer to a common product question, an FAQ entry, or an escalation/triage rule. (Live inbound support connects once the support inbox is wired.)` },
};
async function roleStep(hire) {
  const cfg = ROLE_BRIEFS[hire.worker_id];
  if (!cfg) return llmStep(hire);
  const snap = cfg.data ? await businessSnapshot(hire.tenant_id || DEFAULTS.TENANT_ID) : '';
  const recent = (hire.activity || []).slice(0, 3).map(a => `- ${a.action}`).join('\n') || '- (first cycle)';
  const system = `${cfg.brief(hire, snap)}
Standing goal: "${hire.goal || 'make progress for the team'}".${hire.context ? ` Context: ${hire.context}.` : ''}
Recent work you've done:\n${recent}
Build on it; don't repeat. Return ONLY JSON: {"action":"<past-tense, <=9 words>","detail":"<2-4 sentences, specific>"}`;
  try {
    const out = await callLLM([{ role: 'system', content: system }, { role: 'user', content: 'Do the next piece of work and report it as JSON.' }], { temperature: 0.6, maxTokens: 500 });
    const m = (out || '').match(/\{[\s\S]*\}/); const p = m ? JSON.parse(m[0]) : null;
    if (p?.action) return { action: String(p.action).slice(0, 80), detail: String(p.detail || '').slice(0, 600) };
  } catch { /* fall through */ }
  return { action: 'Advanced the goal', detail: 'Completed the next step this cycle.' };
}


// ─── Manager: pipeline health sweep ──────────────────────────────────────────
// The Mission Control Manager OWNS send-pipeline supervision — the duties a
// human ops manager would run before standup: audit the live ledger, repair
// stranded work, flag exhausted retries, and report campaign pacing. The
// queue-manager cron keeps a silent 5-minute safety net, but the Manager is
// the accountable owner: his feed and daily report show what he found.

const MGR_STALE_DISPATCH_MS = 2 * 60 * 60 * 1000;

async function pipelineHealthSweep() {
  const now = Date.now();
  const sends = await listRecords('email_sends');
  let recovered = 0, exhausted = 0;
  for (const s of sends) {
    if (s.status === 'dispatched' && !s.resend_result && s.dispatched_at &&
        (now - new Date(s.dispatched_at).getTime()) > MGR_STALE_DISPATCH_MS) {
      if ((s.redispatch_count || 0) >= 2) { s.status = 'failed'; s.error = 'stale dispatch, retries exhausted'; exhausted++; }
      else { s.status = 'queued'; s.redispatch_count = (s.redispatch_count || 0) + 1; recovered++; }
      await putEmailSend(s);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const active = (await listCampaigns(DEFAULTS.TENANT_ID)).filter(c => c.status === 'active');
  const lines = active.map(c => {
    const cs = sends.filter(s => s.campaign_id === c.id);
    const queued = cs.filter(s => s.status === 'queued').length;
    const sentToday = cs.filter(s => s.status === 'sent' && (s.sent_at || '').slice(0, 10) === today).length;
    const failed = cs.filter(s => s.status === 'failed').length;
    return `${c.name}: ${queued} queued, ${sentToday} sent today${failed ? `, ${failed} FAILED (needs attention)` : ''}`;
  });
  return { recovered, exhausted, lines, sends_total: sends.length };
}

// Property health: the hourly steward check across every A-Gent surface.
// Marcus runs this each cycle — if a property is down or the pipeline needed
// repair, he escalates by email immediately (not just the daily report).
const WATCHED_PROPERTIES = [
  ['Marketing site', 'https://a-gent.co/'],
  ['Mission Control', 'https://missioncontrol.a-gent.co/'],
  ['AI SDR', 'https://aisdr.a-gent.co/'],
  ['CRM', 'https://crm.a-gent.co/'],
  ['Live demo', 'https://aisdr.a-gent.co/a/demo']
];

async function propertyHealth() {
  const results = [];
  for (const [name, url] of WATCHED_PROPERTIES) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'A-Gent-Marcus-HealthCheck' } });
      clearTimeout(t);
      results.push({ name, ok: r.ok, status: r.status });
    } catch (e) {
      results.push({ name, ok: false, status: 'unreachable' });
    }
  }
  return { results, allUp: results.every(r => r.ok) };
}

async function sendManagerAlert(hire, subject, body) {
  const key = env('RESEND_API_KEY');
  if (!key) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${hire.name || 'Marcus'} — Mission Control <fleet@a-gent.co>`,
        to: ['mark.cope.roarr@gmail.com'],
        subject: `[${hire.name || 'Marcus'}] ${subject}`,
        text: body
      })
    });
    return r.ok;
  } catch { return false; }
}

async function managerStep(hire) {
  let health = null;
  try { health = await pipelineHealthSweep(); } catch (e) { health = { error: e.message }; }
  let sites = null;
  try { sites = await propertyHealth(); } catch (e) { sites = null; }

  // Keep the strategic planning move, now informed by real ops data.
  const planning = await roleStep(hire);

  const siteNote = sites
    ? (sites.allUp ? `All ${sites.results.length} properties up.` : `PROPERTY DOWN: ${sites.results.filter(r => !r.ok).map(r => `${r.name} (${r.status})`).join(', ')}.`)
    : 'Property check unavailable.';
  const healthNote = (health?.error
    ? `Pipeline sweep FAILED: ${health.error}`
    : `Pipeline sweep: ${health.recovered ? `recovered ${health.recovered} stranded send(s)` : 'no stranded work'}` +
      `${health.exhausted ? `; ${health.exhausted} send(s) marked failed after exhausted retries` : ''}. ` +
      (health.lines.length ? health.lines.join(' · ') : 'No active campaigns.')) + ' ' + siteNote;

  // Escalate immediately when something needs a human: a property down,
  // sends failing out, or the sweep itself erroring.
  const needsHuman = (sites && !sites.allUp) || (health?.exhausted > 0) || !!health?.error;
  if (needsHuman) {
    await sendManagerAlert(hire, sites && !sites.allUp ? 'Property down' : 'Pipeline needs attention',
      `Steward check at ${new Date().toISOString()}:\n\n${healthNote}\n\n— ${hire.name || 'Marcus'}, Mission Control Manager`);
  }

  try {
    await logActivity({
      type: 'manager_health_sweep',
      by: hire.name || 'Mission Control Manager',
      hire_id: hire.id,
      recovered: health?.recovered || 0,
      exhausted: health?.exhausted || 0,
      summary: healthNote.slice(0, 300)
    });
  } catch { /* reporting is best-effort */ }

  const action = health?.recovered
    ? `Recovered ${health.recovered} stranded send(s); pipeline audited`
    : (health?.error ? 'Pipeline audit hit an error (see detail)' : 'Pipeline audit clean; advanced growth plan');
  return { action: action.slice(0, 80), detail: `${healthNote}\n\nGrowth move: ${planning.detail}` };
}

async function runCycle(hire) {
  let step;
  if (hire.worker_id === 'researcher') step = await researcherStep(hire);
  else if (hire.worker_id === 'sdr') step = await sdrStep(hire);
  else if (hire.worker_id === 'manager') step = await managerStep(hire);
  else if (ROLE_BRIEFS[hire.worker_id]) step = await roleStep(hire);
  else step = await llmStep(hire);
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
export async function runDueWorkers({ rolesOnly = null } = {}) {
  const cutoff = new Date(Date.now() - 50 * 60000).toISOString();   // ~hourly per worker
  // rolesOnly restricts the sweep (e.g. ['manager'] — pipeline supervision
  // runs even when full workforce autonomy is switched off).
  const roleFilter = Array.isArray(rolesOnly) && rolesOnly.length
    ? `&worker_id=in.(${rolesOnly.join(',')})` : '';
  const r = await rest(`workforce_hires?status=eq.active${roleFilter}&or=(last_active_at.is.null,last_active_at.lt.${cutoff})&select=*&order=last_active_at.asc.nullsfirst&limit=8`);
  const due = r.ok ? await r.json() : [];
  let ran = 0;
  for (const hire of due) {
    if (isTest(hire)) continue;
    try { await runCycle(hire); ran++; } catch (e) { console.warn('[worker-runtime]', hire.id, e.message); }
  }
  return { ran, considered: due.length };
}

export const config = { path: '/api/worker-runtime' };
