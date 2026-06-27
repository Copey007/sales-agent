/**
 * Public per-tenant agent config for the hosted avatar page.
 *
 * GET /api/agent-config?slug=<slug>
 *   → { config: { slug, name, mode, greeting, chips, theme } }   (no secrets)
 *
 * The browser renders branding + greeting + chips from this. Prompts, keys,
 * and limits stay server-side.
 */

import { getAgentBySlug, toPublicConfig } from './_avatar-store.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') || 'demo';

  try {
    const agent = await getAgentBySlug(slug);
    if (!agent) return json({ error: 'agent_not_found', slug }, 404);
    if (agent.status !== 'active') return json({ error: 'agent_unavailable', status: agent.status }, 403);
    return json({ config: toPublicConfig(agent) });
  } catch (err) {
    console.error('[agent-config]', err.message);
    return json({ error: err.message }, 500);
  }
};

export const config = { path: '/api/agent-config' };
