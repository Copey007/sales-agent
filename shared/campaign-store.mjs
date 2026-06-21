/**
 * Campaign Data Store — Netlify Blobs-based multi-campaign data layer.
 * 
 * Mirrors the Supabase schema from the Multi-Campaign Plan so a later
 * Blobs → Supabase migration is clean. Each entity type gets its own
 * Netlify Blobs store (namespace). Records are keyed by UUID.
 *
 * Stores:
 *   tenants          — tenant records
 *   campaigns        — campaign records (keyed by campaign_id)
 *   personas         — persona records (keyed by persona_id)
 *   territories      — territory records
 *   signal_configs   — per-campaign signal configuration
 *   sequences        — per-campaign sequence/cadence config
 *   prospects        — prospect records (tenant-wide)
 *   campaign_prospects — junction table (keyed by campaign_id:prospect_id)
 *   email_sends      — operational send ledger
 *   loop_experiments — per-campaign loop experiment history
 *   replies          — inbound reply records
 *   suppression_list — suppressed emails
 *   activity_log     — system activity log
 *   feature_flags    — feature flag state
 */

// @netlify/blobs is loaded dynamically at runtime (not bundled by esbuild)
let _getStore = null;
async function ensureBlobs() {
  if (!_getStore) {
    const mod = await import('@netlify/blobs');
    _getStore = mod.getStore;
  }
  return _getStore;
}

// ─── Store Accessors ────────────────────────────────────────────────────────

// ─── Generic CRUD helpers ───────────────────────────────────────────────────

