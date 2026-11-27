/**
 * A-Gent Concierge API (Phase 3 — 1Mind Competitor)
 * 
 * An autonomous inbound concierge widget that:
 *   - Greets website visitors
 *   - Qualifies leads via natural conversation (GAP methodology informed)
 *   - Answers questions about A-Gent using stored knowledge
 *   - Captures email/company for CRM
 *   - Speaks responses via TTS (optional, client requests audio)
 *   - Feeds qualified leads directly into Supabase
 * 
 * Endpoints:
 *   POST /api/concierge  { action: "chat", messages, sessionId, speak }
 *   POST /api/concierge  { action: "start", visitorInfo }
 *   POST /api/concierge  { action: "qualify", sessionId }
 *   GET  /api/concierge  — health check
 *
 * Anonymous callers may only use public slugs (default: a-gent, demo).
 * Chat input is capped and limited to user/assistant roles. Conversation
 * text is not written to agent_memory.
 */

import { initConnectors, invoke, env } from './_mcp-connectors.mjs';
import { getAgentBySlug } from './_avatar-store.mjs';
import { withCors } from './_auth.mjs';
import { sanitizeChatMessages, isPublicConciergeSlug } from './_chat-input.mjs';
import { requireNonEmptyLlmText, isLlmEmptyReplyError, isLlmConfigIncompleteError, isLlmUpstreamError, redactSecrets } from './_llm.mjs';

/**
 * Resolve the system prompt + scoping for a given agent slug. Per-tenant
 * agents bring their own persona + knowledge; absent a slug we fall back to
 * the built-in A-Gent prompt so existing callers keep working.
 */
async function resolveAgent(slug) {
  if (!slug) return { systemPrompt: SYSTEM_PROMPT, accountId: 'a-gent', name: 'A-Gent' };
  try {
    const agent = await getAgentBySlug(slug);
    if (agent && agent.system_prompt) {
      let prompt = agent.system_prompt;
      if (agent.knowledge) prompt += `\n\nKnowledge base (use when relevant, never invent beyond it):\n${agent.knowledge}`;
      prompt += '\n\nKeep replies to 2-3 sentences and always move the conversation forward with a question.';
      return { systemPrompt: prompt, accountId: agent.slug, name: agent.name };
    }
  } catch (e) {
    console.warn('[concierge] agent resolve failed, using default:', e.message);
  }
  return { systemPrompt: SYSTEM_PROMPT, accountId: slug || 'a-gent', name: 'A-Gent' };
}

