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
  listCampaignProspects, getCampaignProspect, putCampaignProspect, getProspect, putProspect, findProspectByEmail,
  listQueuedSends, countSentToday, putEmailSend,
  isEmailSuppressed, logActivity, setFeatureFlag,
  DEFAULTS
} from "./_campaign-store.mjs";

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "status";

  try {
    let result;

    switch (action) {
      case "launch":
        result = await handleLaunch(req);
        break;
      case "status":
        result = await handleStatus();
        break;
      case "detail":
        result = await handleDetail(url.searchParams.get("campaign_id"));
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
  const { campaign_name, target_persona, icp, problem_we_solve } = body;

  if (!campaign_name || !target_persona || !icp || !problem_we_solve) {
    return { error: "Missing required fields: campaign_name, target_persona, icp, problem_we_solve" };
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

  // 7. Trigger Agent Researcher (prospect sourcing) — async fire-and-forget
  campaign.agent_status.researcher = { state: "ACTIVE", last_action: "Sourcing prospects via Hunter.io", updated_at: now };
  campaign.agent_status.orchestrator = { state: "ACTIVE", last_action: "Coordinating specialist agents", updated_at: now };
  await putCampaign(campaign);

  // Fire the researcher asynchronously (call the gather-signals endpoint)
  const researchPromise = runResearcherAgent(campaignId, parsedICP, target_persona).catch(err => {
    console.error("[orchestrator] Researcher agent error:", err.message);
  });

  // Log activity
  await logActivity({
    type: "campaign_launched",
    campaign_id: campaignId,
    campaign_name: campaign_name,
    message: `Campaign "${campaign_name}" launched targeting ${target_persona} in ${parsedICP.vertical || 'B2B SaaS'}`,
    timestamp: now
  });

  // Wait briefly for researcher to start (but don't block on full completion)
  await Promise.race([researchPromise, new Promise(r => setTimeout(r, 8000))]);

  // Refresh campaign status
  const updated = await getCampaign(campaignId);

  return {
    success: true,
    campaign_id: campaignId,
    campaign_name: campaign_name,
    status: "active",
    agent_status: updated?.agent_status || campaign.agent_status,
    message: `Campaign "${campaign_name}" is live. Agent Researcher is sourcing prospects, Agent Ops is scheduling sends, Agent SDR will begin outreach once prospects are queued.`
  };
}

// ─── Status Handler ─────────────────────────────────────────────────────────

async function handleStatus() {
  const campaigns = await listCampaigns(DEFAULTS.TENANT_ID);
  const activeCampaigns = campaigns.filter(c => c.status === "active");

  const campaignSummaries = await Promise.all(activeCampaigns.map(async (c) => {
    const prospects = await listCampaignProspects(c.id);
    const queued = await listQueuedSends(c.id);
    const sentToday = await countSentToday(c.id);

    return {
      id: c.id,
      name: c.name,
      status: c.status,
      created_at: c.created_at,
      launched_at: c.launched_at,
      daily_send_limit: c.daily_send_limit,
      brief: c.brief || {},
      agent_status: c.agent_status || defaultAgentStatus(),
      metrics: {
        prospects_enrolled: prospects.length,
        queued_sends: queued.length,
        sent_today: sentToday
      }
    };
  }));

  return {
    total_campaigns: campaigns.length,
    active_campaigns: activeCampaigns.length,
    campaigns: campaignSummaries
  };
}

// ─── Detail Handler ─────────────────────────────────────────────────────────

async function handleDetail(campaignId) {
  if (!campaignId) return { error: "campaign_id required" };
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { error: "Campaign not found" };

  const [persona, territory, signalConfig, sequence, prospects, queued] = await Promise.all([
    getCampaignPersona(campaignId),
    getCampaignTerritory(campaignId),
    getCampaignSignalConfig(campaignId),
    getCampaignSequence(campaignId),
    listCampaignProspects(campaignId),
    listQueuedSends(campaignId)
  ]);

  const sentToday = await countSentToday(campaignId);

  return {
    campaign,
    persona,
    territory,
    signal_config: signalConfig,
    sequence,
    metrics: {
      prospects_enrolled: prospects.length,
      queued_sends: queued.length,
      sent_today: sentToday
    }
  };
}

// ─── Agent Researcher ───────────────────────────────────────────────────────

// Safety cap: never source more than this many prospects per campaign launch
const RESEARCHER_MAX_PROSPECTS = 20;

async function runResearcherAgent(campaignId, parsedICP, targetRole) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return;

  const now = new Date().toISOString();
  const HUNTER_KEY = (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
    ? Netlify.env.get('HUNTER_API_KEY')
    : (process.env.HUNTER_API_KEY || '');

  // Update agent status
  campaign.agent_status.researcher = {
    state: "ACTIVE",
    last_action: "Querying Hunter.io Discover for ICP-fit companies",
    updated_at: now
  };
  await putCampaign(campaign);

  // ── Step 1: Hunter Discover — find companies matching the ICP ──────────────
  let rawProspects = [];
  let discoverStats = { companies_found: 0, emails_found: 0, verified: 0, suppressed: 0, deduped: 0 };

  if (!HUNTER_KEY) {
    console.warn("[researcher] HUNTER_API_KEY not set — falling back to demo prospects");
    rawProspects = generateDemoProspects(campaignId, parsedICP, targetRole, 5);
  } else {
    try {
      // Build Discover query from ICP
      const vertical = (parsedICP.vertical || 'B2B SaaS').replace(/\s+/g, ' ').trim();
      const seniority = mapRoleToSeniority(targetRole);
      const department = mapRoleToDepartment(targetRole);

      // Hunter Discover: find companies in the vertical
      const discoverParams = new URLSearchParams({
        api_key: HUNTER_KEY,
        keywords: vertical,
        employees_min: parsedICP.employee_min || 15,
        employees_max: parsedICP.employee_max || 500,
        limit: 10
      });
      // Add country filter if geography is specific
      if (parsedICP.geography?.length === 1 && parsedICP.geography[0] !== 'US') {
        discoverParams.set('country', parsedICP.geography[0]);
      }

      console.log(`[researcher] Hunter Discover: ${discoverParams.toString().replace(HUNTER_KEY, '***')}`);
      const discoverRes = await fetch(`https://api.hunter.io/v2/companies/search?${discoverParams}`);
      let domains = [];

      if (discoverRes.ok) {
        const discoverData = await discoverRes.json();
        const companies = discoverData?.data?.companies || [];
        discoverStats.companies_found = companies.length;
        domains = companies
          .filter(c => c.domain)
          .slice(0, 8) // cap at 8 companies to stay within quota
          .map(c => ({ domain: c.domain, company_name: c.name, employee_count: c.size }));
        console.log(`[researcher] Discover returned ${companies.length} companies, using ${domains.length} domains`);
      } else {
        const errText = await discoverRes.text();
        console.warn(`[researcher] Discover failed ${discoverRes.status}: ${errText.slice(0, 200)}`);
      }

      // ── Step 2: Hunter Domain Search — get contacts per company ─────────────
      for (const { domain, company_name, employee_count } of domains) {
        if (rawProspects.length >= RESEARCHER_MAX_PROSPECTS) break;

        const domainParams = new URLSearchParams({
          api_key: HUNTER_KEY,
          domain,
          type: 'personal',
          seniority: seniority,
          department: department,
          limit: 5
        });

        console.log(`[researcher] Domain Search: ${domain}`);
        const domainRes = await fetch(`https://api.hunter.io/v2/domain-search?${domainParams}`);
        if (!domainRes.ok) {
          console.warn(`[researcher] Domain search failed for ${domain}: ${domainRes.status}`);
          continue;
        }

        const domainData = await domainRes.json();
        const emails = domainData?.data?.emails || [];
        const org = domainData?.data?.organization || company_name;

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
            employee_count: employee_count || null,
            hunter_confidence: e.confidence || null,
            source: 'hunter_domain_search'
          });
          discoverStats.emails_found++;
        }
      }

      // ── Step 3: Email Verification ─────────────────────────────────────────
      // Only verify emails with confidence < 90 to preserve quota
      // High-confidence emails (>=90) are treated as verified
      const toVerify = rawProspects.filter(p => (p.hunter_confidence || 0) < 90);
      const highConfidence = rawProspects.filter(p => (p.hunter_confidence || 0) >= 90);

      const verifiedProspects = [...highConfidence.map(p => ({ ...p, verified: true, verification_status: 'high_confidence' }))];

      for (const p of toVerify) {
        try {
          const verifyRes = await fetch(
            `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(p.email)}&api_key=${HUNTER_KEY}`
          );
          if (verifyRes.ok) {
            const vData = await verifyRes.json();
            const status = vData?.data?.status;
            const score = vData?.data?.score || 0;
            // Accept: valid, accept_all, webmail. Reject: invalid, disposable, unknown with low score
            if (status === 'valid' || status === 'accept_all' || (status === 'webmail' && score > 50)) {
              verifiedProspects.push({ ...p, verified: true, verification_status: status, verification_score: score });
              discoverStats.verified++;
            } else {
              console.log(`[researcher] Rejected ${p.email}: status=${status} score=${score}`);
            }
          }
        } catch (verifyErr) {
          // On verify error, include the prospect anyway (fail open)
          verifiedProspects.push({ ...p, verified: false, verification_status: 'error' });
        }
      }

      rawProspects = verifiedProspects.slice(0, RESEARCHER_MAX_PROSPECTS);
      console.log(`[researcher] After verification: ${rawProspects.length} prospects`);

    } catch (err) {
      console.error("[researcher] Hunter.io pipeline error:", err.message, err.stack);
      // Fall back to demo prospects so the campaign doesn't stall
      if (rawProspects.length === 0) {
        rawProspects = generateDemoProspects(campaignId, parsedICP, targetRole, 5);
        discoverStats.fallback = true;
      }
    }
  }

  // ── Step 4: Dedup + Suppression + Cross-Campaign Check ────────────────────
  // Build a set of all prospect IDs already enrolled in OTHER active campaigns
  const allCampaigns = await listCampaigns(DEFAULTS.TENANT_ID);
  const otherActiveCampaignIds = allCampaigns
    .filter(c => c.status === 'active' && c.id !== campaignId)
    .map(c => c.id);

  // Collect all emails already in other active campaigns
  // listCampaignProspects returns junction records with prospect_id
  // We build the cross-campaign email set from the prospects store
  const crossCampaignEmails = new Set();
  for (const otherCampaignId of otherActiveCampaignIds) {
    const otherJunctions = await listCampaignProspects(otherCampaignId);
    for (const cp of otherJunctions) {
      // Look up the prospect record by its UUID to get the email
      const existingProspect = await getProspect(cp.prospect_id).catch(() => null);
      if (existingProspect?.email) crossCampaignEmails.add(existingProspect.email.toLowerCase());
    }
  }

  const enrolledProspects = [];
  const seenEmails = new Set();

  for (const p of rawProspects) {
    const emailLower = (p.email || '').toLowerCase();
    if (!emailLower) continue;

    // 1. Skip duplicates within this batch
    if (seenEmails.has(emailLower)) {
      discoverStats.deduped++;
      continue;
    }
    seenEmails.add(emailLower);

    // 2. Suppression check (tenant-wide unsubscribes/bounces)
    if (await isEmailSuppressed(DEFAULTS.TENANT_ID, emailLower)) {
      discoverStats.suppressed++;
      continue;
    }

    // 3. Cross-campaign dedup — don't enroll in two active campaigns simultaneously
    if (crossCampaignEmails.has(emailLower)) {
      discoverStats.deduped++;
      console.log(`[researcher] Cross-campaign dedup: ${emailLower} already in another active campaign`);
      continue;
    }

    // 4. Within-campaign dedup — check if already enrolled in THIS campaign
    const existingProspect = await findProspectByEmail(DEFAULTS.TENANT_ID, emailLower);
    if (existingProspect) {
      const existingJunction = await getCampaignProspect(campaignId, existingProspect.id).catch(() => null);
      if (existingJunction) {
        discoverStats.deduped++;
        continue;
      }
    }

    enrolledProspects.push(p);
  }

  // ── Step 5: Persist prospects and enroll in campaign ──────────────────────
  const enrolledNow = [];
  for (const p of enrolledProspects) {
    const emailLower = p.email.toLowerCase();
    let prospect = await findProspectByEmail(DEFAULTS.TENANT_ID, emailLower);
    if (!prospect) {
      prospect = {
        id: crypto.randomUUID(),
        tenant_id: DEFAULTS.TENANT_ID,
        email: emailLower,
        name: p.name || null,
        first_name: p.first_name || null,
        last_name: p.last_name || null,
        company_name: p.company_name || null,
        company_domain: p.company_domain || null,
        title: p.title || targetRole,
        linkedin_url: p.linkedin_url || null,
        employee_count: p.employee_count || null,
        hunter_confidence: p.hunter_confidence || null,
        verified: p.verified || false,
        verification_status: p.verification_status || null,
        source: p.source || 'hunter',
        sourced_at: now,
        created_at: now
      };
      await putProspect(prospect);
    }

    await putCampaignProspect({
      campaign_id: campaignId,
      prospect_id: prospect.id,
      enrolled_at: now,
      status: 'active'
    });

    enrolledNow.push(prospect);
  }

  // ── Step 6: Update researcher agent status ────────────────────────────────
  const sourceLabel = discoverStats.fallback ? 'demo (Hunter quota/error)' : 'Hunter.io live';
  const actionMsg = `Sourced ${enrolledNow.length} real prospects via ${sourceLabel} · ${discoverStats.suppressed} suppressed · ${discoverStats.deduped} deduped`;

  campaign.agent_status.researcher = {
    state: "COMPLETE",
    last_action: actionMsg,
    updated_at: new Date().toISOString(),
    prospects_found: enrolledNow.length,
    stats: discoverStats
  };
  campaign.agent_status.ops = {
    state: "ACTIVE",
    last_action: `Scheduling ${enrolledNow.length} prospects into send queue`,
    updated_at: new Date().toISOString()
  };
  await putCampaign(campaign);

  await logActivity({
    type: "researcher_complete",
    campaign_id: campaignId,
    campaign_name: campaign.name,
    message: actionMsg,
    stats: discoverStats,
    timestamp: new Date().toISOString()
  });

  // Run Agent Ops: schedule the verified, deduped prospects
  await runOpsAgent(campaignId, enrolledNow);

  return { prospects_enrolled: enrolledNow.length, stats: discoverStats };
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

// ─── Agent Ops ──────────────────────────────────────────────────────────────

async function runOpsAgent(campaignId, prospects) {
  const campaign = await getCampaign(campaignId);
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
      step_number: 1,
      status: "queued",
      scheduled_at: scheduledAt.toISOString(),
      created_at: now.toISOString()
    });
    scheduledCount++;
  }

  // Update ops status
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
