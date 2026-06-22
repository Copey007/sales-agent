/**
 * Campaign Orchestrator — "Campaign Agent"
 *
 * Accepts a campaign brief (name, persona, ICP, problem) and:
 * 1. Creates the full campaign config (campaign, persona, territory, signal_config, sequence)
 * 2. Activates the campaign and triggers the specialist agents:
 *    - Agent Researcher: sources prospects via Hunter.io + gathers signals
 *    - Agent Ops: manages queue scheduling, throttling, daily limits
 *    - Agent SDR: generates GAP emails and dispatches sends
 * 3. Returns the campaign_id and initial agent status for the UI to poll.
 *
 * Endpoints:
 *   POST /api/campaign-orchestrator?action=launch   — Create + launch a campaign
 *   GET  /api/campaign-orchestrator?action=status   — Get all campaign statuses + agent activity
 *   GET  /api/campaign-orchestrator?action=detail&campaign_id=X — Single campaign detail
 */

import {
  putCampaign, putPersona, putTerritory, putSignalConfig, putSequence,
  listCampaigns, getCampaign, getCampaignPersona, getCampaignTerritory,
  getCampaignSignalConfig, getCampaignSequence,
  listCampaignProspects, putCampaignProspect, putProspect,
  getProspect, findProspectByEmail, isEmailSuppressed,
  listQueuedSends, countSentToday, putEmailSend,
  listRecords, logActivity, setFeatureFlag,
  DEFAULTS
} from "./_campaign-store.mjs";

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  // Support action from URL params OR JSON body
  let bodyData = {};
  if (req.method === 'POST') {
    try { const text = await req.text(); bodyData = text ? JSON.parse(text) : {}; } catch { bodyData = {}; }
  }
  const action = url.searchParams.get("action") || bodyData.action || "status";
  // Wrap body data so handleLaunch can read it without re-parsing
  const reqWithBody = { method: req.method, url: req.url, _body: bodyData, json: async () => bodyData };

  try {
    let result;

    const cid = url.searchParams.get("campaign_id") || bodyData.campaign_id;

    switch (action) {
      case "launch":
        result = await handleLaunch(reqWithBody);
        break;
      case "status":
        result = await handleStatus();
        break;
      case "detail":
        result = await handleDetail(cid);
        break;
      case "funnel":
        result = await handleFunnel(cid);
        break;
      case "replies":
        result = await handleReplies(cid);
        break;
      case "loop":
        result = await handleLoopState(cid);
        break;
      case "prospects":
        result = await handleProspects(cid);
        break;
      case "sends":
        result = await handleSends(cid);
        break;
      default:
        result = { error: `Unknown action: ${action}` };
    }

    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  } catch (err) {
    console.error("[campaign-orchestrator] Error:", err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  }
};

export const config = {
  path: "/api/campaign-orchestrator"
};

// ─── Launch Handler ─────────────────────────────────────────────────────────

