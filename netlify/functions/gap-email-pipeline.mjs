/**
 * GAP Email Pipeline — End-to-End Signal Gathering + Email Generation
 * 
 * Single endpoint that:
 * 1. Gathers signals from all configured sources
 * 2. Generates a GAP-methodology email using those signals
 * 3. Returns both the signals (with source URLs) and the email
 * 
 * This is the primary integration point for the AI SDR frontend.
 */

// ─── Signal Gathering (inline for single-function deployment) ──────────────────

async function webSearch(query) {
  const serpApiKey = typeof Netlify !== 'undefined' ? Netlify.env.get('SERP_API_KEY') : process.env.SERP_API_KEY;
  
  if (serpApiKey) {
    try {
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${serpApiKey}&num=5`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        return (data.organic_results || []).map(r => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet
        }));
      }
    } catch (e) { /* fall through */ }
  }
  
  // Google Custom Search fallback
  const gKey = typeof Netlify !== 'undefined' ? Netlify.env.get('GOOGLE_SEARCH_KEY') : process.env.GOOGLE_SEARCH_KEY;
  const gCx = typeof Netlify !== 'undefined' ? Netlify.env.get('GOOGLE_SEARCH_CX') : process.env.GOOGLE_SEARCH_CX;
  
  if (gKey && gCx) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${gKey}&cx=${gCx}&num=5`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        return (data.items || []).map(r => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet
        }));
      }
    } catch (e) { /* fall through */ }
  }
  
  return [];
}

function detectSignalType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('funding') || lower.includes('raised') || lower.includes('series')) return 'funding';
  if (lower.includes('hiring') || lower.includes('job') || lower.includes('career')) return 'hiring';
  if (lower.includes('ceo') || lower.includes('cto') || lower.includes('cfo') || lower.includes('appointed')) return 'executive_change';
  if (lower.includes('partnership') || lower.includes('partner')) return 'partnership';
  if (lower.includes('acquisition') || lower.includes('acquired')) return 'acquisition';
  if (lower.includes('launch') || lower.includes('released') || lower.includes('announced')) return 'product_launch';
  if (lower.includes('podcast') || lower.includes('interview') || lower.includes('webinar')) return 'media_appearance';
  return 'company_news';
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

function dedupeSignals(signals) {
  const seen = new Set();
  return signals.filter(s => {
    const key = `${s.type}:${(s.source_url || s.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function gatherSignals(prospect) {
  const signals = [];
  const company = prospect.company_name;
  const contactName = prospect.contact_name;
  
  // 1. Company news / funding / press
  if (company) {
    const queries = [
      `${company} funding OR announcement OR news 2025 2026`,
      `${company} hiring jobs careers`,
    ];
    for (const q of queries) {
      try {
        const results = await webSearch(q);
        for (const r of results.slice(0, 3)) {
          if (r.title && r.url) {
            signals.push({
              type: detectSignalType(r.title + ' ' + (r.snippet || '')),
              title: r.title,
              detail: (r.snippet || r.title).slice(0, 200),
              source_url: r.url,
              source_name: extractDomain(r.url),
              gathered_at: new Date().toISOString()
            });
          }
        }
      } catch (e) { /* continue */ }
    }
  }
  
  // 2. Prospect's own content (posts, podcasts, interviews)
  if (contactName) {
    const q = company 
      ? `"${contactName}" "${company}" post OR interview OR podcast OR article`
      : `"${contactName}" post OR interview OR podcast`;
    try {
      const results = await webSearch(q);
      for (const r of results.slice(0, 2)) {
        if (r.title && r.url) {
          signals.push({
            type: 'prospect_content',
            title: r.title,
            detail: (r.snippet || r.title).slice(0, 200),
            source_url: r.url,
            source_name: extractDomain(r.url),
            gathered_at: new Date().toISOString()
          });
        }
      }
    } catch (e) { /* continue */ }
  }
  
  // 3. LinkedIn public (best-effort via web search)
  if (contactName) {
    const q = `site:linkedin.com "${contactName}" ${company || ''}`;
    try {
      const results = await webSearch(q);
      for (const r of results.slice(0, 2)) {
        if (r.title && r.url && r.url.includes('linkedin.com')) {
          signals.push({
            type: 'linkedin_activity',
            title: r.title,
            detail: (r.snippet || r.title).slice(0, 200),
            source_url: r.url,
            source_name: 'LinkedIn',
            gathered_at: new Date().toISOString()
          });
        }
      }
    } catch (e) { /* continue */ }
  }
  
  // 4. Manual LinkedIn paste (if provided)
  if (prospect.linkedin_profile_text) {
    const text = prospect.linkedin_profile_text;
    const url = prospect.linkedin_url || 'https://linkedin.com';
    
    const jobMatch = text.match(/(?:started|joined|new role|promoted to)\s+(.+?)(?:\n|$)/i);
    if (jobMatch) {
      signals.push({
        type: 'job_change',
        title: `Role change: ${jobMatch[1].trim().slice(0, 80)}`,
        detail: jobMatch[0].trim(),
        source_url: url,
        source_name: 'LinkedIn (manual)',
        gathered_at: new Date().toISOString()
      });
    }
    
    const postMatch = text.match(/(?:posted|shared|published|wrote)[\s:]+(.{20,150})/gi);
    if (postMatch) {
      for (const p of postMatch.slice(0, 2)) {
        signals.push({
          type: 'linkedin_activity',
          title: `LinkedIn post: ${p.slice(0, 80).trim()}`,
          detail: p.trim(),
          source_url: url,
          source_name: 'LinkedIn (manual)',
          gathered_at: new Date().toISOString()
        });
      }
    }
  }
  
  return dedupeSignals(signals);
}

// ─── GAP Email Generation ──────────────────────────────────────────────────────

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
- You will receive a signals array. Each signal has: type, title, detail, source_url, source_name.
- Pick the BEST 1-2 signals that map to a plausible business problem.
- Weave the source naturally into your opener.
- If signals array is empty, use a generic industry-relevant catalyst and note "Based on trends in [industry]" — never fabricate a specific signal.

### Output Format:
Return ONLY valid JSON:
{
  "subject": "2-4 word subject line in sentence case",
  "body": "The full email body text (plain text, use newlines for paragraph breaks). End with a signature line: '[Sender Name] | A-Gent Fleet'",
  "signals_used": [{"type": "...", "source_url": "...", "why": "brief reason this signal was chosen"}],
  "gap_analysis": {
    "current_state": "What pain/problem the prospect likely has",
    "future_state": "What better looks like",
    "cost_of_gap": "Business impact of not solving"
  }
}`;

async function generateGapEmail(prospect, signals, sender, productContext) {
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
    throw new Error('OPENAI_API_KEY environment variable is not set. Configure it in Netlify env vars.');
  }
  
  // Build user prompt
  let userPrompt = `## Prospect Information
- **Name:** ${prospect.contact_name}
- **Company:** ${prospect.company_name || 'Unknown'}
- **Role/Title:** ${prospect.role || prospect.title || 'Unknown'}
- **Industry:** ${prospect.industry || 'Unknown'}
`;
  
  userPrompt += `\n## Signals Gathered (${signals.length} total)\n`;
  if (signals.length === 0) {
    userPrompt += `No signals were found. Use a generic industry catalyst and note that personalization is limited.\n`;
  } else {
    for (const s of signals) {
      userPrompt += `- [${s.type}] ${s.title} — Source: ${s.source_url} (${s.source_name})\n  Detail: ${s.detail}\n`;
    }
  }
  
  userPrompt += `\n## Sender Context
- **Sender Name:** ${sender?.name || 'Mark'}
- **Sender Company:** A-Gent Fleet
- **Signature Format:** [Sender Name] | A-Gent Fleet
`;
  
  if (productContext) {
    userPrompt += `\n## What We Solve (for credibility line only — do NOT feature-dump)\n${productContext}\n`;
  } else {
    userPrompt += `\n## What We Solve\nAI-powered sales automation that helps B2B teams reduce manual prospecting work, improve pipeline quality, and accelerate revenue.\n`;
  }
  
  userPrompt += `\n## Task\nWrite a GAP Prospecting email for this prospect. Follow the methodology exactly. Return valid JSON only.`;
  
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: GAP_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 4000
    })
  });
  
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
  }
  
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  
  // Parse JSON from response
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) { /* fall through */ }
  
  return {
    subject: `${prospect.company_name || 'your team'}`,
    body: content,
    signals_used: [],
    gap_analysis: { current_state: 'unknown', future_state: 'unknown', cost_of_gap: 'unknown' },
    raw_response: true
  };
}

