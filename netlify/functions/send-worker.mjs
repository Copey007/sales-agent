/**
 * Send Worker — Netlify Background Function (batched)
 * 
 * Receives a batch of email_send IDs + campaign_id from the Queue Manager.
 * For each send:
 *   1. Load the campaign persona/signal_config/sequence
 *   2. Fetch the prospect
 *   3. Pull a live signal via SerpAPI per the campaign's signal_config
 *   4. Generate the GAP email via the LLM
 *   5. Send via Resend using the campaign's sending_domain
 *   6. Update email_sends to status='sent'
 * 
 * After the batch, if Loop Engine is enabled and an experiment is due,
 * trigger the per-campaign Loop Engine iteration.
 * 
 * Keeps batches small (≤10) to stay inside the Netlify timeout.
 */

import {
  getCampaign, getCampaignPersona, getCampaignSignalConfig,
  getCampaignSequence, getProspect, getEmailSend, putEmailSend,
  logActivity, getFeatureFlag, DEFAULTS
} from "./_campaign-store.mjs";
import { callLLM, parseLLMJson, getLLMConfig } from "./_llm.mjs";

// ─── Signal Gathering (campaign-aware) ──────────────────────────────────────

async function webSearch(query) {
  const serpApiKey = (typeof Netlify !== 'undefined' && Netlify.env?.get('SERP_API_KEY'))
    ? Netlify.env.get('SERP_API_KEY')
    : process.env.SERP_API_KEY;

  if (!serpApiKey) return [];

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
  } catch (e) { /* graceful degradation */ }
  return [];
}

function detectSignalType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('funding') || lower.includes('raised') || lower.includes('series')) return 'funding';
  if (lower.includes('hiring') || lower.includes('job') || lower.includes('career')) return 'hiring';
  if (lower.includes('ceo') || lower.includes('cto') || lower.includes('appointed')) return 'executive_change';
  if (lower.includes('launch') || lower.includes('released') || lower.includes('announced')) return 'product_launch';
  return 'company_news';
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

async function gatherSignalsForProspect(prospect, signalConfig) {
  const signals = [];
  const company = prospect.company_name;
  const contactName = prospect.contact_name;

  // Use campaign-specific query templates if available
  const queryTemplates = signalConfig?.serp_query_templates || [
    "{company} news {year}",
    "{company} hiring sales",
    "{contact_name} {company} LinkedIn"
  ];

  const year = new Date().getFullYear();
  const queries = queryTemplates.map(t =>
    t.replace('{company}', company || '')
      .replace('{contact_name}', contactName || '')
      .replace('{year}', year.toString())
  ).filter(q => q.trim().length > 3);

  // Run up to 2 queries to stay within timeout
  for (const q of queries.slice(0, 2)) {
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

  return signals;
}

// ─── GAP Email Generation (campaign-aware) ──────────────────────────────────

const GAP_SYSTEM_PROMPT = `You are an expert cold email writer trained in the GAP Prospecting methodology. Write short, problem-centric outbound emails.

## RULES:
1. **Signal Opener** (1 sentence): Reference a REAL signal with source
2. **Current State / Problem** (1-2 sentences): Map signal to business PAIN
3. **Credibility / Future State** (1 sentence): How you solve this
4. **CTA** (1 sentence): ONE low-friction, problem-centric question

### Constraints:
- UNDER 100 WORDS total (excluding signature)
- NEVER fabricate signals — use only what's provided
- Single CTA only, phrased as a question
- Subject line: 2-4 words, sentence case, problem-relevant
- Signature: [Sender Name] | A-Gent Fleet
- No fluff, no buzzwords, no feature dumps

### Output: Return ONLY valid JSON:
{"subject":"...","body":"...","signals_used":[{"type":"...","source_url":"...","why":"..."}],"gap_analysis":{"current_state":"...","future_state":"...","cost_of_gap":"..."}}`;

async function generateEmail(prospect, signals, persona, campaign) {
  const senderName = campaign?.sender_name || "Mark";

  let userPrompt = `## Prospect
- Name: ${prospect.contact_name}
- Company: ${prospect.company_name || 'Unknown'}
- Role: ${prospect.role || prospect.title || 'Unknown'}
- Industry: ${prospect.industry || 'Unknown'}

## Signals (${signals.length})
`;
  if (signals.length === 0) {
    userPrompt += `No signals found. Use a generic industry catalyst.\n`;
  } else {
    for (const s of signals) {
      userPrompt += `- [${s.type}] ${s.title} — ${s.source_url}\n  ${s.detail}\n`;
    }
  }

  // Inject persona context if available
  if (persona) {
    userPrompt += `\n## Campaign Persona Context
- Target Role: ${persona.target_role}
- Pain Points: ${(persona.pain_points || []).join('; ')}
- Messaging Angle: ${persona.messaging_angle || ''}
- GAP Current State: ${persona.gap_current_state || ''}
- GAP Future State: ${persona.gap_future_state || ''}
`;
  }

  userPrompt += `\n## Sender: ${senderName} | A-Gent Fleet
## Task: Write a GAP email. Return valid JSON only.`;

  const content = await callLLM([
    { role: 'system', content: GAP_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ], { model: 'claude-haiku-4-5', maxTokens: 1500 });

  try {
    return parseLLMJson(content);
  } catch (e) {
    return { subject: 'outbound', body: content, signals_used: [], gap_analysis: {} };
  }
}

// ─── Email Sending via Resend ───────────────────────────────────────────────

async function sendViaResend(emailData, prospect, campaign) {
  const resendApiKey = (typeof Netlify !== 'undefined' && Netlify.env?.get('RESEND_API_KEY'))
    ? Netlify.env.get('RESEND_API_KEY')
    : process.env.RESEND_API_KEY;

  if (!resendApiKey) {
    return { sent: false, reason: "RESEND_API_KEY not configured", simulated: true };
  }

  const sendingDomain = campaign?.sending_domain || 'a-gent.co';
  const senderName = campaign?.sender_name || 'Mark';
  const fromEmail = `A-Gent Fleet <fleet@${sendingDomain}>`;
  const toEmail = prospect.email;

  if (!toEmail) {
    return { sent: false, reason: "Prospect has no email address", simulated: true };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendApiKey}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: emailData.subject,
        text: emailData.body,
        reply_to: 'fleet@a-gent.co'
      })
    });

    if (response.ok) {
      const result = await response.json();
      return { sent: true, resend_id: result.id, from: fromEmail, to: toEmail };
    } else {
      const errText = await response.text();
      return { sent: false, reason: `Resend API error: ${errText}`, simulated: false };
    }
  } catch (err) {
    return { sent: false, reason: err.message, simulated: false };
  }
}