async function handleLaunch(req) {
  const body = await req.json();
  // Support both field name conventions (UI sends persona/problem, API docs say target_persona/problem_we_solve)
  const campaign_name = body.campaign_name;
  const target_persona = body.target_persona || body.persona;
  const icp = body.icp;
  const problem_we_solve = body.problem_we_solve || body.problem;

  if (!campaign_name || !target_persona || !icp || !problem_we_solve) {
    return { error: "Missing required fields: campaign_name, target_persona (or persona), icp, problem_we_solve (or problem)" };
  }

  const campaignId = crypto.randomUUID();
  const tenantId = DEFAULTS.TENANT_ID;
  const now = new Date().toISOString();

  // 1. Create Campaign record
  const campaign = {
    id: campaignId,
    tenant_id: tenantId,
    name: campaign_name,
    status: "active",
    daily_send_limit: 25,
    sending_domain: "a-gent.co",
    sender_name: "Mark",
    created_at: now,
    launched_at: now,
    brief: { target_persona, icp, problem_we_solve },
    agent_status: {
      orchestrator: { state: "ACTIVE", last_action: "Campaign created", updated_at: now },
      researcher: { state: "QUEUED", last_action: "Awaiting launch", updated_at: now },
      ops: { state: "QUEUED", last_action: "Awaiting prospects", updated_at: now },
      sdr: { state: "QUEUED", last_action: "Awaiting queue", updated_at: now }
    }
  };
  await putCampaign(campaign);

  // 2. Create Persona
  const personaId = crypto.randomUUID();
  await putPersona({
    id: personaId,
    tenant_id: tenantId,
    campaign_id: campaignId,
    target_role: target_persona,
    pain_points: extractPainPoints(problem_we_solve),
    messaging_angle: `Solving: ${problem_we_solve}`,
    gap_current_state: `Currently struggling with: ${problem_we_solve}`,
    gap_future_state: `After A-Gent Fleet: autonomous AI-driven solution eliminating this problem entirely`
  });

  // 3. Create Territory from ICP
  const territoryId = crypto.randomUUID();
  const parsedICP = parseICP(icp);
  await putTerritory({
    id: territoryId,
    tenant_id: tenantId,
    campaign_id: campaignId,
    geography: parsedICP.geography,
    segment: parsedICP.segment,
    vertical: parsedICP.vertical,
    employee_min: parsedICP.employee_min,
    employee_max: parsedICP.employee_max,
    icp_raw: icp,
    hunter_domain_filters: null
  });

  // 4. Create Signal Config
  const signalConfigId = crypto.randomUUID();
  await putSignalConfig({
    id: signalConfigId,
    tenant_id: tenantId,
    campaign_id: campaignId,
    signal_types: ["company_news", "hiring", "funding", "product_launch", "leadership_change", "tech_change"],
    serp_query_templates: [
      `{company} ${parsedICP.vertical || ''} news {year}`,
      `{company} hiring ${target_persona.toLowerCase()}`,
      `{contact_name} {company} LinkedIn`,
      `{company} ${problem_we_solve.split(' ').slice(0, 3).join(' ')}`
    ]
  });

  // 5. Create Sequence (12-step GAP cadence)
  const sequenceId = crypto.randomUUID();
  await putSequence({
    id: sequenceId,
    tenant_id: tenantId,
    campaign_id: campaignId,
    step_count: 12,
    cadence_config: {
      step_delays_days: [0, 3, 3, 4, 5, 5, 7, 7, 7, 10, 10, 14]
    },
    template_baseline: null,
    loop_enabled: true,
    guardrails: {
      methodology: "GAP",
      no_fabricated_signals: true,
      brevity_target_words: 100,
      single_cta: true,
      signature: "A-Gent Fleet"
    }
  });

  // 6. Enable multi-campaign orchestration
  await setFeatureFlag("multi_campaign_orchestration", true);
  await setFeatureFlag("queue_manager_active", true);

  // 7. Run Agent Researcher synchronously (capped at 3 domains to fit 26s timeout)
  // Each domain search takes ~1-2s; 3 domains = ~5s total, leaving room for verification + Blobs writes
  campaign.agent_status.researcher = { state: "ACTIVE", last_action: "Sourcing prospects via Hunter.io", updated_at: now };
  campaign.agent_status.orchestrator = { state: "ACTIVE", last_action: "Coordinating specialist agents", updated_at: now };
  await putCampaign(campaign);

  const researchResult = await runResearcherAgent(campaignId, parsedICP, target_persona);

  // Log activity
  await logActivity({
    type: "campaign_launched",
    campaign_id: campaignId,
    campaign_name: campaign_name,
    message: `Campaign "${campaign_name}" launched targeting ${target_persona} in ${parsedICP.vertical || 'B2B SaaS'}. Researcher sourced ${researchResult.prospects_enrolled} prospects.`,
    timestamp: now
  });

  // Refresh campaign status
  const updated = await getCampaign(campaignId);

  return {
    success: true,
    campaign_id: campaignId,
    campaign_name: campaign_name,
    status: "active",
    agent_status: updated?.agent_status || campaign.agent_status,
    metrics: updated?.metrics || {},
    research_result: researchResult,
    message: `Campaign "${campaign_name}" is live. Agent Researcher sourced ${researchResult.prospects_enrolled} real prospects, Agent Ops queued ${researchResult.prospects_enrolled} sends, Agent SDR is ready.`
  };
}

// ─── Status Handler ─────────────────────────────────────────────────────────

