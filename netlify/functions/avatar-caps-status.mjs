/**
 * Read-only avatar cap / cool-down status. Does not mint or stop a session.
 *
 * GET /api/avatar-caps?slug=demo
 *   → usage, reset_at, cooldown, and whether a new session may be started
 *
 * GET-only (plus OPTIONS). POST and other methods return 405 and never
 * call LiveAvatar.
 */

import { getAgentBySlug, monthlyUsageSeconds, cooldownRemainingSeconds } from './_avatar-store.mjs';
import { getAvatarCaps, billingWindow } from './_avatar-caps.mjs';
import { withCors } from './_auth.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

function clientIp(req) {
  const raw = req.headers.get('x-nf-client-connection-ip') || '';
  return raw.split(',')[0].trim() || null;
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors, Allow: 'GET' },
    });
  }

  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') || 'demo';
  const ip = clientIp(req);

  let agent;
  try {
    agent = await getAgentBySlug(slug);
  } catch (err) {
    return json({ error: 'usage_store_unavailable' }, 503);
  }
  if (!agent) return json({ error: 'agent_not_found', slug }, 404);
  if (agent.status !== 'active') return json({ error: 'agent_unavailable', status: agent.status }, 403);

  const caps = getAvatarCaps(agent);
  try {
    const usedMin = (await monthlyUsageSeconds(slug)) / 60;
    const coolLeft = await cooldownRemainingSeconds({ ip, slug, cooldownSeconds: caps.cooldownSeconds });
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
    });
  } catch (err) {
    console.error('[avatar-caps] usage lookup failed:', err.message);
    return json({ error: 'usage_store_unavailable' }, 503);
  }
};

export const config = { path: '/api/avatar-caps', rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

export default withCors(__handler);
