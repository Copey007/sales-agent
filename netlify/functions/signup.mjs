/**
 * Self-serve signup — the front door to the multi-tenant product.
 *
 * POST /api/signup  { name, email, password, company, slug }
 *   1. creates a Supabase Auth user (confirmed)
 *   2. creates a tenant + owner membership
 *   3. enables the avatar module + creates a starter avatar agent
 *   → returns { agent_url, slug }  (their live /a/<slug> page)
 *
 * Public endpoint. Runs with the service-role key for the trusted writes.
 */

import { env } from './_mcp-connectors.mjs';
import { withCors } from './_auth.mjs';
import { operatorEmails } from './_tenant.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const RESERVED = new Set(['a-gent', 'agent', 'demo', 'acme', 'api', 'assets', 'admin', 'app', 'www', 'mail', 'support', 'help', 'login', 'signup', 'dashboard']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

// Default starter avatar (professional female) — customers can change it later.
const DEFAULT_AVATAR = '26393b8e-e944-4367-98ef-e2bc75c4b792';
const DEFAULT_VOICE = '864a26b8-bfba-4435-9cc5-1dd593de5ca7';

function creds() {
  return { url: env('SUPABASE_URL'), key: env('SUPABASE_SERVICE_ROLE_KEY') };
}
async function sb(url, key, path, body, prefer = 'return=representation') {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: prefer },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return null; }
}
async function slugTaken(url, key, table, slug) {
  const res = await fetch(`${url}/rest/v1/${table}?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return false;
  return (await res.json()).length > 0;
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  let b = {};
  try { b = await req.json(); } catch {}
  const name = (b.name || '').trim();
  const email = (b.email || '').trim().toLowerCase();
  const password = b.password || '';
  const company = (b.company || '').trim();
  const slug = (b.slug || '').trim().toLowerCase();
  // Optional: a worker the visitor configured on the marketplace before signing up.
  const worker = b.worker && typeof b.worker === 'object' ? b.worker : null;
  const workerGoal = (b.goal || '').trim();
  const workerContext = (b.context || '').trim();
  // Optional: the offer plan the visitor picked (offers-demo.html → ?plan=…).
  const plan = (b.plan || '').trim();

  // ── Validate ────────────────────────────────────────────────────────────
  if (!name || !company) return json({ error: 'Name and company are required.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email.' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
  if (!SLUG_RE.test(slug)) return json({ error: 'Pick a handle: 3–40 chars, lowercase letters, numbers, hyphens.' }, 400);
  if (RESERVED.has(slug)) return json({ error: `"${slug}" is reserved — please choose a different handle.` }, 409);
  // SECURITY: self-serve signup auto-confirms the email, so it must never mint
  // an account for a platform-operator address or the platform's own domain
  // (operator status is an explicit allowlist in _tenant.mjs, but block anyway).
  const domain = email.split('@')[1] || '';
  const blockedDomains = (env('SIGNUP_BLOCKED_DOMAINS') || 'a-gent.co').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (operatorEmails().has(email) || blockedDomains.some((d) => domain === d || domain.endsWith('.' + d))) {
    return json({ error: 'This email cannot be used for self-serve signup. Contact support.' }, 403);
  }

  const { url, key } = creds();
  if (!url || !key) return json({ error: 'Server not configured.' }, 500);

  try {
    if (await slugTaken(url, key, 'tenants', slug) || await slugTaken(url, key, 'avatar_agents', slug)) {
      return json({ error: `Handle "${slug}" is taken — try another.` }, 409);
    }

    // 1) Auth user (confirmed so they can log in immediately)
    const userRes = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name, company } }),
    });
    const userBody = await userRes.json().catch(() => ({}));
    if (!userRes.ok) {
      const msg = /already.+registered|exists/i.test(JSON.stringify(userBody)) ? 'That email is already registered.' : (userBody.msg || userBody.error_description || 'Could not create account.');
      return json({ error: msg }, userRes.status === 422 ? 409 : 400);
    }
    const userId = userBody.id || userBody.user?.id;

    // 2) Tenant + owner membership
    const tenant = (await sb(url, key, 'tenants', { slug, name: company, plan: plan || 'trial', status: 'active' }))[0];
    await sb(url, key, 'memberships', { tenant_id: tenant.id, user_id: userId, role: 'owner' }, 'return=minimal');

    // 2b) Start the 15-day trial clock (best-effort — column added by workforce-schema.sql).
    //     Matches the Stripe trial (billing-checkout trial_period_days) + all signup copy.
    const TRIAL_DAYS = 15;
    const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
    try {
      await fetch(`${url}/rest/v1/tenants?id=eq.${tenant.id}`, {
        method: 'PATCH',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ trial_ends_at: trialEnds }),
      });
    } catch (e) { console.warn('[signup] trial_ends_at:', e.message); }

    // 3) Avatar module entitlement + starter agent
    await sb(url, key, 'tenant_modules',
      { tenant_id: tenant.id, module: 'avatar', enabled: true, limits: { monthly_minutes: 100, max_concurrent: 2 } },
      'return=minimal');
    await sb(url, key, 'avatar_agents', {
      slug, tenant_id: tenant.id, name: company, status: 'active',
      avatar_id: DEFAULT_AVATAR, voice_id: DEFAULT_VOICE, mode: 'FULL',
      system_prompt: `You are ${company}'s live AI agent. Greet visitors warmly, answer questions about ${company}, qualify interest, and offer to book a demo or connect them with the team. Keep replies to 2–3 sentences and always move the conversation forward.`,
      greeting: `Hi! I'm ${company}'s AI agent — ask me anything, and I'll answer in real time.`,
      chips: [`What does ${company} do?`, 'How does this work?', 'Book a demo'],
      theme: { primary_color: '#c9a227', headline: `Talk to ${company}'s AI Agent`, subcopy: 'Ask anything — answered live, in real time.' },
      max_concurrent: 2, monthly_minute_cap: 100,
    }, 'return=minimal');

    // 4) If they configured a worker on the marketplace, persist the hire + enable
    //    the matching module so it shows up in Mission Control → Workforce. Best-effort.
    let hired = null;
    if (worker?.id) {
      const MODULE_MAP = { researcher: 'researcher', sdr: 'sdr', social: 'social', ops: 'sdr', support: 'concierge', success: 'crm', manager: 'workforce' };
      const mod = MODULE_MAP[worker.id] || 'workforce';
      try {
        await sb(url, key, 'tenant_modules', { tenant_id: tenant.id, module: mod, enabled: true }, 'return=minimal').catch(() => {});
        const row = await sb(url, key, 'workforce_hires', {
          tenant_id: tenant.id,
          worker_id: worker.id,
          name: worker.name || worker.id,
          title: worker.title || null,
          avatar: worker.avatar || null,
          goal: workerGoal || null,
          context: workerContext || null,
          company,
          status: 'active',
          last_activity: 'Hired',
          last_active_at: new Date().toISOString(),
        });
        hired = Array.isArray(row) ? row[0] : row;
      } catch (e) { console.warn('[signup] hire persist:', e.message); }
    }

    return json({ ok: true, slug, agent_url: `https://aisdr.a-gent.co/a/${slug}`, trial_ends_at: trialEnds, hired: !!hired });
  } catch (err) {
    console.error('[signup]', err.message);
    return json({ error: 'Something went wrong creating your account. Please try again.' }, 500);
  }
};

export const config = { path: '/api/signup', rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
