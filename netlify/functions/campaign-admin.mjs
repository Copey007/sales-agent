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
  listRecords, getProspect, listAllReplies
} from "./_campaign-store.mjs";

export default async (req, context) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
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

      case "campaigns_overview": {
        // Campaign Agent panel feed: every non-archived campaign with its
        // contact counts (awaiting/queued/sent/replied) in one call.
        const { sb } = await import('./_supabase-rest.mjs');
        const campaigns = (await listCampaigns(DEFAULTS.TENANT_ID)).filter(c => c.status !== 'archived');
        let poolRows = [];
        try { poolRows = await sb('contact_pool?select=campaign_id,sdr_state&campaign_id=not.is.null&limit=10000') || []; } catch { poolRows = []; }
        const sends = await listRecords('email_sends');
        const overview = campaigns
          .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
          .map(c => {
            const pool = poolRows.filter(p => p.campaign_id === c.id);
            const cs = sends.filter(s => s.campaign_id === c.id);
            return {
              id: c.id,
              name: c.name,
              status: c.status,
              created_at: c.created_at,
              auto_source: c.auto_source === true,
              persona: c.brief?.target_persona || null,
              contacts_enrolled: pool.length,
              awaiting: pool.filter(p => p.sdr_state === 'awaiting').length,
              queued: cs.filter(s => ['queued', 'dispatched'].includes(s.status)).length,
              sent: cs.filter(s => s.status === 'sent').length,
              replied: cs.filter(s => s.status === 'cancelled_replied').length
            };
          });
        result = { campaigns: overview };
        break;
      }

      case "pipeline_stats": {
        // Single-call feed for the dashboard: real numbers from the live
        // email_sends ledger (not the legacy Supabase email_steps table).
        const campaigns = await listCampaigns(DEFAULTS.TENANT_ID);
        const campaignName = Object.fromEntries(campaigns.map(c => [c.id, c.name]));
        const sends = await listRecords("email_sends");
        // Real replies only: sender must be a prospect we actually emailed
        // (filters spam/marketing hitting the domain catch-all), and drop
        // tagged test artifacts, simulated events, and OOO auto-replies.
        const prospectEmails = new Set(
          (await listRecords("prospects")).map(p => (p.email || '').toLowerCase()).filter(Boolean));
        const replies = (await listAllReplies()).filter(r => {
          if (r.is_test === true) return false;
          if (['test', 'unknown'].includes(r.event_type)) return false;
          const sender = (r.from_email || r.prospect_email || r.from || '')
            .toLowerCase().replace(/^.*</, '').replace(/>$/, '').trim();
          if (!sender || !prospectEmails.has(sender)) return false;
          if (/^(automatic reply|auto(matic)? response|out of office)/i.test(r.subject || '')) return false;
          return true;
        });

        const byStatus = {};
        for (const s of sends) byStatus[s.status || 'unknown'] = (byStatus[s.status || 'unknown'] || 0) + 1;

        const prospectCache = {};
        const hydrate = async (s) => {
          if (s.prospect_id && !(s.prospect_id in prospectCache)) {
            prospectCache[s.prospect_id] = await getProspect(s.prospect_id).catch(() => null);
          }
          const p = prospectCache[s.prospect_id] || {};
          return {
            id: s.id, status: s.status, step: s.step_number,
            email: p.email, name: p.contact_name || p.name, company: p.company_name,
            campaign: campaignName[s.campaign_id] || s.campaign_id,
            subject: s.email_subject || null,
            scheduled_at: s.scheduled_at, sent_at: s.sent_at || null,
            enqueued_by: s.enqueued_by || null
          };
        };

        const sentRows = sends.filter(s => s.status === 'sent')
          .sort((a, b) => String(b.sent_at || '').localeCompare(String(a.sent_at || ''))).slice(0, 60);
        const queuedRows = sends.filter(s => ['queued', 'dispatched'].includes(s.status))
          .sort((a, b) => String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || ''))).slice(0, 90);

        result = {
          generated_at: new Date().toISOString(),
          totals: {
            sent: byStatus.sent || 0,
            queued: (byStatus.queued || 0) + (byStatus.dispatched || 0),
            replied: replies.length,
            suppressed: byStatus.suppressed || 0,
            cancelled_replied: byStatus.cancelled_replied || 0,
            failed: byStatus.failed || 0
          },
          last_send_at: sentRows[0]?.sent_at || null,
          campaigns_active: campaigns.filter(c => c.status === 'active').length,
          campaigns_total: campaigns.length,
          sent_rows: await Promise.all(sentRows.map(hydrate)),
          queued_rows: await Promise.all(queuedRows.map(hydrate)),
          reply_rows: replies
            .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || ''))).slice(0, 30)
            .map(r => ({
              from: r.from_email || r.from, name: r.from_name, subject: r.subject,
              at: r.received_at, campaign: campaignName[r.campaign_id] || null,
              preview: String(r.text_body || '').slice(0, 160)
            }))
        };
        break;
      }

      case "set_campaign_status": {
        if (req.method !== "POST") { result = { error: "POST required" }; break; }
        const body = await req.json();
        const { campaign_id, status, auto_source } = body;
        if (!campaign_id) { result = { error: "campaign_id required" }; break; }
        const campaign = await getCampaign(campaign_id);
        if (!campaign) { result = { error: `Campaign ${campaign_id} not found` }; break; }
        if (status && !["active", "ready", "paused", "archived"].includes(status)) {
          result = { error: "status must be active | ready | paused | archived" }; break;
        }
        if (status) campaign.status = status;
        if (typeof auto_source === "boolean") campaign.auto_source = auto_source;
        campaign.updated_at = new Date().toISOString();
        await putCampaign(campaign);
        result = { success: true, campaign: { id: campaign.id, name: campaign.name, status: campaign.status, auto_source: campaign.auto_source === true } };
        break;
      }

      case "icp_test": {
        const { icpDiscoverCompanies } = await import('./researcher-background.mjs');
        const hunterKey = (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
          ? Netlify.env.get('HUNTER_API_KEY') : (process.env.HUNTER_API_KEY || '');
        const icp = url.searchParams.get("icp") || "B2B technology companies between 15-100 employees - no competitors like GONG";
        result = await icpDiscoverCompanies(icp, url.searchParams.get("role") || "CEO", hunterKey);
        break;
      }

      case "discover_raw": {
        const hunterKey = (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
          ? Netlify.env.get('HUNTER_API_KEY') : (process.env.HUNTER_API_KEY || '');
        let payload = {};
        try { payload = JSON.parse(url.searchParams.get("body") || "{}"); } catch { payload = {}; }
        const method = url.searchParams.get("method") || "POST";
        let res;
        if (method === "GET") {
          const params = new URLSearchParams({ api_key: hunterKey, ...payload });
          res = await fetch(`https://api.hunter.io/v2/discover?${params}`);
        } else {
          res = await fetch(`https://api.hunter.io/v2/discover?api_key=${hunterKey}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
          });
        }
        const text = await res.text();
        result = { http: res.status, body: text.slice(0, 3000) };
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

      case "list_queued_sends": {
        const sends = await listQueuedSends(url.searchParams.get("campaign_id") || DEFAULTS.CAMPAIGN_ID);
        result = { sends };
        break;
      }

      case "trigger_queue": {
        // Manual trigger for queue-manager logic (for testing)
        const allSends = await listQueuedSends(url.searchParams.get("campaign_id") || DEFAULTS.CAMPAIGN_ID);
        const batch = allSends.slice(0, 5);
        if (batch.length === 0) {
          result = { message: "No queued sends found" };
        } else {
          // Call send-worker directly
          const sendIds = batch.map(s => s.id);
          const campaignId = batch[0].campaign_id;
          const workerResp = await fetch(`https://aisdr.a-gent.co/api/send-worker`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaign_id: campaignId, send_ids: sendIds, batch_index: 0, dry_run: url.searchParams.get("dry_run") === "true" })
          });
          result = { dispatched: sendIds.length, send_ids: sendIds, worker_status: workerResp.status, worker_response: await workerResp.json() };
        }
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
