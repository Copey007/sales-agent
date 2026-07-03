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
  getProspect, putProspect, putCampaignProspect,
  putEmailSend, logActivity, listRecords, DEFAULTS
} from "./_campaign-store.mjs";
import { sb } from "./_supabase-rest.mjs";

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

const NEW_OUTREACH_COOLDOWN_MS = 5 * 24 * 60 * 60 * 1000;

async function processQueue() {
  const now = new Date();
  const results = {
    campaigns_checked: 0,
    sends_dispatched: 0,
    sends_suppressed: 0,
    sends_cancelled_replied: 0,
    sends_cooldown_postponed: 0,
    sends_over_limit: 0,
    batches_dispatched: 0,
    topups_triggered: 0,
    errors: []
  };

  // Get all active campaigns
  const campaigns = await listActiveCampaigns(DEFAULTS.TENANT_ID);
  results.campaigns_checked = campaigns.length;

  // Cross-campaign dedup context: last successful send per prospect, loaded
  // once per run. Used to stop NEW (step-1) outreach to anyone emailed by any
  // campaign within the cooldown window — follow-ups inside a cadence are exempt.
  const lastSentByProspect = {};
  try {
    for (const s of await listRecords("email_sends")) {
      if (s.status === "sent" && s.sent_at && s.prospect_id) {
        if (!lastSentByProspect[s.prospect_id] || s.sent_at > lastSentByProspect[s.prospect_id]) {
          lastSentByProspect[s.prospect_id] = s.sent_at;
        }
      }
    }
  } catch (e) { /* cooldown map is best-effort */ }

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

        // Replied guard: never email a prospect who already replied
        if (prospect && (prospect.replied_at || prospect.status === 'replied')) {
          send.status = "cancelled_replied";
          send.cancelled_at = now.toISOString();
          await putEmailSend(send);
          results.sends_cancelled_replied++;
          continue;
        }

        // Cross-campaign cooldown: don't START new outreach (step 1) to anyone
        // any campaign emailed within the window; postpone instead of cancel.
        // Follow-ups (step 2+) run on their own cadence and are exempt.
        if ((Number(send.step_number) || 1) === 1) {
          const last = lastSentByProspect[send.prospect_id];
          if (last && (now.getTime() - new Date(last).getTime()) < NEW_OUTREACH_COOLDOWN_MS) {
            send.scheduled_at = new Date(new Date(last).getTime() + NEW_OUTREACH_COOLDOWN_MS).toISOString();
            send.postponed_reason = "cross_campaign_cooldown";
            await putEmailSend(send);
            results.sends_cooldown_postponed++;
            continue;
          }
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

  // Pool feeder: enrolled contacts wait in Supabase contact_pool
  // (sdr_state=awaiting) so a 1000-contact campaign never bloats the send
  // ledger. Each cycle, campaigns whose queue runs low get the next batch.
  const FEEDER_MIN_QUEUE = 40, FEEDER_BATCH = 30;
  for (const campaign of campaigns) {
    try {
      const queued = await listQueuedSends(campaign.id);
      if (queued.length >= FEEDER_MIN_QUEUE) continue;
      const awaiting = await sb(`contact_pool?campaign_id=eq.${campaign.id}&sdr_state=eq.awaiting&order=enrolled_at.asc&limit=${FEEDER_BATCH}`);
      if (!Array.isArray(awaiting) || !awaiting.length) continue;
      let fed = 0;
      for (const c of awaiting) {
        const prospect = {
          id: crypto.randomUUID(),
          tenant_id: DEFAULTS.TENANT_ID,
          contact_name: c.name,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          title: c.title,
          company_name: c.company_name,
          company_domain: c.company_domain,
          hunter_confidence: c.hunter_confidence,
          source: 'researcher_pool',
          created_at: now.toISOString()
        };
        await putProspect(prospect);
        await putCampaignProspect({ campaign_id: campaign.id, prospect_id: prospect.id, enrolled_at: now.toISOString(), status: 'active' });
        await putEmailSend({
          id: crypto.randomUUID(),
          tenant_id: DEFAULTS.TENANT_ID,
          campaign_id: campaign.id,
          prospect_id: prospect.id,
          step_number: 1,
          status: 'queued',
          scheduled_at: new Date(Date.now() + fed * 120000).toISOString(),
          created_at: now.toISOString(),
          enqueued_by: 'pool_feeder'
        });
        await sb(`contact_pool?id=eq.${c.id}`, { method: 'PATCH', body: { sdr_state: 'queued' }, prefer: 'return=minimal' });
        fed++;
      }
      if (fed) {
        results.feeder_fed = (results.feeder_fed || 0) + fed;
        await logActivity({ type: 'pool_feeder', campaign_id: campaign.id, campaign_name: campaign.name, fed });
      }
    } catch (e) { /* feeder is per-campaign best-effort */ }
  }

  // Auto-source top-up trigger: piggyback on this reliable 5-minute cron.
  // If an opted-in campaign's queue has run dry, fire the researcher to refill
  // it (the researcher rate-limits itself to one sourcing run per 6h/campaign).
  try {
    const needsTopUp = [];
    for (const campaign of campaigns) {
      if (campaign.auto_source !== true) continue;
      const queued = await listQueuedSends(campaign.id);
      const minQueue = Number(campaign.auto_source_min_queue) || 5;
      if (queued.length < minQueue) needsTopUp.push(campaign);
    }
    if (needsTopUp.length) {
      const siteUrl = (typeof Netlify !== 'undefined' && Netlify.env?.get('URL'))
        ? Netlify.env.get('URL')
        : (process.env.URL || 'https://aisdr.a-gent.co');
      // No campaign_id in the body → researcher runs its top-up sweep, which
      // re-checks queue depth + per-campaign 6h cooldown before sourcing.
      await fetch(`${siteUrl}/.netlify/functions/researcher-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }).catch(() => {});
      results.topups_triggered = needsTopUp.length;
    }
  } catch (e) { /* top-up is best-effort; sends were already processed */ }

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
  // Scheduled only — Netlify does not allow `path` AND `schedule` on the
  // same function. The cron fires every 5 minutes; for manual testing,
  // wait for the cron or invoke the equivalent logic via send-worker.
  schedule: "@every 5m"
};