const __handler = async (req, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method === 'GET') {
    return new Response(JSON.stringify({ 
      status: 'online', 
      service: 'A-Gent Concierge',
      capabilities: ['chat', 'voice', 'lead_qualification', 'crm_capture'],
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  try {
    initConnectors();

    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const action = body.action || 'chat';

    switch (action) {
      case 'start':
        return await handleStart(body, corsHeaders);
      case 'chat':
        return await handleChat(body, corsHeaders, req);
      case 'qualify':
        return await handleQualify(body, corsHeaders, req);
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
  } catch (err) {
    if (isLlmConfigIncompleteError(err)) {
      return new Response(JSON.stringify({ error: 'llm_config_incomplete' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    if (isLlmUpstreamError(err)) {
      // Status + allowlisted type only. Never include upstream message/body.
      return new Response(JSON.stringify({
        error: 'llm_upstream_error',
        status: err.status || 0,
        type: err.upstreamType || null,
      }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    console.error('[concierge] Error:', redactSecrets(err.message), redactSecrets(err.stack || ''));
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/concierge", rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

// ─── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the A-Gent Concierge — an autonomous AI sales assistant on the A-Gent.co website.

Your personality: confident, approachable, professional B2B SaaS. You speak like a knowledgeable revenue leader, not a chatbot.

Your job:
1. Greet visitors warmly and ask what brings them to A-Gent
2. Qualify them naturally — discover their role, company, and sales challenge
3. Explain A-Gent's capabilities (autonomous AI sales agents that detect buying signals and run outbound sequences)
4. If they're a good fit (B2B company, sales/revenue role, need pipeline), capture their email and company
5. Offer to connect them with the team or start a trial

A-Gent key facts:
- AI sales agents that detect buying signals (job changes, hiring spikes, funding)
- Autonomous outbound email sequences via Resend
- Multi-agent workforce: Researcher, SDR, Ops, Support, Success
- GAP methodology for cold email
- Mission Control dashboard for campaign orchestration
- Early-stage, building rapidly

Rules:
- Keep responses SHORT (2-3 sentences max in chat)
- Always ask a question to keep the conversation moving
- Never make up features that don't exist
- If they ask about pricing, say "We're in early access and working with founding partners on custom pricing"
- If they're ready to talk, capture email + company and say we'll be in touch within 24h
- Match the visitor's energy — casual if they're casual, formal if formal`;

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function handleStart(body, corsHeaders) {
  const { visitorInfo = {} } = body;
  const sessionId = `concierge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Generate a personalized greeting
  const greetingResult = await invoke('llm', 'chat', {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `A new visitor has arrived. ${visitorInfo.referrer ? 'They came from ' + String(visitorInfo.referrer).slice(0, 200) + '.' : ''} ${visitorInfo.page ? 'They are on the ' + String(visitorInfo.page).slice(0, 200) + ' page.' : ''} Greet them naturally and ask what brings them to A-Gent today.` }
    ],
    temperature: 0.7,
    maxTokens: 200
  });

  let greeting;
  try {
    greeting = requireNonEmptyLlmText(greetingResult, 'concierge');
  } catch (e) {
    if (isLlmEmptyReplyError(e)) {
      return new Response(JSON.stringify({ error: 'llm_empty_reply' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    if (isLlmConfigIncompleteError(e)) {
      return new Response(JSON.stringify({ error: 'llm_config_incomplete' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    throw e;
  }

  // Do not persist visitorInfo or a session transcript to agent_memory.

  return new Response(JSON.stringify({
    sessionId,
    greeting,
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleChat(body, corsHeaders, req) {
  const { sessionId, speak = false, slug = null } = body;
  // visitorEmail is ignored for anonymous callers: it used to trigger a
  // memory-store text search on "concierge" that leaked other visitors' notes.

  // Anonymous website visitors may only talk to public agents.
  if (slug && !isPublicConciergeSlug(slug)) {
    return new Response(JSON.stringify({ error: 'agent_not_found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const cleaned = sanitizeChatMessages(body.messages);
  if (cleaned.error) {
    return new Response(JSON.stringify({ error: cleaned.error }), {
      status: cleaned.status, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  const messages = cleaned.messages;

  // Public slug or built-in A-Gent prompt only — never a private tenant prompt.
  const { systemPrompt, accountId } = await resolveAgent(slug && isPublicConciergeSlug(slug) ? slug : null);

  // Build the conversation. Do not read agent_memory for anonymous callers.
  const llmMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role: m.role || 'user',
      content: m.content
    }))
  ];

  // Generate response
  const response = await invoke('llm', 'chat', {
    messages: llmMessages,
    temperature: 0.7,
    maxTokens: 300
  });

  let reply;
  try {
    reply = requireNonEmptyLlmText(response, 'concierge');
  } catch (e) {
    if (isLlmEmptyReplyError(e)) {
      return new Response(JSON.stringify({ error: 'llm_empty_reply' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    if (isLlmConfigIncompleteError(e)) {
      return new Response(JSON.stringify({ error: 'llm_config_incomplete' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    throw e;
  }

  // Server-side lead capture from the conversation text only. A client
  // visitorEmail field is ignored. Failures here must not break the chat.
  try {
    await captureLeadFromMessages(messages, { sessionId, slug, req });
  } catch (e) {
    console.warn('[concierge] Lead capture failed:', e.message);
  }

  // Do not write conversation text to agent_memory. Transcripts are not
  // stored server-side for anonymous concierge chats.

  // Generate TTS if requested
  let audio = null;
  if (speak) {
    try {
      const ttsResult = await invoke('tts', 'speak', { text: reply, voice: 'alloy' });
      audio = ttsResult.audio;
    } catch (e) {
      console.warn('[concierge] TTS failed:', e.message);
    }
  }

  return new Response(JSON.stringify({
    reply,
    audio,
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleQualify(body, corsHeaders, req) {
  const { sessionId } = body;

  const cleaned = sanitizeChatMessages(body.messages);
  if (cleaned.error) {
    return new Response(JSON.stringify({ error: cleaned.error }), {
      status: cleaned.status, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  const messages = cleaned.messages;

  // Use LLM to extract qualification data from conversation
  const qualification = await invoke('llm', 'chat', {
    messages: [
      {
        role: 'system',
        content: `Analyze this sales conversation and extract qualification data. Return ONLY valid JSON:
{
  "qualified": true/false,
  "name": "visitor name or null",
  "email": "visitor email or null", 
  "company": "company name or null",
  "role": "their role/title or null",
  "pain_point": "their main sales challenge or null",
  "fit": "good|maybe|poor",
  "next_step": "what to do next"
}`
      },
      { role: 'user', content: JSON.stringify(messages) }
    ],
    temperature: 0.2,
    maxTokens: 400
  });

  let qualificationText;
  try {
    qualificationText = requireNonEmptyLlmText(qualification, 'concierge');
  } catch (e) {
    if (isLlmEmptyReplyError(e)) {
      return new Response(JSON.stringify({ error: 'llm_empty_reply' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    if (isLlmConfigIncompleteError(e)) {
      return new Response(JSON.stringify({ error: 'llm_config_incomplete' }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    throw e;
  }

  let result;
  try {
    result = JSON.parse(qualificationText.replace(/```json\s*/gi, '').replace(/```/g, ''));
  } catch {
    result = { qualified: false, fit: 'unknown', next_step: 'Continue conversation' };
  }

  // Capture uses an email extracted from the conversation, never a client field
  // and never an LLM-invented address that was not in the visitor's messages.
  try {
    await captureLeadFromMessages(messages, {
      sessionId,
      slug: body.slug,
      name: result.name,
      company: result.company,
      req,
    });
  } catch (e) {
    console.warn('[concierge] Lead capture failed:', e.message);
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const MAX_EMAIL_LEN = 254;
const EMAIL_FIND_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EMAIL_VALID_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** Lowercase, trim, length-check. Returns null if not a single sane address. */
export function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s.length > MAX_EMAIL_LEN) return null;
  if (!EMAIL_VALID_RE.test(s)) return null;
  return s;
}

/** Last valid email found in user (visitor) messages. Ignores assistant text. */
export function extractVisitorEmail(messages) {
  let found = null;
  for (const m of messages || []) {
    if (m?.role !== 'user') continue;
    const hits = String(m.content || '').match(EMAIL_FIND_RE) || [];
    for (const raw of hits) {
      const normalized = normalizeEmail(raw);
      if (normalized) found = normalized;
    }
  }
  return found;
}

const LEAD_IP_WINDOW_SECONDS = 3600;
const LEAD_IP_MAX = 1;

/** Test hook: inject a Map-like store (get/setJSON). Production uses Netlify Blobs. */
export const leadRate = {
  windowSeconds: LEAD_IP_WINDOW_SECONDS,
  max: LEAD_IP_MAX,
  store: null,
};

export function memoryLeadRateStore() {
  const data = new Map();
  return {
    async get(key, opts = {}) {
      const v = data.get(key);
      if (v == null) return null;
      if (opts.type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return v;
    },
    async setJSON(key, value) { data.set(key, value); },
    async set(key, value) { data.set(key, value); },
  };
}

function clientIp(req) {
  // Platform-assigned connection IP only. Spoofable x-forwarded-for is ignored,
  // matching the avatar-token rate-limit pattern.
  if (!req?.headers?.get) return '';
  return String(req.headers.get('x-nf-client-connection-ip') || '').trim();
}

function leadRateKey(ip) {
  return `lead:${ip}`;
}

/** Escape ILIKE / PostgREST wildcards so the lookup is an exact, case-insensitive match. */
export function escapeIlikeExact(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/[%_*]/g, '\\$&');
}

async function loadLeadRateStore() {
  if (leadRate.store) return leadRate.store;
  try {
    const { getStore } = await import('@netlify/blobs');
    leadRate.store = getStore('concierge_lead_ip');
    return leadRate.store;
  } catch (e) {
    console.warn('[concierge] lead rate store unavailable:', e.message);
    return null;
  }
}

async function recentLeadCaptureCountByIp(ip, seconds = LEAD_IP_WINDOW_SECONDS) {
  if (!ip) return 0;
  const store = await loadLeadRateStore();
  if (!store) throw new Error('lead rate store unavailable');
  const rec = await store.get(leadRateKey(ip), { type: 'json' });
  if (!rec?.at) return 0;
  const ts = Date.parse(rec.at);
  if (!Number.isFinite(ts)) return 0;
  return (Date.now() - ts) < seconds * 1000 ? 1 : 0;
}

async function recordLeadCaptureIp(ip) {
  if (!ip) return;
  const store = await loadLeadRateStore();
  if (!store) return;
  const payload = { at: new Date().toISOString() };
  if (typeof store.setJSON === 'function') await store.setJSON(leadRateKey(ip), payload);
  else await store.set(leadRateKey(ip), JSON.stringify(payload));
}

/**
 * Insert a contacts row for an email found in the conversation.
 * Dedupes by email (case-insensitive at query time) so the same address is
 * not re-submitted. At most one new capture per connection IP per hour.
 * Never writes agent_memory.
 */
async function captureLeadFromMessages(messages, { sessionId = null, slug = null, name = null, company = null, req = null } = {}) {
  const email = extractVisitorEmail(messages);
  if (!email) return { captured: false, reason: 'no_email' };

  const { url, key } = getSupabaseCreds();
  if (!url || !key) return { captured: false, reason: 'store_unavailable' };

  const ip = clientIp(req);
  if (ip && await recentLeadCaptureCountByIp(ip) >= LEAD_IP_MAX) {
    return { captured: false, reason: 'rate_limited' };
  }

  const headers = {
    'apikey': key, 'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  // Case-insensitive exact match at query time (no migration). Escape ILIKE wildcards.
  const params = new URLSearchParams();
  params.set('email', `ilike.${escapeIlikeExact(email)}`);
  params.set('select', 'id,email,source');
  params.set('limit', '20');
  const existingRes = await fetch(`${url}/rest/v1/contacts?${params}`, { headers });
  if (!existingRes.ok) {
    throw new Error(`contacts lookup failed: ${existingRes.status}`);
  }
  const existing = await existingRes.json();
  // Dedupe by email so the same address is not re-submitted (per session/agent
  // and globally once it is already on the contacts table).
  const already = (existing || []).some((row) => normalizeEmail(row.email) === email);
  if (already) return { captured: false, reason: 'duplicate' };
  void sessionId;
  void slug;

  const displayName = name || extractName(messages);
  const companyName = company || extractCompany(messages);
  const insertRes = await fetch(`${url}/rest/v1/contacts`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      email,
      name: displayName || null,
      company_name: companyName || null,
      source: 'signup:concierge',
    }),
  });
  if (!insertRes.ok) {
    throw new Error(`contacts insert failed: ${insertRes.status}`);
  }
  await recordLeadCaptureIp(ip);
  return { captured: true, email };
}

function getSupabaseCreds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') /* service role only — no anon fallback */;
  return { url, key };
}

function extractCompany(messages) {
  for (const m of messages) {
    const match = (m.content || '').match(/(?:at|work at|company is|from)\s+([A-Z][a-zA-Z0-9\s]+)/);
    if (match) return match[1].trim();
  }
  return null;
}

function extractName(messages) {
  for (const m of messages) {
    const match = (m.content || '').match(/(?:I'm|I am|name is|this is)\s+([A-Z][a-zA-Z]+)/);
    if (match) return match[1];
  }
  return null;
}

// Security wrapper: allowlisted CORS (2026-11 lockdown).
export default withCors(__handler);
