/**
 * Queue Manager — Netlify Scheduled Function (every 5 minutes)
 * 
 * Polls the email_sends ledger for due queued sends, groups by campaign,
 * enforces daily_send_limit (with warmup override), runs suppression check,
 * and dispatches batches of up to 10 to the Send Worker.
 * 
 * Feature-flagged: only runs when "multi_campaign_orchestration" and
 * "queue_manager_active" flags are both enabled.
 */

import {
  getFeatureFlag, listActiveCampaigns, getCampaign,
  listQueuedSends, countSentToday, isEmailSuppressed,
  getProspect, putEmailSend, logActivity, DEFAULTS
} from "./_campaign-store.mjs";
import { internalHeaders } from "./_auth.mjs";

// Max LLM draft generations per campaign per run (drafts never send on their own).
const DRAFTS_PER_RUN = 10;

// ─── Configuration ──────────────────────────────────────────────────────────

const BATCH_SIZE = 10;
const WARMUP_SCHEDULE = [
  // Day 1-3: 10/day, Day 4-7: 25/day, Day 8-14: 50/day, Day 15+: campaign limit
  { days: 3, limit: 10 },
  { days: 7, limit: 25 },
  { days: 14, limit: 50 }
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getEffectiveDailyLimit(campaign) {
  const maxLimit = Number(
    (typeof Netlify !== 'undefined' && Netlify.env?.get('MAX_DAILY_SEND_LIMIT')) || process.env.MAX_DAILY_SEND_LIMIT || 50
  ) || 50;
  return Math.min(maxLimit, getWarmupLimit(campaign));
}

function getWarmupLimit(campaign) {
  const campaignAge = Math.floor(
    (Date.now() - new Date(campaign.created_at).getTime()) / (1000 * 60 * 60 * 24)
  );
  
  // Check warmup schedule
  for (const tier of WARMUP_SCHEDULE) {
    if (campaignAge <= tier.days) {
      return Math.min(tier.limit, campaign.daily_send_limit || 50);
    }
  }
  
  return campaign.daily_send_limit || 50;
}

function getSendWorkerUrl() {
  // In Netlify, invoke the background function via internal URL
  const siteUrl = (typeof Netlify !== 'undefined' && Netlify.env?.get('URL'))
    ? Netlify.env.get('URL')
    : (process.env.URL || 'https://aisdr.a-gent.co');
  return `${siteUrl}/api/send-worker`;
}

// ─── Main Queue Processing ──────────────────────────────────────────────────

async function processQueue() {
  const now = new Date();
  const results = {
    campaigns_checked: 0,
    sends_dispatched: 0,
    sends_suppressed: 0,
    sends_over_limit: 0,
    batches_dispatched: 0,
    errors: []
  };

  // Get all active campaigns
  const campaigns = await listActiveCampaigns(DEFAULTS.TENANT_ID);
  results.campaigns_checked = campaigns.length;

  for (const campaign of campaigns) {
    try {
      // Check daily limit
      const sentToday = await countSentToday(campaign.id);
      const effectiveLimit = getEffectiveDailyLimit(campaign);
      const remainingBudget = effectiveLimit - sentToday;

      // Get queued sends that are due
      const queuedSends = await listQueuedSends(campaign.id);
      const dueSends = queuedSends.filter(s => new Date(s.scheduled_at) <= now);

      if (dueSends.length === 0) continue;

      // Approved sends deliver (count against the daily cap); unapproved ones
      // only get a draft generated (status → pending_approval, no delivery).
      const approvedDue = dueSends.filter(s => s.approved_at);
      const draftDue = dueSends.filter(s => !s.approved_at).slice(0, DRAFTS_PER_RUN);

      // Apply suppression check and budget limit
      const eligibleSends = [];
      let approvedTaken = 0;
      for (const send of [...approvedDue, ...draftDue]) {
        if (send.approved_at) {
          if (approvedTaken >= Math.max(0, remainingBudget)) {
            results.sends_over_limit++;
            continue;
          }
          approvedTaken++;
        }

        // Check suppression
        const prospect = await getProspect(send.prospect_id);
        if (prospect && await isEmailSuppressed(DEFAULTS.TENANT_ID, prospect.email)) {
          // Mark as suppressed
          send.status = "suppressed";
          send.suppressed_at = now.toISOString();
          send.suppression_reason = "email_on_suppression_list";
          await putEmailSend(send);
          results.sends_suppressed++;
          continue;
        }

        eligibleSends.push(send);
      }

      // Dispatch in batches of BATCH_SIZE
      for (let i = 0; i < eligibleSends.length; i += BATCH_SIZE) {
        const batch = eligibleSends.slice(i, i + BATCH_SIZE);
        const batchIds = batch.map(s => s.id);

        // Mark as dispatched
        for (const send of batch) {
          send.status = "dispatched";
          send.dispatched_at = now.toISOString();
          await putEmailSend(send);
        }

        // Invoke Send Worker (fire-and-forget for background processing)
        try {
          const workerUrl = getSendWorkerUrl();
          const workerRes = await fetch(workerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...internalHeaders() },
            body: JSON.stringify({
              campaign_id: campaign.id,
              send_ids: batchIds,
              batch_index: Math.floor(i / BATCH_SIZE),
              dispatched_at: now.toISOString()
            })
          });
          // fetch() does not throw on 4xx/5xx — without this check a 404/403
          // leaves the batch stuck in "dispatched" forever.
          if (!workerRes.ok) throw new Error(`send-worker responded ${workerRes.status}`);
          results.batches_dispatched++;
          results.sends_dispatched += batch.length;
        } catch (dispatchErr) {
          // Revert to queued on dispatch failure
          for (const send of batch) {
            send.status = "queued";
            send.dispatched_at = null;
            await putEmailSend(send);
          }
          results.errors.push(`Dispatch failed for campaign ${campaign.id}: ${dispatchErr.message}`);
        }
      }

      // Log activity
      await logActivity({
        type: "queue_manager_dispatch",
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        sends_dispatched: eligibleSends.length,
        sends_suppressed: results.sends_suppressed,
        daily_budget_remaining: remainingBudget - eligibleSends.length,
        effective_limit: effectiveLimit,
        sent_today: sentToday
      });

    } catch (campaignErr) {
      results.errors.push(`Campaign ${campaign.id}: ${campaignErr.message}`);
    }
  }

  return results;
}