// ─── Process a Single Send ──────────────────────────────────────────────────

async function processSend(sendId, campaign, persona, signalConfig) {
  const send = await getEmailSend(sendId);
  if (!send || send.status === 'sent') {
    return { skipped: true, reason: send ? 'already sent' : 'send not found' };
  }

  const prospect = await getProspect(send.prospect_id);
  if (!prospect) {
    send.status = "failed";
    send.error = "Prospect not found";
    send.failed_at = new Date().toISOString();
    await putEmailSend(send);
    return { failed: true, reason: 'prospect not found' };
  }

  // 1. Gather signals
  const signals = await gatherSignalsForProspect(prospect, signalConfig);

  // 2. Generate GAP email
  const emailData = await generateEmail(prospect, signals, persona, campaign);

  // 3. Send via Resend
  const sendResult = await sendViaResend(emailData, prospect, campaign);

  // 4. Update send record
  send.status = sendResult.sent ? "sent" : (sendResult.simulated ? "simulated" : "failed");
  send.sent_at = new Date().toISOString();
  send.email_subject = emailData.subject;
  send.email_body = emailData.body;
  send.signals_used = emailData.signals_used || [];
  send.gap_analysis = emailData.gap_analysis || {};
  send.resend_result = sendResult;
  await putEmailSend(send);

  return {
    send_id: sendId,
    prospect: prospect.contact_name,
    status: send.status,
    subject: emailData.subject,
    signals_count: signals.length,
    send_result: sendResult
  };
}

// ─── Netlify Function Handler ───────────────────────────────────────────────

export default async (req, context) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await req.json();
    const { campaign_id, send_ids, batch_index } = body;

    if (!campaign_id || !send_ids || !Array.isArray(send_ids)) {
      return new Response(JSON.stringify({
        error: 'campaign_id and send_ids[] required'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Load campaign config
    const campaign = await getCampaign(campaign_id);
    if (!campaign) {
      return new Response(JSON.stringify({ error: 'Campaign not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const persona = await getCampaignPersona(campaign_id);
    const signalConfig = await getCampaignSignalConfig(campaign_id);
    const sequence = await getCampaignSequence(campaign_id);

    // Process each send in the batch (sequentially to manage timeout)
    const results = [];
    for (const sendId of send_ids.slice(0, BATCH_SIZE)) {
      try {
        const result = await processSend(sendId, campaign, persona, signalConfig);
        results.push(result);
      } catch (sendErr) {
        results.push({ send_id: sendId, failed: true, error: sendErr.message });
      }
    }

    // Log batch activity
    await logActivity({
      type: "send_worker_batch",
      campaign_id,
      campaign_name: campaign.name,
      batch_index: batch_index || 0,
      sends_processed: results.length,
      sends_sent: results.filter(r => r.status === 'sent').length,
      sends_simulated: results.filter(r => r.status === 'simulated').length,
      sends_failed: results.filter(r => r.failed).length
    });

    // Check if Loop Engine iteration is due (after batch)
    if (sequence?.loop_enabled) {
      const loopDue = await shouldTriggerLoopIteration(campaign_id);
      if (loopDue) {
        // Fire-and-forget loop iteration
        try {
          const siteUrl = (typeof Netlify !== 'undefined' && Netlify.env?.get('URL'))
            ? Netlify.env.get('URL')
            : (process.env.URL || 'https://aisdr.a-gent.co');
          await fetch(`${siteUrl}/api/loop-engine`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'run', campaign_id })
          });
        } catch (e) { /* non-critical */ }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      campaign_id,
      batch_index: batch_index || 0,
      results,
      processed_at: new Date().toISOString()
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      success: false,
      error: err.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

const BATCH_SIZE = 10;

// Check if enough sends have happened since last loop iteration
async function shouldTriggerLoopIteration(campaignId) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("loop-engine");
    const raw = await store.get(`loop_state_${campaignId}`);
    const state = raw ? JSON.parse(raw) : { last_iteration_at: null, sends_since_last: 0 };
    
    // Trigger every 25 sends
    state.sends_since_last = (state.sends_since_last || 0) + 1;
    await store.set(`loop_state_${campaignId}`, JSON.stringify(state));
    
    return state.sends_since_last >= 25;
  } catch (e) {
    return false;
  }
}

export const config = {
  path: "/api/send-worker"
};
