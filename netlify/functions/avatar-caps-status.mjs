/**
 * Read-only avatar cap / cool-down status. Does not mint or stop a session.
 *
 * GET /api/avatar-caps?slug=demo
 *   → usage, reset_at, cooldown, can_buy, and whether a new session may be started
 *
 * Requires a signed-in tenant member (or operator). Results are scoped to
 * the caller's tenant. GET-only (plus OPTIONS). POST and other methods
 * return 405 and never call LiveAvatar. Never returns admin email addresses.
 */

import { getAgentBySlug, monthlyUsageSeconds, cooldownRemainingSeconds } from './_avatar-store.mjs';
import { getAvatarCaps, billingWindow } from './_avatar-caps.mjs';
import { withCors } from './_auth.mjs';
import { resolveTenantContext, canAccessTenant } from './_tenant.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors, Allow: 'GET' },
    });
  }

  const ctx = await resolveTenantContext(req);
  if (ctx.invalid) {
    return json({ error: ctx.status === 403 ? 'forbidden' : 'unauthorized', reason: ctx.reason }, ctx.status || 401);
  }
  if (ctx.internal) {
    return json({ error: 'forbidden' }, 403);
  }

  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') || 'demo';

  let agent;
  try {
    agent = await getAgentBySlug(slug);
  } catch (err) {
    return json({ error: 'usage_store_unavailable' }, 503);
  }
  if (!agent) return json({ error: 'agent_not_found' }, 404);
  if (!canAccessTenant(ctx, agent.tenant_id)) {
    return json({ error: 'agent_not_found' }, 404);
  }
  if (agent.status !== 'active') return json({ error: 'agent_unavailable', status: agent.status }, 403);

  const caps = getAvatarCaps(agent);
  const canBuy = !!(ctx.operator || ctx.role === 'owner' || ctx.role === 'admin');
  try {
    const usedMin = (await monthlyUsageSeconds(slug)) / 60;
    const coolLeft = await cooldownRemainingSeconds({
      slug,
      tenantId: agent.tenant_id || null,
      cooldownSeconds: caps.cooldownSeconds,
    });
    const window = billingWindow(new Date(), caps.billingResetDay);
    const remaining = Math.max(0, caps.monthlyMinuteCap - usedMin);
    const capReached = usedMin >= caps.monthlyMinuteCap;
    return json({
      slug,
      monthly_minute_cap: caps.monthlyMinuteCap,
      used_minutes: usedMin,
      remaining_minutes: remaining,
      reset_at: window.resetAt.toISOString(),
      max_session_seconds: caps.maxSessionSeconds,
      cooldown_seconds: caps.cooldownSeconds,
      cooldown_remaining_seconds: coolLeft,
      available: !capReached && coolLeft <= 0,
      can_buy: canBuy,
    });
  } catch (err) {
    console.error('[avatar-caps] usage lookup failed:', err.message);
    return json({ error: 'usage_store_unavailable' }, 503);
  }
};

export const config = { path: '/api/avatar-caps', rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

export default withCors(__handler);