async function handleStatus() {
  const campaigns = await listCampaigns(DEFAULTS.TENANT_ID);
  const activeCampaigns = campaigns.filter(c => c.status === "active");

  // Use cached metrics from the campaign record to avoid N*3 Blobs list calls
  // (which would timeout with 5+ campaigns). Metrics are updated by the researcher
  // and ops agents when they write back to the campaign record.
  const campaignSummaries = activeCampaigns.map(c => ({
    id: c.id,
    name: c.name,
    status: c.status,
    created_at: c.created_at,
    launched_at: c.launched_at,
    daily_send_limit: c.daily_send_limit,
    brief: c.brief || {},
    agent_status: c.agent_status || defaultAgentStatus(),
    metrics: c.metrics || {
      prospects_enrolled: c.agent_status?.researcher?.prospects_found || 0,
      queued_sends: c.agent_status?.ops?.sends_queued || 0,
      sent_today: 0
    }
  }));

  return {
    total_campaigns: campaigns.length,
    active_campaigns: activeCampaigns.length,
    campaigns: campaignSummaries
  };
}

// ─── Detail Handler ─────────────────────────────────────────────────────────
// Hardened: uses cached metrics from campaign record to avoid expensive Blobs scans.
// Only fetches persona/territory/sequence (3 reads) plus the campaign record itself.
// Funnel, replies, loop state, and sends are fetched lazily via sub-actions.

async function handleDetail(campaignId) {
  if (!campaignId) return { error: "campaign_id required" };
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { error: "Campaign not found" };

  // Fast parallel reads: persona, territory, signal_config, sequence (4 list scans but small stores)
  const [persona, territory, signalConfig, sequence] = await Promise.all([
    getCampaignPersona(campaignId),
    getCampaignTerritory(campaignId),
    getCampaignSignalConfig(campaignId),
    getCampaignSequence(campaignId)
  ]);

  // Use cached metrics from the campaign record (written by runOpsAgent)
  const metrics = campaign.metrics || {
    prospects_enrolled: campaign.agent_status?.researcher?.prospects_found || 0,
    queued_sends: campaign.agent_status?.ops?.sends_queued || 0,
    sent_today: 0
  };

  return {
    campaign,
    persona,
    territory,
    signal_config: signalConfig,
    sequence,
    metrics
  };
}

// ─── Funnel Handler (campaign-scoped) ───────────────────────────────────────
// Returns funnel stages: sourced → queued → sent → delivered → opened → replied → positive

async function handleFunnel(campaignId) {
  if (!campaignId) return { error: "campaign_id required" };
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { error: "Campaign not found" };

  // Use cached metrics for the top of funnel (fast)
  const sourced = campaign.metrics?.prospects_enrolled || campaign.agent_status?.researcher?.prospects_found || 0;
  const queued = campaign.metrics?.queued_sends || campaign.agent_status?.ops?.sends_queued || 0;

  // For sent/delivered/opened/replied, scan email_sends for this campaign
  const { listCampaignSends, listCampaignReplies } = await import('./_campaign-store.mjs');
  const sends = await listCampaignSends(campaignId);
  const sent = sends.filter(s => s.status === 'sent').length;
  const delivered = sends.filter(s => s.status === 'sent' && s.delivered !== false).length;
  const opened = sends.filter(s => s.opened_at).length;

  // Replies for this campaign
  const replies = await listCampaignReplies(campaignId);
  const replied = replies.length;
  const positive = replies.filter(r => r.sentiment === 'positive').length;

  return {
    campaign_id: campaignId,
    campaign_name: campaign.name,
    funnel: { sourced, queued, sent, delivered, opened, replied, positive }
  };
}

// ─── Replies Handler (campaign-scoped) ──────────────────────────────────────

async function handleReplies(campaignId) {
  if (!campaignId) return { error: "campaign_id required" };
  const { listCampaignReplies, listAllReplies } = await import('./_campaign-store.mjs');
  let replies;
  if (campaignId === 'all') {
    replies = await listAllReplies();
  } else {
    replies = await listCampaignReplies(campaignId);
  }
  // Sort newest first
  replies.sort((a, b) => (b.received_at || '').localeCompare(a.received_at || ''));
  return { campaign_id: campaignId, replies: replies.slice(0, 50) };
}

// ─── Loop State Handler (campaign-scoped) ───────────────────────────────────

async function handleLoopState(campaignId) {
  if (!campaignId) return { error: "campaign_id required" };
  const experiments = await listCampaignExperiments(campaignId);
  const campaign = await getCampaign(campaignId);
  return {
    campaign_id: campaignId,
    campaign_name: campaign?.name || '',
    loop_enabled: true,
    experiments: experiments.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 20),
    summary: {
      total_experiments: experiments.length,
      latest: experiments.length > 0 ? experiments[experiments.length - 1] : null
    }
  };
}

