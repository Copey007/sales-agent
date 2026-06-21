/**
 * Loop Engine — Self-Optimizing Outbound Email Loop
 * 
 * Inspired by Karpathy's autoresearch keep-or-revert pattern.
 * Each invocation runs ONE iteration (1 prospect evaluation) to stay within
 * Netlify's function timeout. State persists via Netlify Blobs between calls.
 * The UI chains iterations by calling repeatedly.
 * 
 * Endpoints:
 *   POST /api/loop-engine  { action: "run" | "status" | "history" | "run-sequence" }
 * 
 * Storage: Netlify Blobs (serverless KV)
 */

// ─── LLM Configuration ──────────────────────────────────────────────────────────

function getLLMConfig() {
  const apiKey = (typeof Netlify !== 'undefined' && Netlify.env?.get('OPENAI_API_KEY'))
    ? Netlify.env.get('OPENAI_API_KEY')
    : (process.env.OPENAI_API_KEY || 'sk-iVJWw2GcvmPsr7AceUSTcf');
  const apiBase = (typeof Netlify !== 'undefined' && Netlify.env?.get('OPENAI_API_BASE'))
    ? Netlify.env.get('OPENAI_API_BASE')
    : (process.env.OPENAI_API_BASE || 'https://api.manus.im/api/llm-proxy/v1');
  const model = (typeof Netlify !== 'undefined' && Netlify.env?.get('LLM_MODEL'))
    ? Netlify.env.get('LLM_MODEL')
    : (process.env.LLM_MODEL || 'claude-haiku-4-5');
  return { apiKey, apiBase, model };
}

function cleanLLMJson(content) {
  // Strip markdown code fences that Claude sometimes adds
  let cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  return cleaned;
}

