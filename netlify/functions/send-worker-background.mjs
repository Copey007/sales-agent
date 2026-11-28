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

import { stealthWriteBlocked } from './_tenant.mjs';
import {
  getCampaign, getCampaignPersona, getCampaignSignalConfig,
  getCampaignSequence, getProspect, getEmailSend, putEmailSend,
  listCampaignSends, logActivity, getFeatureFlag, isEmailSuppressed, DEFAULTS
} from "./_campaign-store.mjs";
import { callLLM, parseLLMJson, getLLMConfig } from "./_llm.mjs";
import { requireInternal, internalHeaders, siteUrl, env as authEnv } from "./_auth.mjs";
import { complianceOrBlock } from "./_email-compliance.mjs";
import { isHomeTenant } from "./_tenant.mjs";

/** RefoundGTM stealth tenant — never append A-Gent or AskArlen brand copy. */
export const REFOUND_GTM_TENANT_ID = '293f61ad-0d46-460e-b0f2-e69c9462001a';
export const ASKARLEN_OUTBOUND_CTA = 'Get GTM done with AskArlen: https://askarlen.com';


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

// ─── Signal Validation ──────────────────────────────────────────────────────
// Name-based web search can match the WRONG company (e.g. a Belgian staffing
// agency also called "A-gent"). A signal is only usable when it's anchored to
// the prospect's actual domain. No known domain → no company-specific signals;
// the email falls back to the generic industry-catalyst angle instead of
// risking a wrong-company claim.

function validateSignals(signals, prospect) {
  const domain = String(prospect.company_domain || '')
    .toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!domain) return [];
  const brand = domain.split('.')[0];
  return signals.filter(s => {
    const hay = `${s.title || ''} ${s.detail || ''} ${s.source_url || ''}`.toLowerCase();
    if (hay.includes(domain)) return true;                       // exact domain — strong
    if (brand.length > 2 && hay.includes(brand)) {
      // Same brand word under a DIFFERENT TLD (a-gent.be vs a-gent.co) = wrong company
      const otherTld = new RegExp(`${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?!${domain.split('.').slice(1).join('\\.')})[a-z]{2,}`, 'i');
      return !otherTld.test(hay);
    }
    return false;
  });
}

// ─── Signature Enforcement ──────────────────────────────────────────────────
// The brand CTA is a locked guardrail — never trust the LLM to remember it.
// Appended only for A-Gent/AskArlen tenants (isHomeTenant). RefoundGTM and
// every other tenant are left unchanged: we never invent a stealth signature
// and we never append AskArlen or A-Gent copy onto their bodies.

