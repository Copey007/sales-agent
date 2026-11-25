/**
 * Panel-only A-Gent brain for the Chrome side panel.
 *
 * POST /api/avatar-chat
 *   { session_row, messages: [{ role: 'user'|'assistant', content }] }
 *
 * Requires a live (active) avatar session. The agent slug and tenant come
 * from that row, not from the client. Caps, cool-down and the per-session
 * max therefore bound LLM spend. Never writes to agent_memory, and never
 * logs message bodies. Fails closed.
 */

import { getSession, getAgentBySlug } from './_avatar-store.mjs';
import { getAvatarCaps, sessionOverMax } from './_avatar-caps.mjs';
import { initConnectors, invoke } from './_mcp-connectors.mjs';
import { withCors } from './_auth.mjs';
import { sanitizeChatMessages } from './_chat-input.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });

function sessionRowId(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  if (typeof raw === 'object' && raw.id) return String(raw.id);
  return null;
}

async function resolvePrompt(slug) {
  const agent = await getAgentBySlug(slug);
  if (!agent || agent.status !== 'active') return null;
  let prompt = agent.system_prompt || `You are ${agent.name || 'A-Gent'}, an AI sales assistant.`;
  if (agent.knowledge) prompt += `\n\nKnowledge base (use when relevant, never invent beyond it):\n${agent.knowledge}`;
  prompt += '\n\nKeep replies to 2-3 sentences and always move the conversation forward with a question.';
  return { prompt, agent };
}

const __handler = async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...cors, Allow: 'POST' },
    });
  }

  let body = {};
  try { body = await req.json(); } catch { body = {}; }

  const id = sessionRowId(body.session_row ?? body.session_id);
  if (!id) return json({ error: 'unauthorized', reason: 'session_required' }, 401);

  const cleaned = sanitizeChatMessages(body.messages);
  if (cleaned.error) return json({ error: cleaned.error }, cleaned.status);

  let row;
  try {
    row = await getSession(id);
  } catch (err) {
    console.error('[avatar-chat] session lookup failed:', err.message);
    return json({ error: 'usage_store_unavailable' }, 503);
  }
  if (!row) return json({ error: 'session_not_found' }, 404);
  if (row.status !== 'active') return json({ error: 'session_not_active' }, 409);

  const slug = row.agent_slug;
  if (!slug) return json({ error: 'session_not_found' }, 404);

  let agentWrap;
  try {
    agentWrap = await resolvePrompt(slug);
  } catch (err) {
    console.error('[avatar-chat] agent lookup failed:', err.message);
    return json({ error: 'usage_store_unavailable' }, 503);
  }
  if (!agentWrap) return json({ error: 'agent_unavailable' }, 403);

  const caps = getAvatarCaps(agentWrap.agent);
  if (sessionOverMax({
    startedAt: row.started_at,
    durationSeconds: row.duration_seconds,
    maxSessionSeconds: caps.maxSessionSeconds,
  })) {
    return json({ error: 'session_expired' }, 409);
  }

  // Ignore any client-supplied slug or tenant; the live row is the source of truth.
  void body.slug;

  try {
    initConnectors();
    const response = await invoke('llm', 'chat', {
      messages: [
        { role: 'system', content: agentWrap.prompt },
        ...cleaned.messages,
      ],
      temperature: 0.7,
      maxTokens: 300,
    });
    const reply = String(response?.content || '').trim();
    if (!reply) return json({ error: 'llm_unavailable' }, 503);
    return json({ reply, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[avatar-chat] llm failed:', err.message);
    return json({ error: 'llm_unavailable' }, 503);
  }
};

export const config = {
  path: '/api/avatar-chat',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

export default withCors(__handler);
