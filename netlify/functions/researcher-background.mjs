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
  listCampaigns, listAllActiveCampaigns, listQueuedSends,
  listCampaignProspects, getCampaignProspect, putCampaignProspect,
  getProspect, putProspect, findProspectByEmail,
  putEmailSend,
  isEmailSuppressed, logActivity,
  DEFAULTS
} from "./_campaign-store.mjs";
import { env } from './_mcp-connectors.mjs';
import { resolveTenantContext } from './_tenant.mjs';
import { isInternalCall } from './_auth.mjs';
import { requireOperator } from './_tenant.mjs';
import { callLLM, parseLLMJson } from './_llm.mjs';

export { icpDiscoverCompanies } from "./_icp-agent.mjs";
import { icpDiscoverCompanies } from "./_icp-agent.mjs";
import { findAndPoolContacts, getBulkLock, setBulkLock } from "./researcher-find.mjs";

// ─── Bulk Find ───────────────────────────────────────────────────────────────
// Fill the contact pool toward a target count (up to 1000) inside this
// background function's 15-minute budget. Each pass discovers the next page
// of ICP-matching companies and pools their contacts; the pool's UNIQUE email
// constraint guarantees zero duplication across every campaign.

const BULK_TIME_BUDGET_MS = 12 * 60 * 1000;
const BULK_ORGS_PER_PASS = 10;

async function runBulkFind({ icp, role, target, tenantId }) {
  // Single-flight: a second bulk job started while one is running would only
  // burn Hunter credits re-finding the first job's contacts.
  const existing = await getBulkLock();
  if (existing) {
    return { skipped: 'bulk job already running', running_icp: existing.icp, running_since: existing.started_at };
  }
  await setBulkLock({ icp, target, started_at: new Date().toISOString() });

  const started = Date.now();
  let inserted = 0, passes = 0, exhausted = false, lastError = null;
  let emptyStreak = 0, errorStreak = 0;
  // Keep pushing through gate-rejected pages and transient hiccups: only a
  // true end-of-market (Discover returns nothing), a hard error streak, or
  // the time budget stops the job.
  while (
    inserted < target &&
    (Date.now() - started) < BULK_TIME_BUDGET_MS &&
    !exhausted && emptyStreak < 8 && errorStreak < 4 && passes < 200
  ) {
    let r;
    try { r = await findAndPoolContacts({ icp, role, orgCount: BULK_ORGS_PER_PASS, tenantId }); }
    catch (e) { r = { error: e.message, transient: true }; }
    passes++;
    if (r.error) {
      lastError = r.error; errorStreak++;
      console.warn(`[bulk-find] pass ${passes} error (${errorStreak}/4): ${r.error}`);
      continue;
    }
    errorStreak = 0;
    inserted += r.inserted;
    exhausted = r.exhausted === true;
    emptyStreak = r.inserted === 0 ? emptyStreak + 1 : 0;
    console.log(`[bulk-find] pass ${passes}: +${r.inserted} (total ${inserted}/${target})${r.inserted === 0 ? ` [empty streak ${emptyStreak}]` : ''}`);
  }
  const stop_reason = inserted >= target ? 'target_reached'
    : exhausted ? 'market_exhausted'
    : errorStreak >= 4 ? `errors: ${lastError}`
    : emptyStreak >= 8 ? 'eight_empty_pages'
    : (Date.now() - started) >= BULK_TIME_BUDGET_MS ? 'time_budget'
    : 'pass_cap';
  await setBulkLock({ icp, target, started_at: new Date(started).toISOString(), released_at: new Date().toISOString(), inserted, stop_reason });
  await logActivity({ type: 'researcher_bulk_find', target, inserted, passes, exhausted, stop_reason, icp });
  return { inserted, target, passes, exhausted, stop_reason, error: lastError, elapsed_s: Math.round((Date.now() - started) / 1000) };
}

