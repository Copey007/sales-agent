/**
 * Researcher Background Function
 *
 * Netlify background functions run for up to 15 minutes (vs 26s for regular functions).
 * This function is called by the campaign-orchestrator after campaign creation,
 * receives the campaign_id + ICP params, and runs the full Hunter.io pipeline:
 *   1. Select ICP-fit company domains
 *   2. Hunter Domain Search per company
 *   3. Email verification (low-confidence emails only)
 *   4. Cross-campaign dedup + suppression check
 *   5. Enroll verified prospects into the campaign
 *   6. Hand off to Agent Ops (queue scheduling)
 *
 * Invoked via POST /api/researcher-background with JSON body:
 *   { campaign_id, parsed_icp, target_role }
 *
 * Returns 202 immediately (background function pattern).
 */

import {
  getCampaign, putCampaign,
  listCampaigns,
  listCampaignProspects, getCampaignProspect, putCampaignProspect,
  getProspect, putProspect, findProspectByEmail,
  putEmailSend,
  isEmailSuppressed, logActivity,
  DEFAULTS
} from "./_campaign-store.mjs";

const RESEARCHER_MAX_PROSPECTS = 20;

// ─── ICP Domain Map ──────────────────────────────────────────────────────────

const ICP_DOMAIN_MAP = {
  sales: [
    { domain: 'gong.io', company_name: 'Gong' },
    { domain: 'outreach.io', company_name: 'Outreach' },
    { domain: 'salesloft.com', company_name: 'Salesloft' },
    { domain: 'clari.com', company_name: 'Clari' },
    { domain: 'apollo.io', company_name: 'Apollo.io' },
    { domain: 'seamless.ai', company_name: 'Seamless.AI' },
    { domain: 'lusha.com', company_name: 'Lusha' },
    { domain: 'cognism.com', company_name: 'Cognism' },
    { domain: 'drift.com', company_name: 'Drift' },
    { domain: 'chorus.ai', company_name: 'Chorus.ai' },
  ],
  marketing: [
    { domain: 'hubspot.com', company_name: 'HubSpot' },
    { domain: 'klaviyo.com', company_name: 'Klaviyo' },
    { domain: 'activecampaign.com', company_name: 'ActiveCampaign' },
    { domain: 'intercom.com', company_name: 'Intercom' },
    { domain: 'braze.com', company_name: 'Braze' },
    { domain: 'iterable.com', company_name: 'Iterable' },
    { domain: 'customer.io', company_name: 'Customer.io' },
    { domain: 'drip.com', company_name: 'Drip' },
    { domain: 'convertkit.com', company_name: 'ConvertKit' },
    { domain: 'omnisend.com', company_name: 'Omnisend' },
  ],
  executive: [
    { domain: 'linear.app', company_name: 'Linear' },
    { domain: 'retool.com', company_name: 'Retool' },
    { domain: 'lattice.com', company_name: 'Lattice' },
    { domain: 'rippling.com', company_name: 'Rippling' },
    { domain: 'deel.com', company_name: 'Deel' },
    { domain: 'remote.com', company_name: 'Remote' },
    { domain: 'gusto.com', company_name: 'Gusto' },
    { domain: 'justworks.com', company_name: 'Justworks' },
    { domain: 'bamboohr.com', company_name: 'BambooHR' },
    { domain: 'workday.com', company_name: 'Workday' },
  ],
  engineering: [
    { domain: 'sentry.io', company_name: 'Sentry' },
    { domain: 'launchdarkly.com', company_name: 'LaunchDarkly' },
    { domain: 'split.io', company_name: 'Split' },
    { domain: 'amplitude.com', company_name: 'Amplitude' },
    { domain: 'mixpanel.com', company_name: 'Mixpanel' },
    { domain: 'fullstory.com', company_name: 'FullStory' },
    { domain: 'logrocket.com', company_name: 'LogRocket' },
    { domain: 'rollbar.com', company_name: 'Rollbar' },
    { domain: 'honeycomb.io', company_name: 'Honeycomb' },
    { domain: 'grafana.com', company_name: 'Grafana' },
  ],
  default: [
    { domain: 'pipedrive.com', company_name: 'Pipedrive' },
    { domain: 'close.com', company_name: 'Close' },
    { domain: 'copper.com', company_name: 'Copper' },
    { domain: 'nutshell.com', company_name: 'Nutshell' },
    { domain: 'insightly.com', company_name: 'Insightly' },
    { domain: 'streak.com', company_name: 'Streak' },
    { domain: 'nimble.com', company_name: 'Nimble' },
    { domain: 'freshsales.io', company_name: 'Freshsales' },
    { domain: 'zoho.com', company_name: 'Zoho' },
    { domain: 'agilecrm.com', company_name: 'Agile CRM' },
  ]
};