export function ensureFleetSignature(body, senderName, tenantId) {
  let out = String(body || '').trimEnd();
  const tid = String(tenantId || '').toLowerCase();
  if (tid === REFOUND_GTM_TENANT_ID || !isHomeTenant(tid)) {
    return out;
  }
  if (!/A-Gent Fleet/i.test(out)) {
    out += `\n\n${senderName} | A-Gent Fleet`;
  }
  if (/Deploy your A-Gent Fleet: https:\/\/a-gent\.co/.test(out)) {
    out = out.replace(/Deploy your A-Gent Fleet: https:\/\/a-gent\.co/g, ASKARLEN_OUTBOUND_CTA);
  } else if (!out.includes('https://askarlen.com')) {
    out += `\n${ASKARLEN_OUTBOUND_CTA}`;
  }
  return out;
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

async function generateEmail(prospect, signals, persona, campaign, stepNumber = 1) {
  const senderName = campaign?.sender_name || "Mark";

  // Field normalization: researcher-background saves `name`, but earlier flows used
  // `contact_name`. Support both so the GAP prompt always has a name to work with.
  const prospectName = prospect.contact_name || prospect.name ||
    [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') ||
    null;

  let userPrompt = `## Prospect
- Name: ${prospectName || 'Unknown'}
- Company: ${prospect.company_name || 'Unknown'}
- Role: ${prospect.title || prospect.role || 'Unknown'}
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

  if (stepNumber > 1) {
    userPrompt += `\n## Sequence Context
This is FOLLOW-UP #${stepNumber - 1} to a prospect who has not replied to earlier emails in this thread.
Write a SHORT follow-up (40-70 words): reference that you reached out before without guilt-tripping,
add ONE new angle or piece of value (a different signal, a sharper question, or a relevant proof point),
and keep the same single CTA. Subject should read as a natural thread continuation (it may start with "Re:").
Do NOT repeat the original email's framing.\n`;
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

  const sendingDomain = campaign?.sending_domain || authEnv('SENDING_DOMAIN', 'a-gent.co');
  const fromName = authEnv('SENDER_FROM_NAME', 'A-Gent Fleet');
  const fromAddress = authEnv('SENDER_FROM_EMAIL', `fleet@${sendingDomain}`);
  const replyTo = authEnv('REPLY_TO_EMAIL', fromAddress);
  const fromEmail = `${fromName} <${fromAddress}>`;
  const toEmail = prospect.email;

  if (!toEmail) {
    return { sent: false, reason: "Prospect has no email address", simulated: true };
  }
  const sendTenantId = prospect.tenant_id || campaign?.tenant_id || DEFAULTS.TENANT_ID;
  if (stealthWriteBlocked(sendTenantId)) {
    return { sent: false, reason: 'stealth_readonly', blocked: true };
  }
  if (await isEmailSuppressed(sendTenantId, toEmail)) {
    return { sent: false, reason: "email_on_suppression_list", suppressed: true };
  }
  // CAN-SPAM: physical postal address + working opt-out are mandatory.
  const compliance = complianceOrBlock({ replyTo, toEmail, tenantId: prospect.tenant_id || campaign?.tenant_id || DEFAULTS.TENANT_ID });
  if (!compliance.ok) {
    return { sent: false, reason: compliance.reason, simulated: false, blocked: true };
  }
  const footer = compliance.footer;

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
        text: `${emailData.body}${footer}`,
        reply_to: replyTo,
        headers: { ...compliance.headers }
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

// ─── Follow-Up Engine ───────────────────────────────────────────────────────
// After a successful send of step N, schedule step N+1 per the campaign
// sequence's step_delays_days cadence. Guards: cadence complete, follow-ups
// disabled on the campaign, prospect already replied, or step already queued.

const DEFAULT_STEP_DELAYS = [0, 3, 3, 4, 5, 5, 7, 7, 7, 10, 10, 14];

async function enqueueNextStep(send, prospect, campaign, sequence) {
  if (campaign?.followups_enabled === false) return null;
  const delays = (sequence?.step_delays_days && sequence.step_delays_days.length)
    ? sequence.step_delays_days
    : DEFAULT_STEP_DELAYS;
  const nextStep = (Number(send.step_number) || 1) + 1;
  if (nextStep > delays.length) return null; // cadence complete
  if (prospect?.replied_at || prospect?.status === 'replied') return null;

  // Dedup: never double-book the same prospect+step in this campaign
  const existing = (await listCampaignSends(campaign.id)).find(s =>
    s.prospect_id === send.prospect_id &&
    Number(s.step_number) === nextStep &&
    ['queued', 'dispatched', 'sent'].includes(s.status)
  );
  if (existing) return null;

  const delayDays = Number(delays[nextStep - 1]) || 3;
  const next = {
    // Deterministic id: one follow-up slot per prospect+step per campaign.
    // A double-processed step-1 now OVERWRITES the same follow-up record
    // instead of creating a duplicate (the Blobs-list dedup check above is
    // eventually consistent and can miss a sibling written seconds ago).
    id: `fu_${campaign.id}_${send.prospect_id}_s${nextStep}`,
    tenant_id: send.tenant_id || campaign.tenant_id || DEFAULTS.TENANT_ID,
    campaign_id: campaign.id,
    prospect_id: send.prospect_id,
    step_number: nextStep,
    status: 'queued',
    scheduled_at: new Date(Date.now() + delayDays * 86400000).toISOString(),
    created_at: new Date().toISOString(),
    enqueued_by: 'follow_up_engine',
    parent_send_id: send.id
  };
  await putEmailSend(next);
  return next;
}

// ─── Process a Single Send ──────────────────────────────────────────────────

async function processSend(sendId, campaign, persona, signalConfig, sequence, { dryRun = false } = {}) {
  const send = await getEmailSend(sendId);
  if (!send) return { skipped: true, reason: 'send not found' };
  // Only sends the queue-manager (or campaign-admin trigger_queue) marked as
  // dispatched are processed — never 'sent', 'suppressed', 'failed',
  // 'pending_approval', 'rejected', etc. Blocks direct re-send of any record.
  if (send.status !== 'dispatched') {
    return { send_id: sendId, skipped: true, reason: `status is ${send.status}, expected dispatched` };
  }
  if (send.campaign_id && send.campaign_id !== campaign.id) {
    return { send_id: sendId, skipped: true, reason: 'send does not belong to this campaign' };
  }

  const prospect = await getProspect(send.prospect_id);
  if (!prospect) {
    send.status = "failed";
    send.error = "Prospect not found";
    send.failed_at = new Date().toISOString();
    await putEmailSend(send);
    return { failed: true, reason: 'prospect not found' };
  }

  // Last-moment suppression re-check (the list can change after queueing).
  const tenantId = send.tenant_id || campaign.tenant_id || DEFAULTS.TENANT_ID;
  if (stealthWriteBlocked(tenantId) || stealthWriteBlocked(prospect.tenant_id)) {
    return { send_id: sendId, skipped: true, reason: 'stealth_readonly', blocked: true };
  }
  if (prospect.email && await isEmailSuppressed(tenantId, prospect.email)) {
    send.status = "suppressed";
    send.suppressed_at = new Date().toISOString();
    send.suppression_reason = "email_on_suppression_list";
    await putEmailSend(send);
    return { send_id: sendId, status: 'suppressed' };
  }
  if (prospect.replied_at || prospect.status === 'replied') {
    send.status = "cancelled_replied";
    send.cancelled_at = new Date().toISOString();
    await putEmailSend(send);
    return { send_id: sendId, status: 'cancelled_replied' };
  }

  // ── Pass 1: no human approval yet → generate a DRAFT only. Nothing is sent. ──
  if (!send.approved_at) {
    const rawSignals = await gatherSignalsForProspect(prospect, signalConfig);
    const signals = validateSignals(rawSignals, prospect);
    const emailData = await generateEmail(prospect, signals, persona, campaign, Number(send.step_number) || 1);
    emailData.body = ensureFleetSignature(emailData.body, campaign?.sender_name || 'Mark', tenantId);
    send.status = "pending_approval";
    send.drafted_at = new Date().toISOString();
    send.email_subject = emailData.subject;
    send.email_body = emailData.body;
    send.signals_used = emailData.signals_used || [];
    send.signals_rejected_wrong_company = rawSignals.length - signals.length;
    send.gap_analysis = emailData.gap_analysis || {};
    await putEmailSend(send);
    return { send_id: sendId, status: 'pending_approval', subject: emailData.subject, signals_count: signals.length };
  }

  // ── Pass 2: approved → deliver EXACTLY the approved (possibly edited) text. ──
  if (!send.email_subject || !send.email_body) {
    send.status = "pending_approval";
    send.approved_at = null;
    send.error = "approved send had no stored draft; re-review required";
    await putEmailSend(send);
    return { send_id: sendId, status: 'pending_approval', reason: 'missing draft' };
  }
  const emailData = { subject: send.email_subject, body: send.email_body };

  if (dryRun || prospect.is_demo) {
    send.status = "simulated";
    send.sent_at = new Date().toISOString();
    send.resend_result = { sent: false, simulated: true, reason: dryRun ? 'dry_run' : 'demo prospect' };
    await putEmailSend(send);
    return { send_id: sendId, status: 'simulated' };
  }

  const sendResult = await sendViaResend(emailData, prospect, campaign);

  if (sendResult.blocked) {
    // Compliance config missing: keep it approved + queued so it goes out once configured.
    send.status = "queued";
    send.dispatched_at = null;
    send.error = sendResult.reason;
    await putEmailSend(send);
    return { send_id: sendId, status: 'blocked', reason: sendResult.reason };
  }

  send.status = sendResult.sent ? "sent" : (sendResult.simulated ? "simulated" : "failed");
  send.sent_at = new Date().toISOString();
  send.resend_result = sendResult;
  await putEmailSend(send);

  // Follow-up engine: schedule the next cadence step (it will be drafted and
  // held for approval like every other send).
  let nextStep = null;
  if (sendResult.sent) {
    try { nextStep = await enqueueNextStep(send, prospect, campaign, sequence); }
    catch (e) { console.error('[follow-up] enqueue failed:', e.message); }
  }

  return {
    send_id: sendId,
    prospect: prospect.contact_name,
    status: send.status,
    subject: emailData.subject,
    next_step_queued: nextStep ? { step: nextStep.step_number, at: nextStep.scheduled_at } : null,
    send_result: sendResult
  };
}

// ─── Netlify Function Handler ───────────────────────────────────────────────

export default async (req, context) => {
  // Server-to-server only (no browser callers) → no CORS headers at all.
  const corsHeaders = {};

  // Background functions are reachable at /.netlify/functions/send-worker-background,
  // so require the internal service token (queue-manager / campaign-admin send it).
  const denied = requireInternal(req);
  if (denied) return denied;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await req.json();
    const { campaign_id, send_ids, batch_index } = body;
    const dryRun = body.dry_run === true;

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
    if (stealthWriteBlocked(campaign.tenant_id)) {
      return new Response(JSON.stringify({ skipped: true, reason: 'stealth_readonly', campaign_id }), {
        status: 200,
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
        const result = await processSend(sendId, campaign, persona, signalConfig, sequence, { dryRun });
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
      sends_drafted: results.filter(r => r.status === 'pending_approval').length,
      sends_simulated: results.filter(r => r.status === 'simulated').length,
      sends_failed: results.filter(r => r.failed).length,
      sends_suppressed: results.filter(r => r.status === 'suppressed').length
    });

    // Check if Loop Engine iteration is due (after batch)
    if (sequence?.loop_enabled) {
      const loopDue = await shouldTriggerLoopIteration(campaign_id);
      if (loopDue) {
        // Fire-and-forget loop iteration
        try {
          await fetch(`${siteUrl()}/api/loop-engine`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...internalHeaders() },
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
    console.error('[send-worker-background]', err.message, err.stack);
    return new Response(JSON.stringify({
      success: false,
      error: 'internal_error'
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

// Background function (filename suffix): 15-minute budget so a batch of
// LLM-generated emails can never be killed mid-flight — the cause of the
// stuck-'dispatched' strays and double-processed sends.
export const config = {};
