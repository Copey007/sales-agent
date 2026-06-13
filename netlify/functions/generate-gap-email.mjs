/**
 * GAP Email Generator — Netlify Serverless Function
 * 
 * Takes gathered signals + prospect data and produces a personalized,
 * problem-centric email following the GAP Prospecting methodology.
 * 
 * Uses the project's OpenAI-compatible LLM endpoint.
 */

// ─── GAP Email System Prompt ───────────────────────────────────────────────────
const GAP_SYSTEM_PROMPT = `You are an expert cold email writer trained in the GAP Prospecting methodology by Keenan & Will Aitken. You write short, problem-centric outbound emails that trigger curiosity and secure meetings.

## RULES — FOLLOW EXACTLY:

### Structure (in this exact order):
1. **Signal Opener** (1 sentence): Reference a REAL signal about the prospect/company. Cite the source naturally (e.g., "Saw on your careers page...", "Noticed the announcement on TechCrunch..."). If no signal is available, use a relevant industry catalyst.
2. **Current State / Problem** (1-2 sentences): Map the signal to a likely PAIN they are experiencing. Use the So-What System — trace the problem to its business impact (missed revenue, high CAC, lost deals, slow growth, compliance risk, etc.). Focus on PAIN, not gain.
3. **Credibility / Future State** (1 sentence): Briefly mention you help solve this specific problem. Reference a peer company or result if possible. No feature dumps.
4. **CTA** (1 sentence): Ask ONE low-friction, problem-centric question. Do NOT ask for a meeting directly.

### Tone & Style:
- Professional, direct, peer-to-peer. Conversational, not corporate.
- UNDER 100 WORDS total (excluding signature). Brevity is critical.
- No fluff, no buzzwords, no filler phrases.
- Sentence case for subject line (2-4 words, relevant to the problem/signal).

### FORBIDDEN:
- "I hope this email finds you well"
- "My name is X and I work at Y"
- "Synergy", "Innovate", "Leverage", "Circle back"
- "I'd love to show you", "Quick question", "Just bubbling this up"
- "15 minutes on your calendar"
- Inventing or hallucinating signals — if no signal provided, say so
- Feature dumps or product descriptions
- Multiple CTAs

### Signal Usage:
- You will receive a \`signals\` array. Each signal has: type, title, detail, source_url, source_name.
- Pick the BEST 1-2 signals that map to a plausible business problem.
- Weave the source naturally into your opener.
- If signals array is empty, use a generic industry-relevant catalyst and note "Based on trends in [industry]" — never fabricate a specific signal.

### Output Format:
Return ONLY valid JSON:
{
  "subject": "2-4 word subject line in sentence case",
  "body": "The full email body text (plain text, use \\n for line breaks)",
  "signals_used": [{"type": "...", "source_url": "...", "why": "brief reason this signal was chosen"}],
  "gap_analysis": {
    "current_state": "What pain/problem the prospect likely has",
    "future_state": "What better looks like",
    "cost_of_gap": "Business impact of not solving"
  }
}`;

// ─── Handler ───────────────────────────────────────────────────────────────────
export default async (req, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  };
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const body = await req.json();
    const { prospect, signals, sender, product_context } = body;
    
    if (!prospect || !prospect.contact_name) {
      return new Response(JSON.stringify({ 
        error: 'prospect object with contact_name is required' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Build the user prompt
    const userPrompt = buildUserPrompt(prospect, signals || [], sender, product_context);
    
    // Call LLM
    const llmResponse = await callLLM(GAP_SYSTEM_PROMPT, userPrompt);
    
    // Parse the response
    let emailData;
    try {
      // Try to extract JSON from the response
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        emailData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in LLM response');
      }
    } catch (parseErr) {
      // If JSON parsing fails, return the raw response with structure
      emailData = {
        subject: `${prospect.company_name || 'your team'} growth`,
        body: llmResponse,
        signals_used: [],
        gap_analysis: { current_state: 'unknown', future_state: 'unknown', cost_of_gap: 'unknown' },
        parse_error: parseErr.message
      };
    }
    
    // Add metadata
    emailData.generated_at = new Date().toISOString();
    emailData.methodology = 'gap_prospecting';
    emailData.prospect_summary = {
      name: prospect.contact_name,
      company: prospect.company_name,
      role: prospect.role || prospect.title
    };
    emailData.total_signals_available = (signals || []).length;
    
    return new Response(JSON.stringify({
      success: true,
      email: emailData
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

// ─── Build User Prompt ─────────────────────────────────────────────────────────
function buildUserPrompt(prospect, signals, sender, productContext) {
  let prompt = `## Prospect Information
- **Name:** ${prospect.contact_name}
- **Company:** ${prospect.company_name || 'Unknown'}
- **Role/Title:** ${prospect.role || prospect.title || 'Unknown'}
- **Industry:** ${prospect.industry || 'Unknown'}
`;

  if (prospect.company_domain) {
    prompt += `- **Domain:** ${prospect.company_domain}\n`;
  }
  
  prompt += `\n## Signals Gathered (${signals.length} total)\n`;
  if (signals.length === 0) {
    prompt += `No signals were found. Use a generic industry catalyst and note that personalization is limited.\n`;
  } else {
    for (const s of signals) {
      prompt += `- [${s.type}] ${s.title} — Source: ${s.source_url} (${s.source_name})\n  Detail: ${s.detail}\n`;
    }
  }
  
  prompt += `\n## Sender Context\n`;
  prompt += `- **Sender Name:** ${sender?.name || 'Mark'}\n`;
  prompt += `- **Sender Company:** A-Gent Fleet\n`;
  prompt += `- **Signature Format:** [Sender Name] | A-Gent Fleet\n`;
  
  if (productContext) {
    prompt += `\n## What We Solve (for credibility line only — do NOT feature-dump)\n${productContext}\n`;
  } else {
    prompt += `\n## What We Solve\nAI-powered sales automation that helps B2B teams reduce manual prospecting work, improve pipeline quality, and accelerate revenue.\n`;
  }
  
  prompt += `\n## Task\nWrite a GAP Prospecting email for this prospect. Follow the methodology exactly. Return valid JSON only.`;
  
  return prompt;
}

// ─── LLM Call ──────────────────────────────────────────────────────────────────
async function callLLM(systemPrompt, userPrompt) {
  // Use OpenAI-compatible endpoint (configured via env vars)
  const apiKey = (typeof Netlify !== 'undefined' && Netlify.env.get('OPENAI_API_KEY'))
    ? Netlify.env.get('OPENAI_API_KEY')
    : (process.env.OPENAI_API_KEY || 'sk-iVJWw2GcvmPsr7AceUSTcf');
  const apiBase = (typeof Netlify !== 'undefined' && Netlify.env.get('OPENAI_API_BASE'))
    ? Netlify.env.get('OPENAI_API_BASE')
    : (process.env.OPENAI_API_BASE || 'https://api.manus.im/api/llm-proxy/v1');
  const model = (typeof Netlify !== 'undefined' && Netlify.env.get('LLM_MODEL'))
    ? Netlify.env.get('LLM_MODEL')
    : (process.env.LLM_MODEL || 'gpt-5-mini');
  
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }
  
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 4000,
      // response_format: { type: 'json_object' } // not all providers support this
    })
  });
  
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
  }
  
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

export const config = {
  path: "/api/generate-gap-email"
};
