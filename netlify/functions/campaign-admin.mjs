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
  listActivityLog, countSentToday, listQueuedSends
} from "./_lib/campaign-store.mjs";

export default async (req, context) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "status";

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
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
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
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }
        const body = await req.json();
        const id = crypto.randomUUID();
        const campaign = {
          id,
          tenant_id: DEFAULTS.TENANT_ID,
          name: body.name || "New Campaign",
          status: body.status || "draft",
          daily_send_limit: body.daily_send_limit || 50,
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
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }
        const body = await req.json();
        if (!body.flag || typeof body.enabled !== "boolean") {
          return new Response(JSON.stringify({ error: "flag and enabled required" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
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

      default:
        result = { error: `Unknown action: ${action}` };
    }

    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
};

export const config = {
  path: "/api/campaign-admin"
};