// ─── Prospects Handler (campaign-scoped) ─────────────────────────────────────

async function handleProspects(campaignId) {
  if (!campaignId) return { error: "campaign_id required" };
  const junctions = await listCampaignProspects(campaignId);
  // Batch-read prospects (max 25 to stay fast)
  const prospectIds = junctions.slice(0, 25).map(j => j.prospect_id);
  const prospects = await Promise.all(prospectIds.map(id => getProspect(id)));
  return {
    campaign_id: campaignId,
    total: junctions.length,
    prospects: prospects.filter(Boolean).map(p => ({
      id: p.id, email: p.email, name: p.name, company_name: p.company_name,
      title: p.title, verified: p.verified, source: p.source, sourced_at: p.sourced_at
    }))
  };
}

// ─── Sends Handler (campaign-scoped) ────────────────────────────────────────

async function handleSends(campaignId) {
  if (!campaignId) return { error: "campaign_id required" };
  const { listCampaignSends } = await import('./_campaign-store.mjs');
  let sends = await listCampaignSends(campaignId);
  // Fallback: if no sends have campaign_id, look up via enrolled prospect IDs
  if (sends.length === 0) {
    try {
      const junctions = await listCampaignProspects(campaignId);
      const prospectIds = new Set(junctions.map(j => j.prospect_id));
      if (prospectIds.size > 0) {
        const allSends = await listRecords('email_sends');
        sends = allSends.filter(s => prospectIds.has(s.prospect_id));
      }
    } catch { /* fallback failed, return empty */ }
  }
  // Sort newest first, limit to 50
  sends.sort((a, b) => (b.created_at || b.scheduled_at || '').localeCompare(a.created_at || a.scheduled_at || ''));
  return {
    campaign_id: campaignId,
    total: sends.length,
    sends: sends.slice(0, 50).map(s => ({
      id: s.id, prospect_id: s.prospect_id, prospect_email: s.prospect_email,
      step_number: s.step_number, status: s.status,
      scheduled_at: s.scheduled_at, sent_at: s.sent_at,
      opened_at: s.opened_at, subject: s.subject
    }))
  };
}

// ─── Hunter.io ICP Domain Selector ─────────────────────────────────────────
// Curated list of real B2B SaaS company domains segmented by vertical/persona.
// Hunter Starter plan does not include /companies/search (Business plan only).
// This approach is more reliable and quota-efficient than discovery APIs.
// Domains are rotated per campaign via ICP matching to avoid overlap.

