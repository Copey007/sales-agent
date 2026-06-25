/**
 * A-Gent Co-Pilot API (Phase 4 — Live Meeting Co-Pilot)
 * 
 * Provides real-time meeting intelligence:
 *   - Transcript analysis (GAP methodology scoring)
 *   - Live coaching suggestions (what to ask next, objections to handle)
 *   - Meeting notes generation
 *   - Stores transcripts + notes as agent memories
 * 
 * Endpoints:
 *   GET  /api/copilot                          — health check
 *   POST /api/copilot  { action: "coach" }     — Get live coaching from transcript
 *   POST /api/copilot  { action: "summarize" } — Generate meeting notes
 *   POST /api/copilot  { action: "store" }      — Store transcript + notes
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
      service: 'A-Gent Co-Pilot',
      capabilities: ['real_time_coaching', 'gap_scoring', 'meeting_notes', 'transcript_storage'],
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
    const action = body.action || 'coach';

    switch (action) {
      case 'coach':
        return await handleCoach(body, corsHeaders);
      case 'summarize':
        return await handleSummarize(body, corsHeaders);
      case 'store':
        return await handleStore(body, corsHeaders);
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
  } catch (err) {
    console.error('[copilot] Error:', err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};

export const config = { path: "/api/copilot" };

// ─── Coaching System Prompt ────────────────────────────────────────────────────

const COACH_PROMPT = `You are the A-Gent Co-Pilot — a real-time sales call coach using the GAP methodology.

You monitor a live sales call transcript and provide brief, actionable coaching.

Your coaching rules:
- Identify if the rep is talking too much (should be 40% talk / 60% listen)
- Flag when the rep hasn't asked a question in the last 3 exchanges
- Suggest GAP-aligned questions when the prospect mentions a problem
- Flag buying signals (budget mentioned, timeline, competition, pain)
- Suggest next steps when the prospect shows interest
- Keep suggestions to 1-2 sentences MAX
- If the call is going well, say so briefly

Return ONLY valid JSON:
{
  "coaching": "1-2 sentence suggestion for the rep",
  "priority": "low|medium|high",
  "signal": "none|budget|timeline|pain|authority|competition|interest",
  "gap_score": 0-100,
  "talk_ratio": "rep:prospect estimate like 40:60"
}`;

const SUMMARIZE_PROMPT = `You are the A-Gent Co-Pilot. Generate structured meeting notes from this sales call transcript.

Return ONLY valid JSON:
{
  "summary": "2-3 sentence executive summary",
  "key_points": ["point 1", "point 2", ...],
  "pain_points": ["identified pain 1", ...],
  "buying_signals": ["signal 1", ...],
  "objections": ["objection 1", ...],
  "next_steps": ["action 1", "action 2"],
  "gap_analysis": {
    "gap_identified": true/false,
    "gap_description": "the gap between current state and desired state",
    "impact": "quantified impact of the gap",
    "cause": "root cause if identified"
  },
  "fit": "good|maybe|poor",
  "recommended_action": "what the rep should do next"
}`;

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function handleCoach(body, corsHeaders) {
  const { transcript = [], meetingContext = {} } = body;

  if (!transcript.length) {
    return new Response(JSON.stringify({ error: 'transcript array is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // Format transcript for LLM
  const transcriptText = transcript.map(t => 
    `${t.speaker || 'Unknown'}: ${t.text}`
  ).join('\n');

  // Recall any context about this prospect
  let prospectContext = '';
  if (meetingContext.company || meetingContext.contactName) {
    try {
      const memories = await recall({
        query: `meeting context for ${meetingContext.company || meetingContext.contactName}`,
        matchCount: 3
      });
      prospectContext = memories.map(m => m.content).join('\n');
    } catch (e) { /* non-fatal */ }
  }

  const result = await invoke('llm', 'chat', {
    messages: [
      { role: 'system', content: COACH_PROMPT },
      { role: 'user', content: `Meeting context: ${JSON.stringify(meetingContext)}\n\nPrevious context: ${prospectContext || 'None'}\n\nLive transcript:\n${transcriptText}` }
    ],
    temperature: 0.3,
    maxTokens: 400
  });

  let coaching;
  try {
    coaching = JSON.parse(result.content.replace(/```json\s*/gi, '').replace(/```/g, ''));
  } catch {
    coaching = {
      coaching: result.content.slice(0, 200),
      priority: 'low',
      signal: 'none',
      gap_score: 50,
      talk_ratio: 'unknown'
    };
  }

  return new Response(JSON.stringify({
    ...coaching,
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleSummarize(body, corsHeaders) {
  const { transcript = [], meetingContext = {} } = body;

  if (!transcript.length) {
    return new Response(JSON.stringify({ error: 'transcript array is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const transcriptText = transcript.map(t =>
    `${t.speaker || 'Unknown'}: ${t.text}`
  ).join('\n');

  const result = await invoke('llm', 'chat', {
    messages: [
      { role: 'system', content: SUMMARIZE_PROMPT },
      { role: 'user', content: `Meeting context: ${JSON.stringify(meetingContext)}\n\nFull transcript:\n${transcriptText}` }
    ],
    temperature: 0.2,
    maxTokens: 1000
  });

  let notes;
  try {
    notes = JSON.parse(result.content.replace(/```json\s*/gi, '').replace(/```/g, ''));
  } catch {
    notes = {
      summary: result.content.slice(0, 500),
      key_points: [],
      next_steps: [],
      gap_analysis: { gap_identified: false },
      fit: 'unknown',
      recommended_action: 'Follow up'
    };
  }

  return new Response(JSON.stringify({
    ...notes,
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

async function handleStore(body, corsHeaders) {
  const { transcript = [], notes = {}, meetingContext = {}, meetingId } = body;
  const id = meetingId || `meeting_${Date.now()}`;

  // Store transcript + notes as a memory
  try {
    await remember({
      agentId: 'copilot',
      memoryType: 'note',
      content: `Meeting ${id} with ${meetingContext.company || 'unknown'}: ${notes.summary || 'No summary'}. Key points: ${JSON.stringify(notes.key_points || []).slice(0, 300)}. Next steps: ${JSON.stringify(notes.next_steps || []).slice(0, 200)}`,
      metadata: {
        meetingId: id,
        company: meetingContext.company,
        contactName: meetingContext.contactName,
        notes,
        transcriptLength: transcript.length
      },
      embed: false
    });
  } catch (e) {
    console.warn('[copilot] Memory store failed:', e.message);
  }

  return new Response(JSON.stringify({
    stored: true,
    meetingId: id,
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