export async function syncContactToSupabase(prospect, campaignName) {
  try {
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_ROLE_KEY') /* service role only — no anon fallback */;
    if (!url || !key || !prospect.email) return false;
    const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const existing = await fetch(
      `${url}/rest/v1/contacts?select=id&email=eq.${encodeURIComponent(prospect.email)}&limit=1`,
      { headers: h }).then(r => r.ok ? r.json() : []);
    if (existing.length) return false;
    const res = await fetch(`${url}/rest/v1/contacts`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        name: prospect.name || prospect.contact_name || prospect.email.split('@')[0],
        email: prospect.email,
        company_name: prospect.company_name || null,
        type: 'Prospect',
        source: campaignName ? `Campaign: ${campaignName}` : 'campaign_researcher'
      })
    });
    return res.ok;
  } catch { return false; }
}

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
  const startTs = Date.now();
  console.log(`[researcher-bg] START campaign=${campaignId} role="${targetRole}" icp=${JSON.stringify(parsedICP)}`);

  const HUNTER_KEY = (typeof Netlify !== 'undefined' && Netlify.env?.get('HUNTER_API_KEY'))
    ? Netlify.env.get('HUNTER_API_KEY')
    : (process.env.HUNTER_API_KEY || '');
  console.log(`[researcher-bg] HUNTER_API_KEY present: ${HUNTER_KEY ? 'yes (' + HUNTER_KEY.slice(0,8) + '...)' : 'NO — using demo fallback'}`);

  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    console.error(`[researcher-bg] Campaign ${campaignId} not found`);
    return;
  }
  // No JWT here (background/cron) — the campaign record carries the tenant.
  const tenantId = campaign.tenant_id || DEFAULTS.TENANT_ID;

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

    // ICP Agent first: real companies matching the campaign's ICP text.
    // discover_offset walks the full Discover result set (often 10k+
    // companies) so successive runs source NEW companies, not page 1 forever.
    const icpText = campaign?.brief?.icp || parsedICP?.raw || '';
    const discOffset = Number(campaign.discover_offset) || 0;
    const disc = await icpDiscoverCompanies(icpText, targetRole, HUNTER_KEY, 10, discOffset);
    let domains;
    if (disc.companies.length) {
      domains = disc.companies;
      discoverStats.discover_mode = disc.mode;
      discoverStats.discover_filters = disc.filters;
      discoverStats.market_size = disc.total;
      campaign.discover_offset = disc.next_offset;
      await putCampaign(campaign);
    } else {
      domains = selectICPDomains(parsedICP, targetRole);
      discoverStats.discover_mode = `fallback_domain_map (${disc.mode})`;
    }
    discoverStats.companies_found = domains.length;

    console.log(`[researcher-bg] Sourcing via ${discoverStats.discover_mode}: ${domains.map(d => d.domain).join(', ')} for "${targetRole}"`);

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

  // Cross-campaign dedup + suppression (within this campaign's tenant)
  const allCampaigns = await listCampaigns(tenantId);
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
    if (await isEmailSuppressed(tenantId, emailLower)) { discoverStats.suppressed++; continue; }
    if (crossCampaignEmails.has(emailLower)) { discoverStats.deduped++; continue; }
    const existing = await findProspectByEmail(tenantId, emailLower);
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
    let prospect = await findProspectByEmail(tenantId, emailLower);
    if (!prospect) {
      prospect = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        email: emailLower,
        name: p.name || null,
        first_name: p.first_name || null,
        last_name: p.last_name || null,
        // Field aliases: older functions (send-worker, gather-signals, loop-engine,
        // generate-gap-email, gap-email-pipeline) read `contact_name` and `role`.
        // New researcher writes `name` and `title`. Write both so all paths work.
        contact_name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
        role: p.title || targetRole,
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
    await syncContactToSupabase(prospect, campaign?.name);
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
      tenant_id: tenantId,
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
  if (freshCampaign && campaign.discover_offset != null) freshCampaign.discover_offset = campaign.discover_offset;
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

  console.log(`[researcher-bg] DONE: ${enrolled.length} prospects enrolled, ${scheduledCount} sends queued in ${Date.now() - startTs}ms`);
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

// ─── Auto-Source Top-Up Sweep ────────────────────────────────────────────────
// For every ACTIVE campaign with auto_source === true whose queued-send count
// has dropped below its floor (auto_source_min_queue, default 5), re-run the
// researcher against the campaign's stored brief. Rate-limited per campaign
// via last_sourced_at (min 6h between sourcing runs) so a busy cron cadence
// never turns into prospect spam.

const TOPUP_MIN_QUEUE_DEFAULT = 5;
const TOPUP_COOLDOWN_MS = 6 * 60 * 60 * 1000;

async function runTopUpSweep() {
  const summary = { campaigns_checked: 0, campaigns_topped_up: 0, skipped: [] };
  // Sweep every tenant's active campaigns — runResearcher scopes each run to
  // the campaign's own tenant_id.
  const campaigns = (await listAllActiveCampaigns()).filter(c => c.auto_source === true);
  summary.campaigns_checked = campaigns.length;

  for (const campaign of campaigns) {
    const minQueue = Number(campaign.auto_source_min_queue) || TOPUP_MIN_QUEUE_DEFAULT;
    const queued = await listQueuedSends(campaign.id);
    if (queued.length >= minQueue) {
      summary.skipped.push({ campaign: campaign.name, reason: `queue healthy (${queued.length})` });
      continue;
    }
    if (campaign.last_sourced_at && (Date.now() - new Date(campaign.last_sourced_at).getTime()) < TOPUP_COOLDOWN_MS) {
      summary.skipped.push({ campaign: campaign.name, reason: 'sourced within last 6h' });
      continue;
    }

    campaign.last_sourced_at = new Date().toISOString();
    await putCampaign(campaign);

    const role = campaign.target_role || campaign.brief?.target_persona || '';
    console.log(`[researcher-bg] TOP-UP campaign=${campaign.id} "${campaign.name}" queue=${queued.length} role="${role}"`);
    try {
      await runResearcher(campaign.id, campaign.parsed_icp || {}, role);
      summary.campaigns_topped_up++;
      await logActivity({
        type: 'auto_source_topup',
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        queue_before: queued.length
      });
    } catch (e) {
      console.error(`[researcher-bg] top-up failed for ${campaign.name}:`, e.message);
      summary.skipped.push({ campaign: campaign.name, reason: `error: ${e.message}` });
    }
  }
  return summary;
}

export default async (req) => {
  // Background functions return 202 immediately; work runs after response
  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const { campaign_id, parsed_icp, target_role } = body;

  // Bulk find: fill the contact pool toward a target count for the Researcher
  // panel. Runs here for the 15-minute background budget.
  if (body.action === 'bulk_find') {
    // Pool inserts are tenant-scoped: JWT → caller's tenant; no auth header →
    // demo tenant (internal calls); bad token → 401.
    const authCtx = await resolveTenantContext(req);
    if (authCtx.invalid) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: authCtx.status || 401, headers: { 'Content-Type': 'application/json' }
      });
    }
    const result = await runBulkFind({
      icp: (body.icp || '').trim(),
      role: (body.role || 'CEO').trim(),
      target: Math.min(Number(body.target_contacts) || 100, 1000),
      tenantId: authCtx.tenantId || DEFAULTS.TENANT_ID
    }).catch(err => ({ error: err.message }));
    return new Response(JSON.stringify({ mode: 'bulk_find', ...result }), {
      status: result.error ? 500 : 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // SECURITY: background functions are URL-invocable
  // (/.netlify/functions/researcher-background). Every mode other than a
  // tenant-JWT bulk_find is internal-only (queue-manager sends X-Internal-Token)
  // or a platform operator.
  if (!isInternalCall(req)) {
    const op = await requireOperator(req, { allowInternal: false });
    if (op.response) return op.response;
  }

  // Top-up mode: scheduled invocations carry no campaign_id. Instead of the old
  // 400 no-op, sweep active campaigns that opted into auto-sourcing (auto_source
  // = true) and refill any whose queue has run low. This is what keeps campaigns
  // fed after the initial launch batch is exhausted.
  if (!campaign_id) {
    const summary = await runTopUpSweep().catch(err => ({ error: err.message }));
    return new Response(JSON.stringify({ mode: 'top_up_sweep', ...summary }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Await the full run: fire-and-forget proved unreliable (the runtime can
  // freeze right after the response, killing the researcher mid-run). As a
  // background function we have minutes of budget — completing the work
  // before responding guarantees enrollment actually happens.
  try {
    await runResearcher(campaign_id, parsed_icp || {}, target_role || '');
  } catch (err) {
    console.error('[researcher-bg] FATAL campaign=' + campaign_id + ':', err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message, campaign_id }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({
    completed: true,
    campaign_id,
    message: 'Agent Researcher finished — prospects enrolled and sends queued'
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = {
  // Scheduled only — no path (Netlify disallows path + schedule together)
};