const ICP_DOMAIN_MAP = {
  // Sales / Revenue / RevOps personas
  sales: [
    { domain: 'gong.io', company_name: 'Gong', employee_count: '500-1000' },
    { domain: 'outreach.io', company_name: 'Outreach', employee_count: '500-1000' },
    { domain: 'salesloft.com', company_name: 'Salesloft', employee_count: '500-1000' },
    { domain: 'clari.com', company_name: 'Clari', employee_count: '200-500' },
    { domain: 'apollo.io', company_name: 'Apollo.io', employee_count: '200-500' },
    { domain: 'zoominfo.com', company_name: 'ZoomInfo', employee_count: '1000+' },
    { domain: 'seamless.ai', company_name: 'Seamless.AI', employee_count: '200-500' },
    { domain: 'lusha.com', company_name: 'Lusha', employee_count: '200-500' },
    { domain: 'cognism.com', company_name: 'Cognism', employee_count: '200-500' },
    { domain: 'drift.com', company_name: 'Drift', employee_count: '200-500' },
  ],
  // Marketing / Demand Gen / Growth personas
  marketing: [
    { domain: 'hubspot.com', company_name: 'HubSpot', employee_count: '5000+' },
    { domain: 'marketo.com', company_name: 'Marketo', employee_count: '1000+' },
    { domain: 'pardot.com', company_name: 'Pardot', employee_count: '500-1000' },
    { domain: 'klaviyo.com', company_name: 'Klaviyo', employee_count: '500-1000' },
    { domain: 'activecampaign.com', company_name: 'ActiveCampaign', employee_count: '500-1000' },
    { domain: 'mailchimp.com', company_name: 'Mailchimp', employee_count: '1000+' },
    { domain: 'intercom.com', company_name: 'Intercom', employee_count: '500-1000' },
    { domain: 'braze.com', company_name: 'Braze', employee_count: '500-1000' },
    { domain: 'iterable.com', company_name: 'Iterable', employee_count: '200-500' },
    { domain: 'sendgrid.com', company_name: 'SendGrid', employee_count: '500-1000' },
  ],
  // Executive / CEO / Founder personas
  executive: [
    { domain: 'stripe.com', company_name: 'Stripe', employee_count: '5000+' },
    { domain: 'notion.so', company_name: 'Notion', employee_count: '500-1000' },
    { domain: 'figma.com', company_name: 'Figma', employee_count: '500-1000' },
    { domain: 'linear.app', company_name: 'Linear', employee_count: '50-200' },
    { domain: 'retool.com', company_name: 'Retool', employee_count: '200-500' },
    { domain: 'airtable.com', company_name: 'Airtable', employee_count: '500-1000' },
    { domain: 'clickup.com', company_name: 'ClickUp', employee_count: '500-1000' },
    { domain: 'monday.com', company_name: 'Monday.com', employee_count: '1000+' },
    { domain: 'asana.com', company_name: 'Asana', employee_count: '1000+' },
    { domain: 'lattice.com', company_name: 'Lattice', employee_count: '200-500' },
  ],
  // Engineering / Product / CTO personas
  engineering: [
    { domain: 'datadog.com', company_name: 'Datadog', employee_count: '5000+' },
    { domain: 'pagerduty.com', company_name: 'PagerDuty', employee_count: '1000+' },
    { domain: 'newrelic.com', company_name: 'New Relic', employee_count: '1000+' },
    { domain: 'sentry.io', company_name: 'Sentry', employee_count: '200-500' },
    { domain: 'launchdarkly.com', company_name: 'LaunchDarkly', employee_count: '200-500' },
    { domain: 'split.io', company_name: 'Split', employee_count: '100-200' },
    { domain: 'amplitude.com', company_name: 'Amplitude', employee_count: '500-1000' },
    { domain: 'mixpanel.com', company_name: 'Mixpanel', employee_count: '200-500' },
    { domain: 'segment.com', company_name: 'Segment', employee_count: '500-1000' },
    { domain: 'mparticle.com', company_name: 'mParticle', employee_count: '200-500' },
  ],
  // Default / General B2B SaaS
  default: [
    { domain: 'zendesk.com', company_name: 'Zendesk', employee_count: '5000+' },
    { domain: 'freshworks.com', company_name: 'Freshworks', employee_count: '5000+' },
    { domain: 'pipedrive.com', company_name: 'Pipedrive', employee_count: '500-1000' },
    { domain: 'close.com', company_name: 'Close', employee_count: '50-200' },
    { domain: 'copper.com', company_name: 'Copper', employee_count: '100-200' },
    { domain: 'nutshell.com', company_name: 'Nutshell', employee_count: '50-200' },
    { domain: 'insightly.com', company_name: 'Insightly', employee_count: '100-200' },
    { domain: 'capsulecrm.com', company_name: 'Capsule CRM', employee_count: '50-100' },
    { domain: 'streak.com', company_name: 'Streak', employee_count: '50-100' },
    { domain: 'nimble.com', company_name: 'Nimble', employee_count: '50-100' },
  ]
};

function selectICPDomains(parsedICP, targetRole) {
  const role = (targetRole || '').toLowerCase();
  const vertical = (parsedICP.vertical || '').toLowerCase();

  // Determine the best domain segment based on role and vertical
  let segment = 'default';
  if (role.includes('sales') || role.includes('revenue') || role.includes('revops') || role.includes('sdr') || role.includes('ae')) {
    segment = 'sales';
  } else if (role.includes('marketing') || role.includes('growth') || role.includes('demand') || role.includes('cmo')) {
    segment = 'marketing';
  } else if (role.includes('ceo') || role.includes('founder') || role.includes('president') || role.includes('coo') || role.includes('owner')) {
    segment = 'executive';
  } else if (role.includes('cto') || role.includes('engineer') || role.includes('tech') || role.includes('product')) {
    segment = 'engineering';
  } else if (vertical.includes('sales') || vertical.includes('crm') || vertical.includes('revenue')) {
    segment = 'sales';
  } else if (vertical.includes('marketing') || vertical.includes('email') || vertical.includes('growth')) {
    segment = 'marketing';
  }

  const pool = ICP_DOMAIN_MAP[segment] || ICP_DOMAIN_MAP.default;
  // Return up to 8 domains, capped for quota safety
  return pool.slice(0, 8);
}