async function getRecord(storeName, key) {
  const getStore = await ensureBlobs();
  const s = getStore(storeName);
  const raw = await s.get(key);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function putRecord(storeName, key, data) {
  const getStore = await ensureBlobs();
  const s = getStore(storeName);
  await s.set(key, JSON.stringify(data));
  return data;
}

async function deleteRecord(storeName, key) {
  const getStore = await ensureBlobs();
  const s = getStore(storeName);
  await s.delete(key);
}

async function listRecords(storeName, prefix = "") {
  const getStore = await ensureBlobs();
  const s = getStore(storeName);
  const { blobs } = await s.list({ prefix });
  const results = [];
  for (const blob of blobs) {
    const raw = await s.get(blob.key);
    if (raw) results.push(JSON.parse(raw));
  }
  return results;
}

// ─── Entity-specific accessors ──────────────────────────────────────────────

// TENANTS
export async function getTenant(tenantId) {
  return getRecord("tenants", tenantId);
}
export async function putTenant(tenant) {
  return putRecord("tenants", tenant.id, tenant);
}

// CAMPAIGNS
export async function getCampaign(campaignId) {
  return getRecord("campaigns", campaignId);
}
export async function putCampaign(campaign) {
  return putRecord("campaigns", campaign.id, campaign);
}
export async function listCampaigns(tenantId) {
  const all = await listRecords("campaigns");
  return all.filter(c => c.tenant_id === tenantId);
}
export async function listActiveCampaigns(tenantId) {
  const all = await listCampaigns(tenantId);
  return all.filter(c => c.status === "active");
}

// PERSONAS
export async function getPersona(personaId) {
  return getRecord("personas", personaId);
}
export async function putPersona(persona) {
  return putRecord("personas", persona.id, persona);
}
export async function getCampaignPersona(campaignId) {
  const all = await listRecords("personas");
  return all.find(p => p.campaign_id === campaignId) || null;
}

// TERRITORIES
export async function getTerritory(territoryId) {
  return getRecord("territories", territoryId);
}
export async function putTerritory(territory) {
  return putRecord("territories", territory.id, territory);
}
export async function getCampaignTerritory(campaignId) {
  const all = await listRecords("territories");
  return all.find(t => t.campaign_id === campaignId) || null;
}

// SIGNAL CONFIGS
export async function getSignalConfig(configId) {
  return getRecord("signal_configs", configId);
}
export async function putSignalConfig(config) {
  return putRecord("signal_configs", config.id, config);
}
export async function getCampaignSignalConfig(campaignId) {
  const all = await listRecords("signal_configs");
  return all.find(sc => sc.campaign_id === campaignId) || null;
}

// SEQUENCES
export async function getSequence(sequenceId) {
  return getRecord("sequences", sequenceId);
}
export async function putSequence(sequence) {
  return putRecord("sequences", sequence.id, sequence);
}
export async function getCampaignSequence(campaignId) {
  const all = await listRecords("sequences");
  return all.find(s => s.campaign_id === campaignId) || null;
}

// PROSPECTS
export async function getProspect(prospectId) {
  return getRecord("prospects", prospectId);
}
export async function putProspect(prospect) {
  return putRecord("prospects", prospect.id, prospect);
}
export async function findProspectByEmail(tenantId, email) {
  const all = await listRecords("prospects");
  return all.find(p => p.tenant_id === tenantId && p.email === email) || null;
}

// CAMPAIGN PROSPECTS (junction)
export async function getCampaignProspect(campaignId, prospectId) {
  return getRecord("campaign_prospects", `${campaignId}:${prospectId}`);
}
export async function putCampaignProspect(record) {
  return putRecord("campaign_prospects", `${record.campaign_id}:${record.prospect_id}`, record);
}
export async function listCampaignProspects(campaignId) {
  const all = await listRecords("campaign_prospects");
  return all.filter(cp => cp.campaign_id === campaignId);
}

// EMAIL SENDS (operational ledger)
export async function getEmailSend(sendId) {
  return getRecord("email_sends", sendId);
}
export async function putEmailSend(send) {
  return putRecord("email_sends", send.id, send);
}
export async function listQueuedSends(campaignId) {
  const all = await listRecords("email_sends");
  return all.filter(s => s.campaign_id === campaignId && s.status === "queued");
}
export async function listDueSends(now) {
  const all = await listRecords("email_sends");
  return all.filter(s => s.status === "queued" && new Date(s.scheduled_at) <= now);
}
export async function countSentToday(campaignId) {
  const all = await listRecords("email_sends");
  const today = new Date().toISOString().slice(0, 10);
  return all.filter(s =>
    s.campaign_id === campaignId &&
    s.status === "sent" &&
    s.sent_at && s.sent_at.slice(0, 10) === today
  ).length;
}

// LOOP EXPERIMENTS (per-campaign)
export async function getLoopExperiment(experimentId) {
  return getRecord("loop_experiments", experimentId);
}
export async function putLoopExperiment(experiment) {
  return putRecord("loop_experiments", experiment.id, experiment);
}
export async function listCampaignExperiments(campaignId) {
  const all = await listRecords("loop_experiments");
  return all.filter(e => e.campaign_id === campaignId);
}

// REPLIES
export async function getReply(replyId) {
  return getRecord("replies", replyId);
}
export async function putReply(reply) {
  return putRecord("replies", reply.id, reply);
}

// SUPPRESSION LIST
export async function isEmailSuppressed(tenantId, email) {
  const record = await getRecord("suppression_list", `${tenantId}:${email}`);
  return !!record;
}
export async function addToSuppressionList(record) {
  return putRecord("suppression_list", `${record.tenant_id}:${record.email}`, record);
}

// ACTIVITY LOG
export async function logActivity(entry) {
  const id = entry.id || crypto.randomUUID();
  entry.id = id;
  entry.timestamp = entry.timestamp || new Date().toISOString();
  return putRecord("activity_log", id, entry);
}
export async function listActivityLog(limit = 50) {
  const all = await listRecords("activity_log");
  return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

// FEATURE FLAGS
export async function getFeatureFlag(flagName) {
  const record = await getRecord("feature_flags", flagName);
  return record ? record.enabled : false;
}
export async function setFeatureFlag(flagName, enabled, metadata = {}) {
  return putRecord("feature_flags", flagName, {
    name: flagName,
    enabled,
    updated_at: new Date().toISOString(),
    ...metadata
  });
}

// ─── Default Seed Data ──────────────────────────────────────────────────────

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_CAMPAIGN_ID = "00000000-0000-0000-0000-000000000010";

export const DEFAULTS = {
  TENANT_ID: DEFAULT_TENANT_ID,
  CAMPAIGN_ID: DEFAULT_CAMPAIGN_ID
};

export async function seedDefaults() {
  // Check if already seeded
  const existing = await getTenant(DEFAULT_TENANT_ID);
  if (existing) return { seeded: false, message: "Already seeded" };

  // Seed default tenant
  await putTenant({
    id: DEFAULT_TENANT_ID,
    name: "A-Gent Fleet",
    subscription_tier: "starter",
    created_at: new Date().toISOString()
  });

  // Seed default campaign
  await putCampaign({
    id: DEFAULT_CAMPAIGN_ID,
    tenant_id: DEFAULT_TENANT_ID,
    name: "Default Campaign",
    status: "active",
    daily_send_limit: 50,
    sending_domain: null, // To be configured
    created_at: new Date().toISOString()
  });

  // Seed default persona (B2B SaaS CEO/Founder)
  const personaId = "00000000-0000-0000-0000-000000000020";
  await putPersona({
    id: personaId,
    tenant_id: DEFAULT_TENANT_ID,
    campaign_id: DEFAULT_CAMPAIGN_ID,
    target_role: "CEO / Founder",
    pain_points: [
      "Manual prospecting doesn't scale",
      "Sales team inconsistency",
      "Pipeline unpredictability",
      "Can't hire fast enough to grow revenue"
    ],
    messaging_angle: "AI-powered outbound that runs autonomously, generating qualified pipeline without adding headcount",
    gap_current_state: "Manual, inconsistent outbound prospecting that depends on individual rep effort and doesn't scale",
    gap_future_state: "Autonomous AI-driven pipeline generation that runs 24/7, producing consistent qualified opportunities at scale"
  });

  // Seed default territory
  const territoryId = "00000000-0000-0000-0000-000000000030";
  await putTerritory({
    id: territoryId,
    tenant_id: DEFAULT_TENANT_ID,
    campaign_id: DEFAULT_CAMPAIGN_ID,
    geography: ["US", "UK", "CA"],
    segment: "Mid-Market",
    vertical: "B2B SaaS",
    employee_min: 15,
    employee_max: 100,
    hunter_domain_filters: null
  });

  // Seed default signal config
  const signalConfigId = "00000000-0000-0000-0000-000000000040";
  await putSignalConfig({
    id: signalConfigId,
    tenant_id: DEFAULT_TENANT_ID,
    campaign_id: DEFAULT_CAMPAIGN_ID,
    signal_types: ["company_news", "hiring", "funding", "product_launch", "leadership_change"],
    serp_query_templates: [
      "{company} news {year}",
      "{company} hiring sales",
      "{contact_name} {company} LinkedIn",
      "{company} funding announcement"
    ]
  });

  // Seed default sequence
  const sequenceId = "00000000-0000-0000-0000-000000000050";
  await putSequence({
    id: sequenceId,
    tenant_id: DEFAULT_TENANT_ID,
    campaign_id: DEFAULT_CAMPAIGN_ID,
    step_count: 12,
    cadence_config: {
      step_delays_days: [0, 3, 3, 4, 5, 5, 7, 7, 7, 10, 10, 14]
    },
    template_baseline: null, // Uses the GAP framework default
    loop_enabled: true
  });

  // Set feature flags
  await setFeatureFlag("multi_campaign_orchestration", false, {
    description: "Enable the new multi-campaign Queue Manager + Send Worker orchestration path"
  });
  await setFeatureFlag("queue_manager_active", false, {
    description: "Enable the scheduled Queue Manager polling"
  });

  return { seeded: true, message: "Default tenant, campaign, persona, territory, signal_config, and sequence created" };
}
