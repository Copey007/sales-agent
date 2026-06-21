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

import { getStore } from "@netlify/blobs";
import {
  getFeatureFlag, listActiveCampaigns, getCampaign,
  listQueuedSends, countSentToday, isEmailSuppressed,
  getProspect, putEmailSend, logActivity, DEFAULTS
} from "./lib/campaign-store.mjs";

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

      if (remainingBudget <= 0) {
        results.sends_over_limit++;
        continue;
      }

      // Get queued sends that are due
      const queuedSends = await listQueuedSends(campaign.id);
      const dueSends = queuedSends.filter(s => new Date(s.scheduled_at) <= now);

      if (dueSends.length === 0) continue;

      // Apply suppression check and budget limit
      const eligibleSends = [];
      for (const send of dueSends) {
        if (eligibleSends.length >= remainingBudget) {
          results.sends_over_limit += (dueSends.length - eligibleSends.length);
          break;
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
          await fetch(workerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              campaign_id: campaign.id,
              send_ids: batchIds,
              batch_index: Math.floor(i / BATCH_SIZE),
              dispatched_at: now.toISOString()
            })
          });
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
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

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

    return new Response(JSON.stringify({
      success: false,
      error: err.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

export const config = {
  path: "/api/queue-manager",
  schedule: "@every 5m"
};
