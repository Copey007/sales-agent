/**
 * Enqueue Send — Add prospects to the email_sends queue for a campaign.
 * 
 * This is the entry point for adding prospects to the automated send pipeline.
 * It creates email_send records with status="queued" that the Queue Manager
 * will pick up on its next scheduled run.
 * 
 * POST /api/enqueue-send
 * Body: {
 *   campaign_id: string (optional, defaults to default campaign),
 *   prospects: [{ contact_name, company_name, email, role, industry }],
 *   scheduled_at: ISO string (optional, defaults to now),
 *   step_number: number (optional, defaults to 1)
 * }
 */

import {
  getCampaign, putProspect, putCampaignProspect, putEmailSend,
  findProspectByEmail, isEmailSuppressed, getFeatureFlag,
  logActivity, DEFAULTS
} from "../../shared/campaign-store.mjs";

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
    // Feature flag check
    const orchestrationEnabled = await getFeatureFlag("multi_campaign_orchestration");
    if (!orchestrationEnabled) {
      return new Response(JSON.stringify({
        success: false,
        error: "Multi-campaign orchestration is disabled. Enable via /api/campaign-admin?action=set_flag",
        flag: "multi_campaign_orchestration",
        current_value: false
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const campaignId = body.campaign_id || DEFAULTS.CAMPAIGN_ID;
    const prospects = body.prospects || [];
    const scheduledAt = body.scheduled_at || new Date().toISOString();
    const stepNumber = body.step_number || 1;

    if (!prospects.length) {
      return new Response(JSON.stringify({ error: 'prospects[] required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify campaign exists
    const campaign = await getCampaign(campaignId);
    if (!campaign) {
      return new Response(JSON.stringify({ error: `Campaign ${campaignId} not found` }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const results = {
      enqueued: 0,
      suppressed: 0,
      deduplicated: 0,
      errors: []
    };

    for (const p of prospects) {
      try {
        if (!p.email && !p.contact_name) {
          results.errors.push(`Skipped: no email or contact_name`);
          continue;
        }

        // Check suppression
        if (p.email && await isEmailSuppressed(DEFAULTS.TENANT_ID, p.email)) {
          results.suppressed++;
          continue;
        }

        // Upsert prospect
        let prospect = p.email 
          ? await findProspectByEmail(DEFAULTS.TENANT_ID, p.email)
          : null;

        if (!prospect) {
          prospect = {
            id: crypto.randomUUID(),
            tenant_id: DEFAULTS.TENANT_ID,
            contact_name: p.contact_name,
            company_name: p.company_name,
            email: p.email,
            role: p.role || p.title,
            industry: p.industry,
            company_domain: p.company_domain,
            linkedin_url: p.linkedin_url,
            created_at: new Date().toISOString()
          };
          await putProspect(prospect);
        }

        // Create campaign_prospect junction (dedup check)
        const junctionKey = `${campaignId}:${prospect.id}`;
        const existingJunction = await import("../../shared/campaign-store.mjs")
          .then(m => m.getCampaignProspect(campaignId, prospect.id));
        
        if (existingJunction && existingJunction.status !== 'new') {
          // Already in this campaign — check if we should enqueue another step
          if (existingJunction.current_step >= stepNumber) {
            results.deduplicated++;
            continue;
          }
        }

        // Create/update junction
        await putCampaignProspect({
          campaign_id: campaignId,
          prospect_id: prospect.id,
          status: 'active',
          current_step: stepNumber,
          enrolled_at: new Date().toISOString()
        });

        // Create email_send record
        const sendId = crypto.randomUUID();
        await putEmailSend({
          id: sendId,
          campaign_id: campaignId,
          prospect_id: prospect.id,
          step_number: stepNumber,
          status: "queued",
          scheduled_at: scheduledAt,
          created_at: new Date().toISOString()
        });

        results.enqueued++;
      } catch (prospectErr) {
        results.errors.push(`${p.contact_name || p.email}: ${prospectErr.message}`);
      }
    }

    await logActivity({
      type: "enqueue_send",
      campaign_id: campaignId,
      campaign_name: campaign.name,
      prospects_submitted: prospects.length,
      enqueued: results.enqueued,
      suppressed: results.suppressed,
      deduplicated: results.deduplicated
    });

    return new Response(JSON.stringify({
      success: true,
      campaign_id: campaignId,
      campaign_name: campaign.name,
      results,
      next_queue_manager_run: "within 5 minutes (scheduled)"
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

export const config = {
  path: "/api/enqueue-send"
};
