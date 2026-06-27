/**
 * Workforce hires — the per-tenant "workers I hired" management API.
 *
 * A hired worker is its own persisted entity (workforce_hires), distinct from a
 * module entitlement. This powers Mission Control → A-Gent Workforce: list the
 * workers you hired, pause/resume them, edit their goal, and delegate a task.
 *
 * All routes are JWT-guarded and tenant-scoped (service-role writes, tenant_id
 * resolved from the caller's membership — never trusted from the body).
 *
 *   GET    /api/workforce-hires                 → { hires:[...], trial:{ends_at,days_left} }
 *   POST   /api/workforce-hires { worker, goal, context }   → hire a worker
 *   POST   /api/workforce-hires { action:'delegate', id, task }  → run a task on a hire
 *   PATCH  /api/workforce-hires { id, status?, goal? }      → pause/resume/edit
 *   DELETE /api/workforce-hires?id=...          → archive a hire
 */

import { env } from './_mcp-connectors.mjs';
import { tenantFromRequest } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

function creds() { return { url: env('SUPABASE_URL'), key: env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY') }; }
async function rest(path, init = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

function daysLeft(ends) {
  if (!ends) return null;
  return Math.max(0, Math.ceil((new Date(ends).getTime() - Date.now()) / 86400000));
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const ctx = await tenantFromRequest(req);
  if (!ctx?.tenant?.id) return json({ error: 'unauthorized' }, 401);
  const tenantId = ctx.tenant.id;

  // ── List ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const res = await rest(`workforce_hires?tenant_id=eq.${tenantId}&order=created_at.desc&select=*`);
      const hires = res.ok ? await res.json() : [];
      const tRes = await rest(`tenants?id=eq.${tenantId}&select=trial_ends_at,plan,status&limit=1`);
      const t = tRes.ok ? (await tRes.json())[0] : null;
      return json({ hires, trial: { ends_at: t?.trial_ends_at || null, days_left: daysLeft(t?.trial_ends_at), plan: t?.plan, status: t?.status } });
    } catch (e) {
      console.error('[workforce-hires] list', e.message);
      return json({ hires: [], trial: null });
    }
  }

  // ── Hire / delegate ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let b = {}; try { b = await req.json(); } catch {}

    if (b.action === 'delegate') {
      const id = b.id, task = (b.task || '').trim();
      if (!id || !task) return json({ error: 'id and task required' }, 400);
      // Confirm the hire belongs to this tenant.
      const hRes = await rest(`workforce_hires?id=eq.${id}&tenant_id=eq.${tenantId}&select=*&limit=1`);
      const hire = hRes.ok ? (await hRes.json())[0] : null;
      if (!hire) return json({ error: 'not found' }, 404);
      // Run the task through the shared workforce engine (best-effort).
      let result = null;
      try {
        const origin = new URL(req.url).origin;
        const exec = await fetch(`${origin}/api/workforce`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'execute', agent: hire.worker_id, objective: task, context: { tenant_id: tenantId, goal: hire.goal, company: hire.company } }),
        });
        result = await exec.json().catch(() => null);
      } catch (e) { console.warn('[workforce-hires] delegate exec', e.message); }
      await rest(`workforce_hires?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ last_activity: `Task: ${task.slice(0, 80)}`, last_active_at: new Date().toISOString() }) });
      return json({ ok: true, result });
    }

    const worker = b.worker || {};
    const workerId = (worker.id || b.worker_id || '').trim();
    if (!workerId) return json({ error: 'worker required' }, 400);
    const row = {
      tenant_id: tenantId,
      worker_id: workerId,
      name: worker.name || b.name || workerId,
      title: worker.title || b.title || null,
      avatar: worker.avatar || null,
      goal: (b.goal || '').trim() || null,
      context: (b.context || '').trim() || null,
      company: (b.company || ctx.tenant.name || '').trim() || null,
      status: 'active',
      last_activity: 'Hired',
      last_active_at: new Date().toISOString(),
    };
    const res = await rest('workforce_hires', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (!res.ok) return json({ error: `Could not hire: ${res.status}` }, 502);
    return json({ ok: true, hire: (await res.json())[0] });
  }

  // ── Edit / pause / resume ───────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    let b = {}; try { b = await req.json(); } catch {}
    if (!b.id) return json({ error: 'id required' }, 400);
    const patch = {};
    if (b.status && ['active', 'paused', 'archived'].includes(b.status)) patch.status = b.status;
    if (typeof b.goal === 'string') patch.goal = b.goal.trim();
    if (typeof b.context === 'string') patch.context = b.context.trim();
    if (!Object.keys(patch).length) return json({ error: 'nothing to update' }, 400);
    const res = await rest(`workforce_hires?id=eq.${b.id}&tenant_id=eq.${tenantId}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    if (!res.ok) return json({ error: `Update failed: ${res.status}` }, 502);
    const rows = await res.json();
    if (!rows.length) return json({ error: 'not found' }, 404);
    return json({ ok: true, hire: rows[0] });
  }

  // ── Archive ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return json({ error: 'id required' }, 400);
    const res = await rest(`workforce_hires?id=eq.${id}&tenant_id=eq.${tenantId}`, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) });
    return json({ ok: res.ok });
  }

  return json({ error: 'method not allowed' }, 405);
};

export const config = { path: '/api/workforce-hires' };
