/**
 * Idempotent migration runner for the avatar module schema.
 * Applies netlify/functions/avatar-schema.sql via Supabase exec_sql.
 *
 * POST /api/setup-avatar  { secret }
 *   secret must equal env SETUP_SECRET (fail-closed — no default).
 *
 * Safe to leave deployed: it refuses to run unless SETUP_SECRET is set AND
 * matches. CREATE ... IF NOT EXISTS makes re-runs harmless.
 */
import { env } from './_mcp-connectors.mjs';
import { withCors, safeEqual } from './_auth.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });

  const setupSecret = env('SETUP_SECRET');
  if (!setupSecret) return json({ error: 'SETUP_SECRET not configured (fail-closed)' }, 503);

  let body = {};
  try { body = await req.json(); } catch {}
  if (!safeEqual(String(body.secret || ''), setupSecret)) return json({ error: 'unauthorized' }, 401);

  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({ error: 'missing supabase creds' }, 500);

  const fs = await import('fs');
  const path = await import('path');
  const sqlPath = path.join(process.cwd(), 'netlify', 'functions', 'avatar-schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const exec = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const execBody = await exec.text();

  const verify = await fetch(`${url}/rest/v1/avatar_agents?select=slug,name,status`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const agents = verify.ok ? await verify.json() : null;

  return json({
    exec_status: exec.status,
    exec_body: execBody.slice(0, 300),
    verify_status: verify.status,
    agents,
  });
};

export const config = { path: '/api/setup-avatar', rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