async function callLLM(messages, temperature = 0.7, maxTokens = 2000) {
  const { apiKey, apiBase, model } = getLLMConfig();
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── Experiment Storage via Netlify Blobs ────────────────────────────────────────

let BLOB_STORE = null;

async function getStore() {
  if (BLOB_STORE) return BLOB_STORE;
  try {
    const { getStore: getBlobStore } = await import('@netlify/blobs');
    BLOB_STORE = getBlobStore('loop-engine');
    return BLOB_STORE;
  } catch (e) {
    // Fallback: in-memory (resets on cold start but allows function to work)
    BLOB_STORE = {
      _data: {},
      async get(key) { return this._data[key] || null; },
      async set(key, value) { this._data[key] = value; },
    };
    return BLOB_STORE;
  }
}

async function loadExperiments() {
  const store = await getStore();
  const raw = await store.get('experiments');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveExperiments(experiments) {
  const store = await getStore();
  await store.set('experiments', JSON.stringify(experiments));
}

async function loadBaseline() {
  const store = await getStore();
  const raw = await store.get('baseline');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveBaseline(baseline) {
  const store = await getStore();
  await store.set('baseline', JSON.stringify(baseline));
}

// ─── LOCKED Guardrails (cannot be modified by the loop) ──────────────────────────

const LOCKED_GUARDRAILS = `
## LOCKED GUARDRAILS — These rules are IMMUTABLE and must ALWAYS be followed:

1. **GAP Methodology Structure** (in this exact order):
   - Signal Opener (1 sentence): Reference a REAL signal with source
   - Current State / Problem (1-2 sentences): Map signal to business PAIN
   - Credibility / Future State (1 sentence): How you solve this
   - CTA (1 sentence): ONE low-friction, problem-centric question

2. **Signal Integrity**: 
   - NEVER fabricate or hallucinate signals
   - Every signal must be real and source-linked (URL provided)
   - If no signal available, use generic industry catalyst and disclose

3. **Brevity**: UNDER 100 WORDS total (excluding signature)

4. **Single CTA**: Exactly ONE call-to-action, phrased as a question

5. **Signature**: Always end with "[Sender Name] | A-Gent Fleet"

6. **Forbidden phrases**: "I hope this email finds you well", "My name is X", 
   "synergy", "leverage", "circle back", "15 minutes on your calendar",
   "I'd love to show you", "Quick question", feature dumps, multiple CTAs
`;

// ─── Default Baseline Template ──────────────────────────────────────────────────

const DEFAULT_BASELINE = {
  id: 'baseline_v0',
  version: 0,
  description: 'Original GAP Prospecting template — standard signal opener + problem mapping + credibility + CTA',
  template: `You are an expert cold email writer trained in the GAP Prospecting methodology. Write short, problem-centric outbound emails that trigger curiosity and secure meetings.

${LOCKED_GUARDRAILS}

### Editable Strategy (what the Loop Engine can optimize):
- Signal selection priority: Choose the signal most likely to map to a business pain
- Problem framing angle: How to connect the signal to a specific cost/risk
- Credibility positioning: How to reference peer results without feature-dumping
- CTA style: The specific question format that creates curiosity
- Tone calibration: Level of directness vs. warmth
- Subject line approach: How to distill the core problem into 2-4 words

### Output Format:
Return ONLY valid JSON:
{
  "subject": "2-4 word subject line in sentence case",
  "body": "Full email body (plain text, newlines for paragraphs). End with signature: [Sender Name] | A-Gent Fleet",
  "signals_used": [{"type": "...", "source_url": "...", "why": "reason"}],
  "gap_analysis": {"current_state": "...", "future_state": "...", "cost_of_gap": "..."}
}`,
  score: null,
  created_at: new Date().toISOString()
};

// ─── Sample Prospect Pool (rotates through for evaluation) ──────────────────────

const SAMPLE_PROSPECTS = [
  {
    contact_name: "Sarah Chen",
    company_name: "Datadog",
    role: "VP of Sales",
    industry: "DevOps / Monitoring SaaS",
    signals: [
      { type: "company_news", title: "Datadog Q1 2026 Revenue Hits $750M ARR", detail: "Datadog reported strong Q1 results with ARR growing 28% YoY", source_url: "https://investors.datadoghq.com/news-releases", source_name: "investors.datadoghq.com" },
      { type: "hiring", title: "Datadog hiring 50+ enterprise AEs", detail: "Major expansion of enterprise sales team across EMEA and NA", source_url: "https://careers.datadoghq.com/sales", source_name: "careers.datadoghq.com" }
    ]
  },
  {
    contact_name: "Marcus Johnson",
    company_name: "Gong",
    role: "CRO",
    industry: "Revenue Intelligence SaaS",
    signals: [
      { type: "product_launch", title: "Gong launches AI-powered deal coaching", detail: "New feature uses conversation intelligence to provide real-time coaching during calls", source_url: "https://www.gong.io/blog/ai-coaching", source_name: "gong.io" },
      { type: "linkedin_activity", title: "Marcus posted about scaling from 50 to 200 reps", detail: "Shared lessons on maintaining quality while rapidly growing the sales org", source_url: "https://linkedin.com/in/marcusjohnson/posts", source_name: "LinkedIn" }
    ]
  },
  {
    contact_name: "Emily Rodriguez",
    company_name: "Notion",
    role: "Head of Growth",
    industry: "Productivity / Collaboration SaaS",
    signals: [
      { type: "funding", title: "Notion raises $150M at $15B valuation", detail: "Series D funding to accelerate enterprise adoption and AI features", source_url: "https://techcrunch.com/2026/notion-series-d", source_name: "TechCrunch" },
      { type: "prospect_content", title: "Emily on the SaaStr podcast discussing PLG to enterprise motion", detail: "Discussed challenges of transitioning from product-led growth to enterprise sales", source_url: "https://www.saastr.com/podcast/notion-emily-rodriguez", source_name: "SaaStr" }
    ]
  }
];

// ─── LLM Judge — Email Quality Scoring ──────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are an expert email quality judge evaluating cold outbound emails against the GAP Prospecting methodology. Score each email on a 0-100 scale across these dimensions:

1. **GAP Structure** (0-20): Does it follow Signal Opener → Current State/Problem → Credibility → CTA?
2. **Signal Specificity** (0-15): Are real, specific signals referenced (not generic)?
3. **Signal Integrity** (0-15): Are signals verifiable with source URLs? No fabrication?
4. **Clarity** (0-15): Is the message clear, direct, and free of jargon/fluff?
5. **CTA Strength** (0-15): Is there exactly ONE problem-centric question that creates curiosity?
6. **Brevity** (0-10): Is it under 100 words? Concise without losing meaning?
7. **Personalization** (0-10): Does it feel tailored to THIS specific person/company?

Return ONLY valid JSON:
{
  "total_score": <0-100>,
  "dimensions": {
    "gap_structure": <0-20>,
    "signal_specificity": <0-15>,
    "signal_integrity": <0-15>,
    "clarity": <0-15>,
    "cta_strength": <0-15>,
    "brevity": <0-10>,
    "personalization": <0-10>
  },
  "feedback": "One sentence of constructive feedback for improvement"
}`;

async function scoreEmail(email, prospect, signals) {
  const userPrompt = `## Email to Score:
Subject: ${email.subject}
Body: ${email.body}

## Context:
- Prospect: ${prospect.contact_name}, ${prospect.role} at ${prospect.company_name}
- Industry: ${prospect.industry}
- Signals provided: ${signals.map(s => `[${s.type}] ${s.title} (${s.source_url})`).join('; ')}

Score this email against the GAP Prospecting methodology criteria. Return JSON only.`;

  const content = await callLLM([
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ], 0.2, 800);

  try {
    const cleaned = cleanLLMJson(content);
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) { /* fall through */ }
  
  return { total_score: 50, dimensions: {}, feedback: 'Could not parse judge response' };
}

// ─── Variant Proposer ───────────────────────────────────────────────────────────

const PROPOSER_SYSTEM_PROMPT = `You are an email optimization strategist. Given the current email template/prompt and its performance scores, propose a SPECIFIC improvement to the editable strategy section.

You CANNOT change the locked guardrails (GAP structure, signal integrity, brevity, single CTA, signature, forbidden phrases). You CAN optimize:
- Signal selection priority (which signal to lead with and why)
- Problem framing angle (how to connect signal → pain → business cost)
- Credibility positioning (how to hint at capability without feature-dumping)
- CTA question style (curiosity-driven, assumption-based, or challenge-based)
- Tone calibration (more direct, more empathetic, more provocative)
- Subject line approach (problem-focused, signal-focused, or curiosity-gap)

Return ONLY valid JSON:
{
  "variant_description": "One sentence describing what this variant changes",
  "optimization_hypothesis": "Why this change should improve scores",
  "updated_strategy_section": "The full replacement text for the ### Editable Strategy section"
}`;

async function proposeVariant(currentTemplate, scores, feedback) {
  const userPrompt = `## Current Template Performance:
- Average Score: ${scores.avg.toFixed(1)}/100
- GAP Structure: ${scores.gap_structure.toFixed(1)}/20
- Signal Specificity: ${scores.signal_specificity.toFixed(1)}/15
- Clarity: ${scores.clarity.toFixed(1)}/15
- CTA Strength: ${scores.cta_strength.toFixed(1)}/15
- Brevity: ${scores.brevity.toFixed(1)}/10
- Personalization: ${scores.personalization.toFixed(1)}/10

## Judge Feedback:
${feedback}

## Current Editable Strategy Section:
${currentTemplate.match(/### Editable Strategy[\s\S]*?(?=###|$)/)?.[0] || 'Default strategy'}

Propose ONE specific optimization. Focus on the weakest dimension. Return JSON only.`;

  const content = await callLLM([
    { role: 'system', content: PROPOSER_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ], 0.8, 1500);

  try {
    const cleaned = cleanLLMJson(content);
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) { /* fall through */ }
  
  return null;
}

// ─── Email Generator (uses template) ────────────────────────────────────────────

async function generateEmailWithTemplate(template, prospect, signals) {
  const userPrompt = `## Prospect Information
- **Name:** ${prospect.contact_name}
- **Company:** ${prospect.company_name}
- **Role:** ${prospect.role}
- **Industry:** ${prospect.industry}

## Signals (${signals.length} total)
${signals.map(s => `- [${s.type}] ${s.title} — Source: ${s.source_url} (${s.source_name})\n  Detail: ${s.detail}`).join('\n')}

## Sender Context
- Sender Name: Mark
- Sender Company: A-Gent Fleet
- Signature: Mark | A-Gent Fleet

Write a GAP Prospecting email. Return valid JSON only.`;

  const content = await callLLM([
    { role: 'system', content: template },
    { role: 'user', content: userPrompt }
  ], 0.7, 1500);

  try {
    const cleaned = cleanLLMJson(content);
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) { /* fall through */ }
  
  return { subject: 'test', body: content, signals_used: [], gap_analysis: {} };
}

// ─── Single Iteration (fits within Netlify timeout) ──────────────────────────────

async function runSingleIteration() {
  let experiments = await loadExperiments();
  let baseline = await loadBaseline();
  
  if (!baseline) {
    baseline = { ...DEFAULT_BASELINE };
    await saveBaseline(baseline);
  }

  // Pick ONE prospect (rotate through pool based on experiment count)
  const prospectIndex = experiments.length % SAMPLE_PROSPECTS.length;
  const prospect = SAMPLE_PROSPECTS[prospectIndex];

  // Step 1: Generate + score baseline email for this prospect
  const baselineEmail = await generateEmailWithTemplate(baseline.template, prospect, prospect.signals);
  const baselineScore = await scoreEmail(baselineEmail, prospect, prospect.signals);
  
  const baselineAvg = {
    avg: baselineScore.total_score || 50,
    gap_structure: baselineScore.dimensions?.gap_structure || 10,
    signal_specificity: baselineScore.dimensions?.signal_specificity || 8,
    signal_integrity: baselineScore.dimensions?.signal_integrity || 8,
    clarity: baselineScore.dimensions?.clarity || 8,
    cta_strength: baselineScore.dimensions?.cta_strength || 8,
    brevity: baselineScore.dimensions?.brevity || 5,
    personalization: baselineScore.dimensions?.personalization || 5
  };

  // Update baseline score if not set
  if (baseline.score === null) {
    baseline.score = baselineAvg.avg;
    await saveBaseline(baseline);
  }

  // Step 2: Propose a variant
  const feedback = baselineScore.feedback || 'No specific feedback';
  const variant = await proposeVariant(baseline.template, baselineAvg, feedback);
  
  if (!variant) {
    const skipped = {
      id: `exp_${Date.now()}`,
      iteration: experiments.length + 1,
      status: 'skipped',
      reason: 'Could not generate variant proposal',
      baseline_score: baselineAvg.avg,
      variant_score: null,
      score_delta: 0,
      decision: 'skipped',
      timestamp: new Date().toISOString()
    };
    experiments.push(skipped);
    await saveExperiments(experiments);
    return { experiment: skipped, current_baseline: summarizeBaseline(baseline) };
  }

  // Step 3: Build the variant template
  const variantTemplate = baseline.template.replace(
    /### Editable Strategy[\s\S]*?(?=### Output Format)/,
    `### Editable Strategy (what the Loop Engine can optimize):\n${variant.updated_strategy_section}\n\n`
  );

  // Step 4: Generate + score variant email for same prospect
  const variantEmail = await generateEmailWithTemplate(variantTemplate, prospect, prospect.signals);
  const variantScore = await scoreEmail(variantEmail, prospect, prospect.signals);
  
  const variantAvg = variantScore.total_score || 50;

  // Step 5: Keep or Revert
  const improved = variantAvg > baselineAvg.avg;
  const decision = improved ? 'kept' : 'reverted';

  const experiment = {
    id: `exp_${Date.now()}`,
    iteration: experiments.length + 1,
    prospect_name: prospect.contact_name,
    prospect_company: prospect.company_name,
    variant_description: variant.variant_description,
    optimization_hypothesis: variant.optimization_hypothesis,
    baseline_score: baselineAvg.avg,
    variant_score: variantAvg,
    score_delta: variantAvg - baselineAvg.avg,
    decision,
    baseline_dimensions: baselineAvg,
    variant_dimensions: variantScore.dimensions || {},
    baseline_email: { subject: baselineEmail.subject, body: baselineEmail.body },
    variant_email: { subject: variantEmail.subject, body: variantEmail.body },
    judge_feedback: {
      baseline: baselineScore.feedback,
      variant: variantScore.feedback
    },
    timestamp: new Date().toISOString()
  };

  if (improved) {
    baseline = {
      id: `baseline_v${baseline.version + 1}`,
      version: baseline.version + 1,
      description: variant.variant_description,
      template: variantTemplate,
      score: variantAvg,
      created_at: new Date().toISOString(),
      parent_id: baseline.id
    };
    await saveBaseline(baseline);
  }

  experiments.push(experiment);
  await saveExperiments(experiments);

  return { experiment, current_baseline: summarizeBaseline(baseline) };
}

function summarizeBaseline(baseline) {
  return {
    id: baseline.id,
    version: baseline.version,
    description: baseline.description,
    score: baseline.score,
    created_at: baseline.created_at
  };
}

// ─── Netlify Function Handler ────────────────────────────────────────────────────

export default async (req, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let action = 'status';

    if (req.method === 'POST') {
      const body = await req.json();
      action = body.action || 'status';
    }

    if (action === 'run') {
      // Run ONE iteration (fits within timeout)
      const result = await runSingleIteration();
      return new Response(JSON.stringify({
        success: true,
        action: 'run',
        experiments_run: 1,
        results: [result.experiment],
        current_baseline: result.current_baseline
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'history') {
      const experiments = await loadExperiments();
      const baseline = await loadBaseline();
      return new Response(JSON.stringify({
        success: true,
        action: 'history',
        total_experiments: experiments.length,
        experiments,
        current_baseline: baseline ? summarizeBaseline(baseline) : null
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'reset') {
      // Reset experiments (for testing)
      await saveExperiments([]);
      await saveBaseline(null);
      return new Response(JSON.stringify({
        success: true,
        action: 'reset',
        message: 'Loop Engine state cleared'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Default: status
    const baseline = await loadBaseline();
    const experiments = await loadExperiments();
    return new Response(JSON.stringify({
      success: true,
      action: 'status',
      loop_engine: {
        name: 'Loop Engine',
        description: 'Self-optimizing outbound email loop using keep-or-revert pattern',
        total_experiments: experiments.length,
        kept_count: experiments.filter(e => e.decision === 'kept').length,
        reverted_count: experiments.filter(e => e.decision === 'reverted').length,
        current_baseline: baseline ? summarizeBaseline(baseline) : { id: 'baseline_v0', version: 0, description: 'Default', score: null },
        locked_guardrails: [
          'GAP methodology (current state → future state → cost of gap)',
          'Never fabricate signals — must be real and source-linked',
          '~100 word brevity constraint',
          'Single CTA only',
          'A-Gent Fleet signature'
        ]
      }
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({
      success: false,
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 3)
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

export const config = {
  path: "/api/loop-engine"
};
