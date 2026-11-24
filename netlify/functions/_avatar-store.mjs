/**
 * Avatar store — Supabase data layer for the multi-tenant avatar module.
 *
 * Powers per-tenant config, concurrency caps, usage metering (billing),
 * per-IP rate limiting, and stale-session cleanup. Uses the same Supabase
 * REST pattern as _supabase-memory.mjs (service-role key, PostgREST).
 */

import { env, initConnectors } from './_mcp-connectors.mjs';

let _init = false;
function ensureInit() { if (!_init) { initConnectors(); _init = true; } }

function creds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') /* service role only — no anon fallback */;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  return { url, key };
}
function headers(extra = {}) {
  const { key } = creds();
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}
async function rest(path, init = {}) {
  ensureInit();
  const { url } = creds();
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  return res;
}

// ─── Agent config ───────────────────────────────────────────────────────────

export async function getAgentBySlug(slug) {
  if (!slug) return null;
  const res = await rest(`avatar_agents?slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (!res.ok) {
    if (res.status === 404) return null; // table not created yet
    throw new Error(`getAgentBySlug failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

/** Public-safe subset for the browser — never leak prompts/keys/limits internals. */
export function toPublicConfig(agent) {
  if (!agent) return null;
  const theme = agent.theme || {};
  return {
    slug: agent.slug,
    name: agent.name,
    status: agent.status,
    mode: agent.mode,
    greeting: agent.greeting,
    chips: agent.chips || [],
    slides: agent.slides || [],
    theme: {
      primary_color: theme.primary_color || '#c9a227',
      headline: theme.headline || `Talk to ${agent.name}`,
      subcopy: theme.subcopy || '',
      logo_url: theme.logo_url || 'assets/agent-logo.svg',
      og_image: theme.og_image || null,
    },
  };
}

// ─── Concurrency / usage / rate limiting ────────────────────────────────────

export async function countActiveSessions(slug) {
  const res = await rest(
    `avatar_sessions?agent_slug=eq.${encodeURIComponent(slug)}&status=eq.active&select=id&limit=1000`
  );
  if (!res.ok) return 0;
  return (await res.json()).length;
}

/** Total session-seconds this calendar month for the agent (billing/cap basis). */
export async function monthlyUsageSeconds(slug) {
  const start = new Date();
  const monthStart = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00Z`;
  const res = await rest(
    `avatar_sessions?agent_slug=eq.${encodeURIComponent(slug)}&started_at=gte.${monthStart}&select=duration_seconds&limit=100000`
  );
  if (!res.ok) return 0;
  const rows = await res.json();
  return rows.reduce((s, r) => s + (r.duration_seconds || 0), 0);
}

/** Sessions started by an IP within the last `seconds` (abuse throttle). */
export async function recentSessionCountByIp(ip, seconds = 60) {
  if (!ip) return 0;
  const since = new Date(Date.now() - seconds * 1000).toISOString();
  const res = await rest(
    `avatar_sessions?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${since}&select=id&limit=100`
  );
  if (!res.ok) return 0;
  return (await res.json()).length;
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

export async function createSession({ slug, tenantId = null, liveavatarSessionId = null, ip = null }) {
  const res = await rest('avatar_sessions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      agent_slug: slug,
      tenant_id: tenantId,
      liveavatar_session_id: liveavatarSessionId,
      ip,
      status: 'active',
    }),
  });
  if (!res.ok) {
    console.warn('[avatar-store] createSession failed:', res.status, await res.text());
    return null;
  }
  return (await res.json())[0];
}

export async function endSession({ id, durationSeconds = 0, status = 'ended' }) {
  if (!id) return null;
  const res = await rest(`avatar_sessions?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status,
      duration_seconds: Math.max(0, Math.round(durationSeconds)),
      ended_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
    }),
  });
  if (!res.ok) return null;
  return (await res.json())[0];
}

export async function heartbeat({ id, durationSeconds = null }) {
  if (!id) return null;
  const patch = { last_heartbeat: new Date().toISOString() };
  if (durationSeconds != null) patch.duration_seconds = Math.max(0, Math.round(durationSeconds));
  const res = await rest(`avatar_sessions?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return res.ok;
}

/**
 * Close sessions that are still 'active' but exceeded the hard cap or went
 * silent (no heartbeat). Prevents abandoned tabs from holding a concurrency
 * seat or silently accruing cost. Returns the number reaped.
 */
export async function reapStaleSessions({ maxSessionMinutes = 30, heartbeatTimeoutMinutes = 3 } = {}) {
  const hardCutoff = new Date(Date.now() - maxSessionMinutes * 60000).toISOString();
  const idleCutoff = new Date(Date.now() - heartbeatTimeoutMinutes * 60000).toISOString();
  // active AND (started before hardCutoff OR last_heartbeat before idleCutoff)
  const filter =
    `status=eq.active&or=(started_at.lt.${hardCutoff},last_heartbeat.lt.${idleCutoff})` +
    `&select=id,started_at,last_heartbeat,duration_seconds`;
  const res = await rest(`avatar_sessions?${filter}&limit=500`);
  if (!res.ok) return 0;
  const stale = await res.json();
  let reaped = 0;
  for (const s of stale) {
    // best-effort duration: prefer recorded duration, else elapsed wall time
    const elapsed = (Date.now() - new Date(s.started_at).getTime()) / 1000;
    const dur = Math.max(s.duration_seconds || 0, 0) || elapsed;
    const ok = await endSession({ id: s.id, durationSeconds: dur, status: 'reaped' });
    if (ok) reaped++;
  }
  return reaped;
}
