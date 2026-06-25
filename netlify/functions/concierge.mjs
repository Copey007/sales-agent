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
 */

import { initConnectors, invoke, env } from './_mcp-connectors.mjs';
import { remember, recall } from './_supabase-memory.mjs';

export default async (req, context) => {
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
        return await handleChat(body, corsHeaders);
      case 'qualify':
        return await handleQualify(body, corsHeaders);
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
  } catch (err) {
    console.error('[concierge] Error:', err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/concierge" };

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
      { role: 'user', content: `A new visitor has arrived. ${visitorInfo.referrer ? 'They came from ' + visitorInfo.referrer + '.' : ''} ${visitorInfo.page ? 'They are on the ' + visitorInfo.page + ' page.' : ''} Greet them naturally and ask what brings them to A-Gent today.` }
    ],
    temperature: 0.7,
    maxTokens: 200
  });

  const greeting = greetingResult.content;

  // Store session start as a memory
  try {
    await remember({
      agentId: 'concierge',
      memoryType: 'note',
      content: `New concierge session ${sessionId} started. Visitor: ${JSON.stringify(visitorInfo)}`,
      metadata: { sessionId, visitorInfo },
      embed: false
    });
  } catch (e) {
    console.warn('[concierge] Memory store failed:', e.message);
  }

  return new Response(JSON.stringify({
    sessionId,
    greeting,
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleChat(body, corsHeaders) {
  const { messages = [], sessionId, speak = false, visitorEmail } = body;

  if (!messages.length) {
    return new Response(JSON.stringify({ error: 'messages array is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // Recall any previous context about this visitor
  let contextMemories = [];
  if (visitorEmail) {
    try {
      contextMemories = await recall({
        query: `concierge conversation with ${visitorEmail}`,
        matchCount: 3,
        agentId: 'concierge'
      });
    } catch (e) {
      // Non-fatal
    }
  }

  // Build the conversation
  const llmMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map(m => ({
      role: m.role || 'user',
      content: m.content
    }))
  ];

  // Add context from memory if available
  if (contextMemories.length > 0) {
    const contextText = contextMemories.map(m => m.content).join('\n');
    llmMessages.splice(1, 0, {
      role: 'system',
      content: `Previous context from earlier conversations: ${contextText}`
    });
  }

  // Generate response
  const response = await invoke('llm', 'chat', {
    messages: llmMessages,
    temperature: 0.7,
    maxTokens: 300
  });

  const reply = response.content;

  // Check if the reply contains an email capture (simple regex)
  const emailMatch = reply.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch && visitorEmail) {
    // Store the qualified lead
    try {
      const { url, key } = getSupabaseCreds();
      await fetch(`${url}/rest/v1/contacts`, {
        method: 'POST',
        headers: {
          'apikey': key, 'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json', 'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          email: visitorEmail,
          source: 'signup:concierge',
          company_name: extractCompany(messages),
          name: extractName(messages)
        })
      });
    } catch (e) {
      console.warn('[concierge] CRM capture failed:', e.message);
    }
  }

  // Store conversation as memory
  try {
    await remember({
      agentId: 'concierge',
      memoryType: 'note',
      content: `Concierge chat ${sessionId || 'unknown'}: Visitor said "${messages[messages.length - 1]?.content || ''}" → Agent replied "${reply.slice(0, 200)}"`,
      metadata: { sessionId, visitorEmail },
      embed: false
    });
  } catch (e) {
    // Non-fatal
  }

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

async function handleQualify(body, corsHeaders) {
  const { messages = [], sessionId } = body;

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

  let result;
  try {
    result = JSON.parse(qualification.content.replace(/```json\s*/gi, '').replace(/```/g, ''));
  } catch {
    result = { qualified: false, fit: 'unknown', next_step: 'Continue conversation' };
  }

  // If qualified with email, capture to CRM
  if (result.qualified && result.email) {
    try {
      const { url, key } = getSupabaseCreds();
      await fetch(`${url}/rest/v1/contacts`, {
        method: 'POST',
        headers: {
          'apikey': key, 'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json', 'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          email: result.email,
          name: result.name,
          company_name: result.company,
          source: 'signup:concierge'
        })
      });

      await remember({
        agentId: 'concierge',
        memoryType: 'contact',
        content: `Qualified lead: ${result.name || 'Unknown'} at ${result.company || 'Unknown'} (${result.email}). Role: ${result.role || 'unknown'}. Pain: ${result.pain_point || 'unknown'}. Fit: ${result.fit}.`,
        metadata: result,
        embed: false
      });
    } catch (e) {
      console.warn('[concierge] Lead capture failed:', e.message);
    }
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getSupabaseCreds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
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