function selectICPDomains(parsedICP, targetRole) {
  const role = (targetRole || '').toLowerCase();
  const vertical = (parsedICP?.vertical || '').toLowerCase();
  let segment = 'default';
  if (role.includes('sales') || role.includes('revenue') || role.includes('revops') || role.includes('sdr') || role.includes('ae')) segment = 'sales';
  else if (role.includes('marketing') || role.includes('growth') || role.includes('demand') || role.includes('cmo')) segment = 'marketing';
  else if (role.includes('ceo') || role.includes('founder') || role.includes('president') || role.includes('coo') || role.includes('owner')) segment = 'executive';
  else if (role.includes('cto') || role.includes('engineer') || role.includes('tech') || role.includes('product')) segment = 'engineering';
  else if (vertical.includes('sales') || vertical.includes('crm') || vertical.includes('revenue')) segment = 'sales';
  else if (vertical.includes('marketing') || vertical.includes('email') || vertical.includes('growth')) segment = 'marketing';
  return (ICP_DOMAIN_MAP[segment] || ICP_DOMAIN_MAP.default).slice(0, 8);
}

function mapRoleToSeniority(role) {
  const r = (role || '').toLowerCase();
  if (r.includes('ceo') || r.includes('cto') || r.includes('cfo') || r.includes('founder') || r.includes('president')) return 'executive';
  if (r.includes('vp') || r.includes('vice president') || r.includes('director') || r.includes('head of')) return 'senior,executive';
  if (r.includes('manager') || r.includes('lead')) return 'senior';
  return 'senior,executive';
}

function mapRoleToDepartment(role) {
  const r = (role || '').toLowerCase();
  if (r.includes('sales') || r.includes('revenue') || r.includes('revops') || r.includes('sdr') || r.includes('ae')) return 'sales';
  if (r.includes('marketing') || r.includes('growth') || r.includes('demand')) return 'marketing';
  if (r.includes('engineer') || r.includes('tech') || r.includes('cto') || r.includes('product')) return 'it';
  if (r.includes('ceo') || r.includes('founder') || r.includes('president') || r.includes('coo')) return 'executive';
  return 'executive,sales';
}

// ─── Main Researcher Logic ───────────────────────────────────────────────────

