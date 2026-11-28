/**
 * Worker daily report — each worker emails its manager an end-of-day summary.
 *
 * Like a real employee: what I did today, a win or two, and a learning / next focus.
 * Data comes from the worker's own outputs (worker_outreach drafts/sends + the
 * hire's latest activity). Sent from the worker's identity (e.g. james@a-gent.co).
 *
 *   POST /api/worker-daily-report  (Authorization: Bearer <jwt>)  { hire_id }
 *        → generates + emails THAT worker's report to you now (for testing).
 *
 *   Scheduled (worker-daily-report-cron) → one report per active worker per day,
 *   emailed to the workspace owner. Gated behind WORKER_RUNTIME_AUTO=1.
 */

import { env } from './_mcp-connectors.mjs';
import { serviceCreds } from './_supabase-rest.mjs';
import { callLLM } from './_llm.mjs';
import { scopedTenantFromRequest } from './_tenant.mjs';
import { withCors } from './_auth.mjs';
import { tenantGuard } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

// Service role only — never the anon key (fails closed if unset; see _supabase-rest.mjs).
function creds() { return serviceCreds(); }
async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}
const fromFor = (h) => `${(h.name.split(' ')[0] || 'worker').toLowerCase().replace(/[^a-z0-9]/g, '')}@a-gent.co`;

// Gather what the worker did in the last ~24h.
async function gatherWork(hire) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let outreach = [];
  try { const r = await rest(`worker_outreach?hire_id=eq.${hire.id}&created_at=gte.${since}&select=prospect_name,prospect_company,status,subject&limit=100`); if (r.ok) outreach = await r.json(); } catch {}
  const drafted = outreach.length;
  const sent = outreach.filter(o => o.status === 'sent').length;
  const activity = Array.isArray(hire.activity) ? hire.activity.filter(a => a.ts >= since).slice(0, 10) : [];
  return { drafted, sent, outreach, activity, last_activity: hire.last_activity };
}

async function buildReport(hire) {
  const w = await gatherWork(hire);
  const lines = [
    `Drafts created: ${w.drafted}${w.sent ? `, sent after approval: ${w.sent}` : ''}.`,
    w.outreach.length ? `Prospects: ${w.outreach.slice(0, 8).map(o => `${o.prospect_name || '?'}${o.prospect_company ? ' @ ' + o.prospect_company : ''}`).join('; ')}.` : '',
    w.activity.length ? `Recent actions: ${w.activity.map(a => a.action).join('; ')}.` : (w.last_activity ? `Latest: ${w.last_activity}.` : ''),
  ].filter(Boolean).join('\n');
  const system = `You are ${hire.name}, a ${hire.title} working for ${hire.company || 'the company'}. Standing goal: "${hire.goal || 'make progress for the team'}".
Write a short end-of-day report to your manager, first person, warm but professional. Cover: (1) what you did today, (2) a win or two, (3) one honest learning or where you'll focus next. 4–6 sentences, plain text, no markdown, no subject line.
Today's raw activity:\n${lines || '(quiet day — little logged)'}`;
  const body = await callLLM([{ role: 'system', content: system }, { role: 'user', content: 'Write the report.' }], { temperature: 0.6, maxTokens: 350 });
  return { body: (body || '').trim(), stats: { drafted: w.drafted, sent: w.sent } };
}

async function sendReport(hire, toEmail) {
  if (!toEmail) return { sent: false, reason: 'no recipient' };
  const RESEND = env('RESEND_API_KEY');
  if (!RESEND) return { sent: false, reason: 'no RESEND_API_KEY' };
  const { body, stats } = await buildReport(hire);
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${hire.name} <${fromFor(hire)}>`, to: [toEmail], subject: `${hire.name.split(' ')[0]}'s daily report — ${today}`, text: body, reply_to: fromFor(hire) }),
  });
  const j = await res.json().catch(() => ({}));
  return { sent: res.ok, resend_id: j.id || null, stats, preview: body.slice(0, 200) };
}

// Look up the workspace owner's email (for the scheduled path).
async function ownerEmail(tenantId) {
  try {
    const m = await rest(`memberships?tenant_id=eq.${tenantId}&role=eq.owner&select=user_id&limit=1`);
    const uid = m.ok ? (await m.json())[0]?.user_id : null;
    if (!uid) return null;
    const { url, key } = creds();
    const u = await fetch(`${url}/auth/v1/admin/users/${uid}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    return u.ok ? (await u.json())?.email || null : null;
  } catch { return null; }
}

export async function runDailyReports() {
  const r = await rest(`workforce_hires?status=eq.active&select=*&limit=50`);
  const hires = r.ok ? await r.json() : [];
  let sent = 0;
  for (const h of hires) {
    if (/test|stripeok|trial\d|vfy|sample/i.test(`${h.company || ''} ${h.name || ''}`)) continue;
    const to = await ownerEmail(h.tenant_id);
    try { const res = await sendReport(h, to); if (res.sent) sent++; } catch (e) { console.warn('[daily-report]', h.id, e.message); }
  }
  return { sent, considered: hires.length };
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const scoped = await scopedTenantFromRequest(req, json);
  if (scoped.response) return scoped.response;
  const ctx = scoped.ctx;
  if (!ctx?.tenant?.id) return json({ error: 'unauthorized' }, 401);
  let b = {}; try { b = await req.json(); } catch {}
  if (!b.hire_id) return json({ error: 'hire_id required' }, 400);
  const hr = await rest(`workforce_hires?id=eq.${b.hire_id}&tenant_id=eq.${ctx.tenant.id}&select=*&limit=1`);
  const hire = hr.ok ? (await hr.json())[0] : null;
  if (!hire) return json({ error: 'not found' }, 404);
  const res = await sendReport(hire, ctx.user?.email);   // test: email the report to the caller
  return json({ ok: res.sent, to: ctx.user?.email, ...res });
};

export const config = { path: '/api/worker-daily-report' };

// Security wrapper: allowlisted CORS + tenant auth guard (2026-11 lockdown).
export default withCors(__handler, { guard: tenantGuard() });
