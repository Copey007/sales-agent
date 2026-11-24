/**
 * Campaign Admin API — seed defaults, manage campaigns, toggle feature flags.
 * 
 * Endpoints (via query param ?action=...):
 *   POST ?action=seed           — Seed default tenant + campaign
 *   POST ?action=create_campaign — Create a new campaign
 *   POST ?action=set_flag       — Set a feature flag
 *   GET  ?action=get_campaign   — Get campaign config
 *   GET  ?action=list_campaigns — List all campaigns
 *   GET  ?action=get_flags      — Get all feature flags
 *   GET  ?action=status         — System status
 */

import {
  seedDefaults, DEFAULTS,
  getCampaign, putCampaign, listCampaigns, listActiveCampaigns,
  getCampaignPersona, getCampaignSignalConfig, getCampaignSequence, getCampaignTerritory,
  putPersona, putSignalConfig, putSequence, putTerritory,
  getFeatureFlag, setFeatureFlag,
  listActivityLog, countSentToday, listQueuedSends,
  listCampaignSends, getEmailSend, putEmailSend, getProspect
} from "./_campaign-store.mjs";
import { corsHeaders as cors, preflight, requireAuth, internalHeaders, json, serverError, authEnv } from "./_auth.mjs";

// Only these flags may be toggled over HTTP.
const SETTABLE_FLAGS = new Set(["multi_campaign_orchestration", "queue_manager_active"]);

