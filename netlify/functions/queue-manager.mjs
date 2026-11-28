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

import { stealthWriteBlocked } from './_tenant.mjs';
import {
  getFeatureFlag, listAllActiveCampaigns, getCampaign,
  listQueuedSends, countSentToday, isEmailSuppressed,
  getProspect, putProspect, putCampaignProspect,
  putEmailSend, logActivity, listRecords, DEFAULTS
} from "./_campaign-store.mjs";
import { sb } from "./_supabase-rest.mjs";
import { internalHeaders, siteUrl, env as authEnv } from "./_auth.mjs";

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
function clampedDailyLimit(campaign) {
  return Math.min(getEffectiveDailyLimit(campaign), HARD_DAILY_CAP());
}

function getSendWorkerUrl() {
  // In Netlify, invoke the background function via internal URL
  return `${siteUrl()}/.netlify/functions/send-worker-background`;
}

// Human-approval gate: unapproved queued sends are only DRAFTED by the worker
// (status pending_approval). Cap how many drafts can wait per campaign and how
// many are generated per run so LLM/SerpAPI spend stays bounded.
const MAX_PENDING_DRAFTS = () => Math.max(0, Number(authEnv('MAX_PENDING_DRAFTS', '25')) || 25);
const DRAFTS_PER_RUN = () => Math.max(0, Number(authEnv('DRAFTS_PER_RUN', '10')) || 10);
const HARD_DAILY_CAP = () => Math.max(1, Number(authEnv('MAX_DAILY_SEND_LIMIT', '50')) || 50);

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

  // Get all active campaigns across every tenant — this cron has no JWT, so
  // each campaign's own tenant_id is the source of truth for scoping.
  const campaigns = await listAllActiveCampaigns();
  results.campaigns_checked = campaigns.length;

  // ONE ledger scan per run. Blobs listRecords costs one GET per record, so
  // repeated full scans (cooldown + per-campaign counts + feeder + top-up)
  // blew the 30s scheduled-function budget and got the run killed mid-work —
  // the bug that caused the feeder to re-feed the same contacts. Everything
  // below derives from this single in-memory list; the feeder keeps the
  // ledger small, so this stays fast at any campaign size.
  let allSends = [];
  try {
    allSends = await listRecords("email_sends");
  } catch (e) {
    results.errors.push(`ledger scan failed: ${e.message}`);
    return results;
  }
  // De-dupe the scan defensively: Blobs pagination has produced the same key
  // twice, and a duplicated ledger row means a double-dispatched email.
  {
    const seen = new Set();
    allSends = allSends.filter(s => s && s.id && !seen.has(s.id) && seen.add(s.id));
  }

  // Stale-dispatch recovery: a send marked dispatched with no Resend result
  // after 2h+ means its worker batch died before processing it. Requeue with
  // a retry cap so nothing is stranded forever.
  const STALE_DISPATCH_MS = 2 * 60 * 60 * 1000;
  for (const s of allSends) {
    if (s.status === "dispatched" && !s.resend_result &&
        s.dispatched_at && (now.getTime() - new Date(s.dispatched_at).getTime()) > STALE_DISPATCH_MS) {
      if ((s.redispatch_count || 0) >= 2) {
        s.status = "failed"; s.error = "stale dispatch, retries exhausted";
      } else {
        s.status = "queued"; s.redispatch_count = (s.redispatch_count || 0) + 1;
      }
      await putEmailSend(s);
      results.stale_recovered = (results.stale_recovered || 0) + 1;
    }
  }

  const today = now.toISOString().slice(0, 10);
  const queuedFor = (cid) => allSends.filter(s => s.campaign_id === cid && s.status === "queued");
  const sentTodayFor = (cid) => allSends.filter(s =>
    s.campaign_id === cid && s.status === "sent" && s.sent_at && s.sent_at.slice(0, 10) === today).length;

  // Cross-campaign dedup context: last successful send per prospect. Used to
  // stop NEW (step-1) outreach to anyone emailed by any campaign within the
  // cooldown window — follow-ups inside a cadence are exempt.
  const lastSentByProspect = {};
  for (const s of allSends) {
    if (s.status === "sent" && s.sent_at && s.prospect_id) {
      if (!lastSentByProspect[s.prospect_id] || s.sent_at > lastSentByProspect[s.prospect_id]) {
        lastSentByProspect[s.prospect_id] = s.sent_at;
      }
    }
  }

  for (const campaign of campaigns) {
    try {
      const campaignTenantId = campaign.tenant_id || DEFAULTS.TENANT_ID;
      // Check daily limit
      const sentToday = sentTodayFor(campaign.id);
      const effectiveLimit = clampedDailyLimit(campaign);
      const remainingBudget = effectiveLimit - sentToday;

      // Get queued sends that are due. Approved sends (deliveries) go first and
      // consume the daily budget; unapproved ones are only drafted for review.
      const queuedSends = queuedFor(campaign.id);
      const dueAll = queuedSends.filter(s => new Date(s.scheduled_at) <= now);
      const pendingDrafts = allSends.filter(s => s.campaign_id === campaign.id && s.status === "pending_approval").length;
      const draftRoom = Math.max(0, Math.min(DRAFTS_PER_RUN(), MAX_PENDING_DRAFTS() - pendingDrafts));
      // Stealth lock: never deliver approved outreach for this tenant.
      const approvedDue = stealthWriteBlocked(campaignTenantId)
        ? []
        : dueAll.filter(s => s.approved_at).slice(0, Math.max(0, remainingBudget));
      const draftDue = dueAll.filter(s => !s.approved_at).slice(0, draftRoom);
      if (remainingBudget <= 0 && approvedDue.length === 0) results.sends_over_limit++;
      const dueSends = [...approvedDue, ...draftDue];

      if (dueSends.length === 0) continue;

      // Apply suppression check and budget limit
      const eligibleSends = [];
      const takenSlots = new Set(); // one send per prospect+step per run
      for (const send of dueSends) {
        const slot = `${send.prospect_id}:${send.step_number}`;
        if (takenSlots.has(slot)) continue;
        takenSlots.add(slot);

        // Check suppression
        const prospect = await getProspect(send.prospect_id);
        if (prospect && await isEmailSuppressed(campaignTenantId, prospect.email)) {
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
          // fetch() does not throw on 4xx/5xx: treat a non-2xx (e.g. 403 when
          // INTERNAL_API_TOKEN is missing) as a dispatch failure → revert.
          if (!workerRes.ok) throw new Error(`send worker returned HTTP ${workerRes.status}`);
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
      if (queuedFor(campaign.id).length >= FEEDER_MIN_QUEUE) continue;
      const awaiting = await sb(`contact_pool?campaign_id=eq.${campaign.id}&sdr_state=eq.awaiting&order=enrolled_at.asc&limit=${FEEDER_BATCH}`);
      if (!Array.isArray(awaiting) || !awaiting.length) continue;
      let fed = 0;
      for (const c of awaiting) {
        // CLAIM FIRST: mark the pool row fed BEFORE creating the send. If the
        // run is killed mid-contact the failure mode is "skipped" (repairable)
        // instead of "re-fed and duplicate-emailed" (not). The representation
        // check proves the claim actually landed.
        const claimed = await sb(`contact_pool?id=eq.${c.id}&sdr_state=eq.awaiting`, {
          method: 'PATCH', body: { sdr_state: 'queued' }, prefer: 'return=representation'
        });
        if (!Array.isArray(claimed) || !claimed.length) {
          results.errors.push(`feeder claim failed for ${c.email} — skipping`);
          continue;
        }
        const prospect = {
          id: crypto.randomUUID(),
          tenant_id: campaign.tenant_id || DEFAULTS.TENANT_ID,
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
        const newSend = {
          id: crypto.randomUUID(),
          tenant_id: campaign.tenant_id || DEFAULTS.TENANT_ID,
          campaign_id: campaign.id,
          prospect_id: prospect.id,
          step_number: 1,
          status: 'queued',
          scheduled_at: new Date(Date.now() + fed * 120000).toISOString(),
          created_at: now.toISOString(),
          enqueued_by: 'pool_feeder'
        };
        await putEmailSend(newSend);
        allSends.push(newSend);
        fed++;
      }
      if (fed) {
        results.feeder_fed = (results.feeder_fed || 0) + fed;
        await logActivity({ type: 'pool_feeder', campaign_id: campaign.id, campaign_name: campaign.name, fed });
      }
    } catch (e) {
      results.errors.push(`feeder(${campaign.name}): ${e.message}`);
    }
  }

  // Auto-source top-up trigger: piggyback on this reliable 5-minute cron.
  // If an opted-in campaign's queue has run dry, fire the researcher to refill
  // it (the researcher rate-limits itself to one sourcing run per 6h/campaign).
  try {
    const needsTopUp = [];
    for (const campaign of campaigns) {
      if (campaign.auto_source !== true) continue;
      const minQueue = Number(campaign.auto_source_min_queue) || 5;
      if (queuedFor(campaign.id).length < minQueue) needsTopUp.push(campaign);
    }
    if (needsTopUp.length) {
      // No campaign_id in the body → researcher runs its top-up sweep, which
      // re-checks queue depth + per-campaign 6h cooldown before sourcing.
      await fetch(`${siteUrl()}/.netlify/functions/researcher-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internalHeaders() },
        body: JSON.stringify({})
      }).catch(() => {});
      results.topups_triggered = needsTopUp.length;
    }
  } catch (e) { /* top-up is best-effort; sends were already processed */ }

  return results;
}

// ─── Netlify Scheduled Function Handler ─────────────────────────────────────

export default async (req, context) => {
  // Scheduled function: not URL-invocable in production, no browser callers → no CORS.
  const corsHeaders = {};

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
  schedule: "*/5 * * * *"
};