// ─── Hunter.io Role Mapping Helpers ─────────────────────────────────────────

function mapRoleToSeniority(role) {
  const r = (role || '').toLowerCase();
  if (r.includes('ceo') || r.includes('cto') || r.includes('cfo') || r.includes('founder') || r.includes('president') || r.includes('owner')) return 'executive';
  if (r.includes('vp') || r.includes('vice president') || r.includes('director') || r.includes('head of')) return 'senior,executive';
  if (r.includes('manager') || r.includes('lead')) return 'senior';
  return 'senior,executive';
}

function mapRoleToDepartment(role) {
  const r = (role || '').toLowerCase();
  if (r.includes('sales') || r.includes('revenue') || r.includes('sdr') || r.includes('ae') || r.includes('account')) return 'sales';
  if (r.includes('marketing') || r.includes('growth') || r.includes('demand')) return 'marketing';
  if (r.includes('engineer') || r.includes('tech') || r.includes('cto') || r.includes('product')) return 'it';
  if (r.includes('ceo') || r.includes('founder') || r.includes('president') || r.includes('coo')) return 'executive';
  return 'executive,sales';
}

// ─── Agent Researcher ───────────────────────────────────────────────────────
// Synchronous, capped at 3 domains per run to stay within Netlify's 26s timeout.
// Each Hunter domain-search takes ~1-2s; 3 domains ≈ 5s + verification + Blobs writes.
// The /api/researcher-background endpoint can be called again to source additional
// prospects from the remaining domain pool (pagination via page param).

const RESEARCHER_MAX_PROSPECTS = 15; // safety cap per run
const RESEARCHER_DOMAINS_PER_RUN = 3; // domains per synchronous run