export default async (req, context) => {
  const pf = preflight(req);
  if (pf) return pf;

  // Every action (seed, flags, campaign config, activity log, queue, approvals)
  // is operator-only.
  const denied = await requireAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "status";
  const MAX_DAILY = Number(authEnv("MAX_DAILY_SEND_LIMIT", "50")) || 50;

  try {
    let result;

    switch (action) {
      case "seed": {
        result = await seedDefaults();
        break;
      }

      case "status": {
        const orchestrationEnabled = await getFeatureFlag("multi_campaign_orchestration");
        const queueManagerActive = await getFeatureFlag("queue_manager_active");
        const campaigns = await listCampaigns(DEFAULTS.TENANT_ID);
        const activeCampaigns = campaigns.filter(c => c.status === "active");

        result = {
          system: "A-Gent Fleet Multi-Campaign Engine",
          version: "1.0.0-phase1",
          feature_flags: {
            multi_campaign_orchestration: orchestrationEnabled,
            queue_manager_active: queueManagerActive
          },
          tenant_id: DEFAULTS.TENANT_ID,
          campaigns_total: campaigns.length,
          campaigns_active: activeCampaigns.length,
          data_store: "netlify_blobs",
          architecture: "parallel_to_supabase"
        };
        break;
      }

      case "get_campaign": {
        const campaignId = url.searchParams.get("campaign_id") || DEFAULTS.CAMPAIGN_ID;
        const campaign = await getCampaign(campaignId);
        if (!campaign) {
          return new Response(JSON.stringify({ error: "Campaign not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...cors(req) }
          });
        }
        const persona = await getCampaignPersona(campaignId);
        const signalConfig = await getCampaignSignalConfig(campaignId);
        const sequence = await getCampaignSequence(campaignId);
        const territory = await getCampaignTerritory(campaignId);
        const sentToday = await countSentToday(campaignId);
        const queued = await listQueuedSends(campaignId);

        result = {
          campaign,
          persona,
          signal_config: signalConfig,
          sequence,
          territory,
          stats: { sent_today: sentToday, queued: queued.length }
        };
        break;
      }

      case "list_campaigns": {
        const campaigns = await listCampaigns(DEFAULTS.TENANT_ID);
        result = { campaigns };
        break;
      }

      case "create_campaign": {
        if (req.method !== "POST") {
          return new Response(JSON.stringify({ error: "POST required" }), {
            status: 405,
            headers: { "Content-Type": "application/json", ...cors(req) }
          });
        }
        const body = await req.json();
        const id = crypto.randomUUID();
        const campaign = {
          id,
          tenant_id: DEFAULTS.TENANT_ID,
          name: body.name || "New Campaign",
          status: body.status || "draft",
          daily_send_limit: Math.min(Math.max(1, Number(body.daily_send_limit) || 25), MAX_DAILY),
          sending_domain: body.sending_domain || null,
          created_at: new Date().toISOString()
        };
        await putCampaign(campaign);

        // Create associated persona if provided
        if (body.persona) {
          const personaId = crypto.randomUUID();
          await putPersona({
            id: personaId,
            tenant_id: DEFAULTS.TENANT_ID,
            campaign_id: id,
            target_role: body.persona.target_role || "Decision Maker",
            pain_points: body.persona.pain_points || [],
            messaging_angle: body.persona.messaging_angle || "",
            gap_current_state: body.persona.gap_current_state || "",
            gap_future_state: body.persona.gap_future_state || ""
          });
        }

        // Create signal config if provided
        if (body.signal_config) {
          const scId = crypto.randomUUID();
          await putSignalConfig({
            id: scId,
            tenant_id: DEFAULTS.TENANT_ID,
            campaign_id: id,
            signal_types: body.signal_config.signal_types || ["company_news", "hiring"],
            serp_query_templates: body.signal_config.serp_query_templates || ["{company} news {year}"]
          });
        }

        // Create sequence config
        const seqId = crypto.randomUUID();
        await putSequence({
          id: seqId,
          tenant_id: DEFAULTS.TENANT_ID,
          campaign_id: id,
          step_count: body.step_count || 12,
          cadence_config: body.cadence_config || { step_delays_days: [0, 3, 3, 4, 5, 5, 7, 7, 7, 10, 10, 14] },
          template_baseline: body.template_baseline || null,
          loop_enabled: body.loop_enabled !== false
        });

        result = { created: true, campaign };
        break;
      }

      case "set_flag": {
        if (req.method !== "POST") {
          return new Response(JSON.stringify({ error: "POST required" }), {
            status: 405,
            headers: { "Content-Type": "application/json", ...cors(req) }
          });
        }
        const body = await req.json();
        if (!body.flag || typeof body.enabled !== "boolean") {
          return json(req, { error: "flag and enabled required" }, 400);
        }
        if (!SETTABLE_FLAGS.has(body.flag)) {
          return json(req, { error: "unknown flag" }, 400);
        }
        await setFeatureFlag(body.flag, body.enabled, body.metadata || {});
        result = { flag: body.flag, enabled: body.enabled };
        break;
      }

      case "get_flags": {
        const orchestration = await getFeatureFlag("multi_campaign_orchestration");
        const queueManager = await getFeatureFlag("queue_manager_active");
        result = {
          multi_campaign_orchestration: orchestration,
          queue_manager_active: queueManager
        };
        break;
      }

      case "activity_log": {
        const log = await listActivityLog(50);
        result = { entries: log };
        break;
      }

      case "list_queued_sends": {
        const sends = await listQueuedSends(url.searchParams.get("campaign_id") || DEFAULTS.CAMPAIGN_ID);
        result = { sends };
        break;
      }

      case "trigger_queue": {
        // Manual trigger for queue-manager logic (for testing). POST only.
        // send-worker drafts unapproved sends and only delivers approved ones.
        if (req.method !== "POST") return json(req, { error: "POST required" }, 405);
        const allSends = await listQueuedSends(url.searchParams.get("campaign_id") || DEFAULTS.CAMPAIGN_ID);
        const batch = allSends.slice(0, 5);
        if (batch.length === 0) {
          result = { message: "No queued sends found" };
        } else {
          const nowIso = new Date().toISOString();
          for (const s of batch) { s.status = "dispatched"; s.dispatched_at = nowIso; await putEmailSend(s); }
          const sendIds = batch.map(s => s.id);
          const campaignId = batch[0].campaign_id;
          const siteUrl = authEnv("URL", "https://aisdr.a-gent.co");
          const workerResp = await fetch(`${siteUrl}/api/send-worker`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...internalHeaders() },
            body: JSON.stringify({ campaign_id: campaignId, send_ids: sendIds, batch_index: 0, dry_run: url.searchParams.get("dry_run") === "true" })
          });
          result = { dispatched: sendIds.length, send_ids: sendIds, worker_status: workerResp.status, worker_response: await workerResp.json().catch(() => null) };
        }
        break;
      }

      // ── Human-in-the-loop approval queue ─────────────────────────────────
      case "list_pending": {
        const campaignId = url.searchParams.get("campaign_id") || DEFAULTS.CAMPAIGN_ID;
        const sends = (await listCampaignSends(campaignId)).filter(s => s.status === "pending_approval");
        const items = [];
        for (const s of sends.slice(0, 100)) {
          const p = await getProspect(s.prospect_id);
          items.push({
            id: s.id, campaign_id: s.campaign_id, step_number: s.step_number,
            to: p?.email || s.prospect_email || null, contact_name: p?.contact_name || p?.name || null,
            company_name: p?.company_name || null, is_demo: !!p?.is_demo,
            subject: s.email_subject, body: s.email_body, signals_used: s.signals_used || [],
            drafted_at: s.drafted_at || null
          });
        }
        result = { pending: items, count: items.length };
        break;
      }

      case "approve_sends":
      case "reject_sends": {
        if (req.method !== "POST") return json(req, { error: "POST required" }, 405);
        const body = await req.json().catch(() => ({}));
        const ids = Array.isArray(body.send_ids) ? body.send_ids.slice(0, 100) : [];
        if (!ids.length) return json(req, { error: "send_ids[] required" }, 400);
        const edits = body.edits || {}; // optional { [send_id]: { subject, body } }
        const approver = req.authUser?.email || "internal";
        const nowIso = new Date().toISOString();
        const updated = [];
        for (const id of ids) {
          const s = await getEmailSend(id);
          if (!s || s.status !== "pending_approval") continue;
          if (action === "approve_sends") {
            if (edits[id]?.subject) s.email_subject = String(edits[id].subject).slice(0, 200);
            if (edits[id]?.body) s.email_body = String(edits[id].body).slice(0, 5000);
            s.status = "queued";          // queue-manager will now deliver it
            s.approved_at = nowIso;
            s.approved_by = approver;
            s.scheduled_at = nowIso;
          } else {
            s.status = "rejected";
            s.rejected_at = nowIso;
            s.rejected_by = approver;
          }
          await putEmailSend(s);
          updated.push(id);
        }
        result = { action, updated, count: updated.length };
        break;
      }

      default:
        result = { error: `Unknown action: ${action}` };
    }

    return json(req, result, result && result.error ? 400 : 200);

  } catch (err) {
    // Previously returned err.stack to any caller.
    return serverError(req, err, "campaign-admin");
  }
};

export const config = {
  path: "/api/campaign-admin",
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] }
};