async function runResearcher(campaignId, parsedICP, targetRole) {
  const HUNTER_KEY = (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
    ? Netlify.env.get('HUNTER_API_KEY')
    : (process.env.HUNTER_API_KEY || '');

  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    console.error(`[researcher-bg] Campaign ${campaignId} not found`);
    return;
  }

  const now = new Date().toISOString();
  let rawProspects = [];
  let discoverStats = { companies_found: 0, emails_found: 0, verified: 0, suppressed: 0, deduped: 0 };

  if (!HUNTER_KEY) {
    console.warn('[researcher-bg] No HUNTER_API_KEY — using demo prospects');
    rawProspects = generateDemoProspects(parsedICP, targetRole, 5);
    discoverStats.fallback = true;
  } else {
    const seniority = mapRoleToSeniority(targetRole);
    const department = mapRoleToDepartment(targetRole);
    const domains = selectICPDomains(parsedICP, targetRole);
    discoverStats.companies_found = domains.length;

    console.log(`[researcher-bg] Running domain search on ${domains.length} companies for "${targetRole}"`);

    // Domain Search per company
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
        if (!res.ok) {
          console.warn(`[researcher-bg] Domain search failed for ${domain}: ${res.status}`);
          continue;
        }

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
        console.warn(`[researcher-bg] Error searching ${domain}: ${err.message}`);
      }
    }

    // Email Verification (only for low-confidence emails to preserve quota)
    const highConf = rawProspects.filter(p => (p.hunter_confidence || 0) >= 90);
    const lowConf = rawProspects.filter(p => (p.hunter_confidence || 0) < 90);
    const verified = [...highConf.map(p => ({ ...p, verified: true, verification_status: 'high_confidence' }))];

    for (const p of lowConf) {
      try {
        const vRes = await fetch(
          `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(p.email)}&api_key=${HUNTER_KEY}`
        );
        if (vRes.ok) {
          const vData = await vRes.json();
          const status = vData?.data?.status;
          const score = vData?.data?.score || 0;
          if (status === 'valid' || status === 'accept_all' || (status === 'webmail' && score > 50)) {
            verified.push({ ...p, verified: true, verification_status: status, verification_score: score });
            discoverStats.verified++;
          } else {
            console.log(`[researcher-bg] Rejected ${p.email}: ${status} score=${score}`);
          }
        }
      } catch {
        verified.push({ ...p, verified: false, verification_status: 'error' });
      }
    }

    rawProspects = verified.slice(0, RESEARCHER_MAX_PROSPECTS);
    console.log(`[researcher-bg] After verification: ${rawProspects.length} prospects`);
  }

  // Cross-campaign dedup + suppression
  const allCampaigns = await listCampaigns(DEFAULTS.TENANT_ID);
  const otherActiveIds = allCampaigns
    .filter(c => c.status === 'active' && c.id !== campaignId)
    .map(c => c.id);

  const crossCampaignEmails = new Set();
  for (const otherId of otherActiveIds) {
    const junctions = await listCampaignProspects(otherId);
    for (const cp of junctions) {
      const p = await getProspect(cp.prospect_id).catch(() => null);
      if (p?.email) crossCampaignEmails.add(p.email.toLowerCase());
    }
  }

  const seenEmails = new Set();
  const toEnroll = [];

  for (const p of rawProspects) {
    const emailLower = (p.email || '').toLowerCase();
    if (!emailLower) continue;
    if (seenEmails.has(emailLower)) { discoverStats.deduped++; continue; }
    seenEmails.add(emailLower);
    if (await isEmailSuppressed(DEFAULTS.TENANT_ID, emailLower)) { discoverStats.suppressed++; continue; }
    if (crossCampaignEmails.has(emailLower)) { discoverStats.deduped++; continue; }
    const existing = await findProspectByEmail(DEFAULTS.TENANT_ID, emailLower);
    if (existing) {
      const junction = await getCampaignProspect(campaignId, existing.id).catch(() => null);
      if (junction) { discoverStats.deduped++; continue; }
    }
    toEnroll.push(p);
  }

  // Persist + enroll
  const enrolled = [];
  for (const p of toEnroll) {
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

  // Schedule sends (Agent Ops)
  const scheduleNow = new Date();
  let scheduledCount = 0;
  for (const prospect of enrolled) {
    const sendId = crypto.randomUUID();
    const scheduledAt = new Date(scheduleNow.getTime() + scheduledCount * 120000);
    await putEmailSend({
      id: sendId,
      tenant_id: DEFAULTS.TENANT_ID,
      campaign_id: campaignId,
      prospect_id: prospect.id,
      step_number: 1,
      status: 'queued',
      scheduled_at: scheduledAt.toISOString(),
      created_at: now
    });
    scheduledCount++;
  }

  // Update campaign with final status + cached metrics
  const freshCampaign = await getCampaign(campaignId);
  if (freshCampaign) {
    const sourceLabel = discoverStats.fallback ? 'demo (fallback)' : 'Hunter.io live';
    freshCampaign.agent_status.researcher = {
      state: 'COMPLETE',
      last_action: `Sourced ${enrolled.length} real prospects via ${sourceLabel} · ${discoverStats.suppressed} suppressed · ${discoverStats.deduped} deduped`,
      updated_at: new Date().toISOString(),
      prospects_found: enrolled.length,
      stats: discoverStats
    };
    freshCampaign.agent_status.ops = {
      state: 'ACTIVE',
      last_action: `Queued ${scheduledCount} sends (warmup throttle: 2min spacing)`,
      updated_at: new Date().toISOString(),
      sends_queued: scheduledCount
    };
    freshCampaign.agent_status.sdr = {
      state: 'ACTIVE',
      last_action: `Ready to generate GAP emails for ${scheduledCount} queued sends`,
      updated_at: new Date().toISOString()
    };
    freshCampaign.metrics = {
      prospects_enrolled: enrolled.length,
      queued_sends: scheduledCount,
      sent_today: 0,
      updated_at: new Date().toISOString()
    };
    await putCampaign(freshCampaign);
  }

  await logActivity({
    type: 'researcher_complete',
    campaign_id: campaignId,
    message: `Agent Researcher sourced ${enrolled.length} prospects for campaign "${campaign.name}" · stats: ${JSON.stringify(discoverStats)}`,
    timestamp: new Date().toISOString()
  });

  console.log(`[researcher-bg] DONE: ${enrolled.length} prospects enrolled, ${scheduledCount} sends queued`);
}

function generateDemoProspects(parsedICP, targetRole, count) {
  const companies = ['TechScale Inc', 'GrowthForge', 'DataPulse AI', 'CloudVertex', 'SaaSMetrics'];
  const names = ['Alex Rivera', 'Jordan Patel', 'Morgan Chen', 'Taylor Brooks', 'Casey Williams'];
  const domains = ['techscale.io', 'growthforge.com', 'datapulse.ai', 'cloudvertex.io', 'saasmetrics.com'];
  return Array.from({ length: count }, (_, i) => ({
    email: `${names[i].toLowerCase().replace(' ', '.')}@${domains[i]}`,
    name: names[i],
    first_name: names[i].split(' ')[0],
    last_name: names[i].split(' ')[1],
    company_name: companies[i],
    company_domain: domains[i],
    title: targetRole,
    hunter_confidence: 95,
    verified: true,
    verification_status: 'demo',
    source: 'demo_fallback'
  }));
}

// ─── Netlify Background Function Handler ────────────────────────────────────

export default async (req) => {
  // Background functions return 202 immediately; work runs after response
  let body = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { campaign_id, parsed_icp, target_role } = body;
  if (!campaign_id) {
    return new Response(JSON.stringify({ error: 'campaign_id required' }), { status: 400 });
  }

  // Run researcher in background (after response is sent)
  // Netlify background functions: the handler must return a response,
  // then any remaining async work continues until the function exits
  runResearcher(campaign_id, parsed_icp || {}, target_role || '').catch(err => {
    console.error('[researcher-bg] Fatal error:', err.message, err.stack);
  });

  return new Response(JSON.stringify({
    accepted: true,
    campaign_id,
    message: 'Agent Researcher started — prospects will be enrolled within 60 seconds'
  }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = {
  path: '/api/researcher-background'
};