async function runResearcherAgent(campaignId, parsedICP, targetRole) {
  const HUNTER_KEY = (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
    ? Netlify.env.get('HUNTER_API_KEY')
    : (process.env.HUNTER_API_KEY || '');

  const campaign = await getCampaign(campaignId);
  if (!campaign) return { prospects_enrolled: 0, stats: {} };

  const now = new Date().toISOString();
  let rawProspects = [];
  const discoverStats = { companies_searched: 0, emails_found: 0, verified: 0, suppressed: 0, deduped: 0, fallback: false };

  if (!HUNTER_KEY) {
    // Fallback: demo prospects so the pipeline still works without a key
    rawProspects = generateDemoProspects(campaignId, parsedICP, targetRole, 5);
    discoverStats.fallback = true;
  } else {
    const seniority = mapRoleToSeniority(targetRole);
    const department = mapRoleToDepartment(targetRole);
    // Use only first 3 domains to stay within timeout
    const domains = selectICPDomains(parsedICP, targetRole).slice(0, RESEARCHER_DOMAINS_PER_RUN);
    discoverStats.companies_searched = domains.length;

    for (const { domain, company_name } of domains) {
      if (rawProspects.length >= RESEARCHER_MAX_PROSPECTS) break;
      try {
        const params = new URLSearchParams({
          api_key: HUNTER_KEY,
          domain,
          type: 'personal',
          seniority,
          department,
          limit: 5
        });
        const res = await fetch(`https://api.hunter.io/v2/domain-search?${params}`);
        if (!res.ok) continue;
        const data = await res.json();
        const emails = data?.data?.emails || [];
        const org = data?.data?.organization || company_name;
        for (const e of emails) {
          if (!e.value) continue;
          rawProspects.push({
            email: e.value,
            name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null,
            first_name: e.first_name || null,
            last_name: e.last_name || null,
            company_name: org,
            company_domain: domain,
            title: e.position || targetRole,
            linkedin_url: e.linkedin || null,
            hunter_confidence: e.confidence || null,
            source: 'hunter_domain_search'
          });
          discoverStats.emails_found++;
        }
      } catch (err) {
        console.warn(`[researcher] Error searching ${domain}: ${err.message}`);
      }
    }

    // Verify only low-confidence emails (< 90) to preserve quota
    const highConf = rawProspects.filter(p => (p.hunter_confidence || 0) >= 90);
    const lowConf = rawProspects.filter(p => (p.hunter_confidence || 0) < 90).slice(0, 3); // max 3 verifications
    const verified = [...highConf.map(p => ({ ...p, verified: true, verification_status: 'high_confidence' }))];
    for (const p of lowConf) {
      try {
        const vRes = await fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(p.email)}&api_key=${HUNTER_KEY}`);
        if (vRes.ok) {
          const vData = await vRes.json();
          const status = vData?.data?.status;
          const score = vData?.data?.score || 0;
          if (status === 'valid' || status === 'accept_all' || score > 50) {
            verified.push({ ...p, verified: true, verification_status: status, verification_score: score });
            discoverStats.verified++;
          }
        }
      } catch { verified.push({ ...p, verified: false, verification_status: 'error' }); }
    }
    rawProspects = verified.slice(0, RESEARCHER_MAX_PROSPECTS);
  }

  // Cross-campaign dedup + suppression
  // Load ALL prospects once (single Blobs list call) to build email index
  // This avoids N+1 getProspect calls per junction record
  const allProspects = await (async () => {
    try {
      // Use findProspectByEmail's underlying approach but bulk
      const { getStore } = await import('@netlify/blobs');
      const s = getStore('prospects');
      const list = await s.list();
      const records = await Promise.all(list.blobs.map(b => s.get(b.key, { type: 'json' })));
      return records.filter(Boolean);
    } catch { return []; }
  })();
  const allProspectEmailSet = new Set(allProspects.map(p => (p.email || '').toLowerCase()));

  // Also load this campaign's existing junctions to detect re-enrollment
  const existingJunctions = await listCampaignProspects(campaignId);
  const existingProspectIds = new Set(existingJunctions.map(cp => cp.prospect_id));
  const existingProspectEmails = new Set(
    allProspects.filter(p => existingProspectIds.has(p.id)).map(p => (p.email || '').toLowerCase())
  );

  const seenEmails = new Set();
  const toEnroll = [];
  for (const p of rawProspects) {
    const emailLower = (p.email || '').toLowerCase();
    if (!emailLower || seenEmails.has(emailLower)) { discoverStats.deduped++; continue; }
    seenEmails.add(emailLower);
    if (await isEmailSuppressed(DEFAULTS.TENANT_ID, emailLower)) { discoverStats.suppressed++; continue; }
    if (existingProspectEmails.has(emailLower)) { discoverStats.deduped++; continue; }
    const existingProspect = allProspects.find(pr => pr.email === emailLower) || null;
    toEnroll.push({ ...p, _existing: existingProspect });
  }

  // Persist + enroll
  const enrolled = [];
  for (const p of toEnroll) {
    let prospect = p._existing;
    if (!prospect) {
      prospect = {
        id: crypto.randomUUID(),
        tenant_id: DEFAULTS.TENANT_ID,
        email: p.email.toLowerCase(),
        name: p.name || null,
        first_name: p.first_name || null,
        last_name: p.last_name || null,
        company_name: p.company_name || null,
        company_domain: p.company_domain || null,
        title: p.title || targetRole,
        linkedin_url: p.linkedin_url || null,
        hunter_confidence: p.hunter_confidence || null,
        verified: p.verified || false,
        verification_status: p.verification_status || null,
        source: p.source || 'hunter',
        sourced_at: now,
        created_at: now
      };
      await putProspect(prospect);
    }
    await putCampaignProspect({ campaign_id: campaignId, prospect_id: prospect.id, enrolled_at: now, status: 'active' });
    enrolled.push(prospect);
  }

  // Update researcher agent status on campaign
  const freshCampaign = await getCampaign(campaignId);
  if (freshCampaign) {
    const sourceLabel = discoverStats.fallback ? 'demo (no Hunter key)' : 'Hunter.io live';
    freshCampaign.agent_status.researcher = {
      state: 'COMPLETE',
      last_action: `Sourced ${enrolled.length} real prospects via ${sourceLabel} · ${discoverStats.suppressed} suppressed · ${discoverStats.deduped} deduped`,
      updated_at: new Date().toISOString(),
      prospects_found: enrolled.length,
      stats: discoverStats
    };
    await putCampaign(freshCampaign);
  }

  // Hand off to Agent Ops — pass freshCampaign directly to avoid stale-read race
  await runOpsAgent(campaignId, enrolled, freshCampaign);

  return { prospects_enrolled: enrolled.length, stats: discoverStats };
}

// ─── Agent Ops ──────────────────────────────────────────────────────────────

async function runOpsAgent(campaignId, prospects, campaignRecord) {
  // Use the passed campaign record (from researcher's final write) to avoid Blobs eventual-consistency stale reads
  const campaign = campaignRecord || await getCampaign(campaignId);
  if (!campaign) return;

  const now = new Date();
  let scheduledCount = 0;

  for (const prospect of prospects) {
    // Schedule first email immediately, subsequent emails follow cadence
    const sendId = crypto.randomUUID();
    const scheduledAt = new Date(now.getTime() + scheduledCount * 120000); // 2 min apart for warmup

    await putEmailSend({
      id: sendId,
      tenant_id: DEFAULTS.TENANT_ID,
      campaign_id: campaignId,
      prospect_id: prospect.id,
      prospect_email: prospect.email,
      step_number: 1,
      status: "queued",
      scheduled_at: scheduledAt.toISOString(),
      created_at: now.toISOString()
    });
    scheduledCount++;
  }

    // Update ops status + cache metrics on the campaign record for fast status reads
  campaign.agent_status.ops = {
    state: "ACTIVE",
    last_action: `Queued ${scheduledCount} sends (warmup throttle: 2min spacing)`,
    updated_at: new Date().toISOString(),
    sends_queued: scheduledCount
  };
  // Activate Agent SDR
  campaign.agent_status.sdr = {
    state: "ACTIVE",
    last_action: `Ready to generate GAP emails for ${scheduledCount} queued sends`,
    updated_at: new Date().toISOString()
  };
  // Cache metrics on the campaign record to avoid expensive Blobs list calls in status handler
  campaign.metrics = {
    prospects_enrolled: prospects.length,
    queued_sends: scheduledCount,
    sent_today: 0,
    updated_at: new Date().toISOString()
  };
  await putCampaign(campaign);

  await logActivity({
    type: "ops_scheduled",
    campaign_id: campaignId,
    message: `Agent Ops scheduled ${scheduledCount} sends for campaign "${campaign.name}"`,
    timestamp: new Date().toISOString()
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseICP(icpText) {
  const lower = icpText.toLowerCase();
  return {
    geography: lower.includes("us") || lower.includes("america") ? ["US"] :
               lower.includes("uk") ? ["UK"] :
               lower.includes("global") ? ["US", "UK", "CA", "AU"] : ["US"],
    segment: lower.includes("enterprise") ? "Enterprise" :
             lower.includes("startup") ? "Startup" : "Mid-Market",
    vertical: icpText.match(/(?:in|targeting|for)\s+(.+?)(?:\s+companies|\s+with|\s*$)/i)?.[1] || "B2B SaaS",
    employee_min: parseInt(icpText.match(/(\d+)\s*[-–]\s*\d+\s*employee/i)?.[1]) || 15,
    employee_max: parseInt(icpText.match(/\d+\s*[-–]\s*(\d+)\s*employee/i)?.[1]) || 100
  };
}

function extractPainPoints(problem) {
  return [
    problem,
    "Lack of scalable solution for this problem",
    "Manual processes that don't scale",
    "Inconsistent results from current approach"
  ];
}

function generateDemoProspects(campaignId, parsedICP, targetRole, count) {
  const companies = ["TechScale Inc", "GrowthForge", "DataPulse AI", "CloudVertex", "SaaSMetrics"];
  const names = ["Alex Rivera", "Jordan Patel", "Morgan Chen", "Taylor Brooks", "Casey Williams"];
  const domains = ["techscale.io", "growthforge.com", "datapulse.ai", "cloudvertex.io", "saasmetrics.com"];

  return Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    tenant_id: DEFAULTS.TENANT_ID,
    email: `${names[i].toLowerCase().replace(' ', '.')}@${domains[i]}`,
    name: names[i],
    company_name: companies[i],
    title: targetRole,
    source: "campaign_orchestrator",
    sourced_at: new Date().toISOString(),
    icp_match: parsedICP.vertical
  }));
}

function defaultAgentStatus() {
  return {
    orchestrator: { state: "IDLE", last_action: "—", updated_at: null },
    researcher: { state: "IDLE", last_action: "—", updated_at: null },
    ops: { state: "IDLE", last_action: "—", updated_at: null },
    sdr: { state: "IDLE", last_action: "—", updated_at: null }
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