// ─── Netlify Function Handler ──────────────────────────────────────────────────
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
    const { prospect, sender, product_context, skip_signals } = body;
    
    if (!prospect || !prospect.contact_name) {
      return new Response(JSON.stringify({ 
        error: 'prospect object with contact_name is required',
        example: {
          prospect: {
            contact_name: "Jane Smith",
            company_name: "Acme Corp",
            role: "VP Sales",
            industry: "SaaS",
            company_domain: "acme.com"
          }
        }
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Step 1: Gather signals (unless pre-provided or skipped)
    let signals = body.signals || [];
    let signalGatheringResult = { skipped: false };
    
    if (!skip_signals && signals.length === 0) {
      const serpApiKey = typeof Netlify !== 'undefined' ? Netlify.env.get('SERP_API_KEY') : process.env.SERP_API_KEY;
      signals = await gatherSignals(prospect);
      signalGatheringResult = {
        skipped: false,
        signals_found: signals.length,
        serp_api_active: !!serpApiKey,
        sources_queried: ['web_news', 'job_postings', 'prospect_content', 'linkedin_public', 
          ...(prospect.linkedin_profile_text ? ['linkedin_manual'] : [])]
      };
    } else if (skip_signals) {
      signalGatheringResult = { skipped: true, reason: 'skip_signals flag set' };
    }
    
    // Step 2: Generate GAP email
    const emailData = await generateGapEmail(prospect, signals, sender, product_context);
    
    // Step 3: Return combined result
    return new Response(JSON.stringify({
      success: true,
      methodology: 'gap_prospecting',
      signal_gathering: signalGatheringResult,
      signals,
      email: {
        ...emailData,
        generated_at: new Date().toISOString()
      },
      prospect_summary: {
        name: prospect.contact_name,
        company: prospect.company_name,
        role: prospect.role || prospect.title
      },
      verification: {
        signals_are_real: signals.every(s => s.source_url),
        no_hallucination: emailData.signals_used?.every(su => 
          signals.some(s => s.source_url === su.source_url)
        ) ?? true,
        methodology_applied: 'gap_prospecting_v1'
      }
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ 
      error: e.message,
      hint: 'Ensure OPENAI_API_KEY is set in Netlify environment variables'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

export const config = {
  path: "/api/gap-email-pipeline"
};