// ─── Netlify Scheduled Function Handler ─────────────────────────────────────

export default async (req, context) => {
  // Scheduled-only function (no public path) → no CORS needed.
  const corsHeaders = {};

  try {
    // Feature flag check
    const orchestrationEnabled = await getFeatureFlag("multi_campaign_orchestration");
    const queueManagerActive = await getFeatureFlag("queue_manager_active");

    if (!orchestrationEnabled || !queueManagerActive) {
      const reason = !orchestrationEnabled 
        ? "multi_campaign_orchestration flag is OFF" 
        : "queue_manager_active flag is OFF";
      
      await logActivity({
        type: "queue_manager_skipped",
        reason,
        checked_at: new Date().toISOString()
      });

      return new Response(JSON.stringify({
        success: true,
        action: "skipped",
        reason,
        message: "Queue Manager is feature-flagged OFF. Enable via /api/campaign-admin?action=set_flag"
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Run queue processing
    const results = await processQueue();

    await logActivity({
      type: "queue_manager_run",
      results,
      completed_at: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      action: "processed",
      results,
      next_run: "in ~5 minutes (scheduled)",
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    await logActivity({
      type: "queue_manager_error",
      error: err.message,
      timestamp: new Date().toISOString()
    });

    console.error('[queue-manager]', err.message, err.stack);
    return new Response(JSON.stringify({
      success: false,
      error: 'internal_error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

export const config = {
  // Scheduled only — Netlify does not allow `path` AND `schedule` on the
  // same function. The cron fires every 5 minutes; for manual testing,
  // wait for the cron or invoke the equivalent logic via send-worker.
  // Standard cron (UTC). Keep in sync with netlify.toml [functions."queue-manager"].
  schedule: "*/5 * * * *"
};
