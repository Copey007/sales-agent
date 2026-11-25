-- ============================================================================
-- Avatar module — multi-tenant, commercial.
-- Two tables:
--   avatar_agents   : per-tenant agent config (the product surface)
--   avatar_sessions : live session log -> powers concurrency caps, usage
--                     metering, billing, and stale-session cleanup.
-- Forward-compatible with the Platform Core: tenant_id is present now and
-- will FK to tenants(id) once the core lands.
-- ============================================================================

CREATE TABLE IF NOT EXISTS avatar_agents (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug               TEXT UNIQUE NOT NULL,                 -- the /a/<slug> URL
  tenant_id          UUID,                                 -- FK to tenants(id) later
  name               TEXT NOT NULL DEFAULT 'AI Agent',
  status             TEXT NOT NULL DEFAULT 'active',       -- active | paused | disabled
  -- Avatar / voice
  avatar_id          TEXT NOT NULL,                        -- LiveAvatar avatar id
  mode               TEXT NOT NULL DEFAULT 'FULL',         -- FULL | LITE
  voice_id           TEXT,                                 -- optional voice override
  -- Brain
  system_prompt      TEXT,                                 -- per-tenant persona
  greeting           TEXT,                                 -- first thing it says
  chips              JSONB DEFAULT '[]'::jsonb,            -- suggested prompts
  knowledge          TEXT,                                 -- inline knowledge base
  slides             JSONB DEFAULT '[]'::jsonb,            -- [{id,title,url,triggers:[...]}] presentation slides
  -- Presentation
  theme              JSONB DEFAULT '{}'::jsonb,            -- logo_url, primary_color, headline, subcopy, og_image
  -- Lead routing
  lead_destination   JSONB DEFAULT '{}'::jsonb,            -- {type:email|webhook|supabase, config:{...}}
  -- Credentials (null => use the platform's shared LiveAvatar key, metered)
  liveavatar_key_enc TEXT,
  -- Commercial guardrails
  max_concurrent     INTEGER NOT NULL DEFAULT 3,           -- simultaneous live sessions
  monthly_minute_cap INTEGER,                              -- null => unlimited
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_avatar_agents_slug   ON avatar_agents(slug);
CREATE INDEX IF NOT EXISTS idx_avatar_agents_tenant ON avatar_agents(tenant_id);

CREATE TABLE IF NOT EXISTS avatar_sessions (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_slug           TEXT NOT NULL,
  tenant_id            UUID,
  liveavatar_session_id TEXT,
  ip                   TEXT,
  status               TEXT NOT NULL DEFAULT 'active',     -- pending | active | ended | reaped | cancelled
  started_at           TIMESTAMPTZ DEFAULT now(),
  ended_at             TIMESTAMPTZ,
  duration_seconds     INTEGER NOT NULL DEFAULT 0,
  last_heartbeat       TIMESTAMPTZ DEFAULT now(),
  created_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_avatar_sessions_slug    ON avatar_sessions(agent_slug);
CREATE INDEX IF NOT EXISTS idx_avatar_sessions_status  ON avatar_sessions(status);
CREATE INDEX IF NOT EXISTS idx_avatar_sessions_started ON avatar_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_avatar_sessions_ip      ON avatar_sessions(ip);

-- keep updated_at fresh (function defined in schema.sql; create defensively)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS avatar_agents_updated_at ON avatar_agents;
CREATE TRIGGER avatar_agents_updated_at
  BEFORE UPDATE ON avatar_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Seed: A-Gent's own agent + a public demo ────────────────────────────────
-- avatar_id + voice_id are verified-active LiveAvatar public avatars; swap for
-- a customer's trained avatar by updating these two fields.
INSERT INTO avatar_agents (slug, name, avatar_id, voice_id, mode, greeting, chips, system_prompt, theme, max_concurrent, monthly_minute_cap)
VALUES
(
  'a-gent',
  'A-Gent',
  '26393b8e-e944-4367-98ef-e2bc75c4b792',
  '864a26b8-bfba-4435-9cc5-1dd593de5ca7',
  'FULL',
  'Hey, great to meet you! I''m your A-Gent agent. I can answer questions, walk you through the platform, or show you our AI workforce. What brought you here today?',
  '["Give me an overview","Show me the AI workforce","How''s this different from a human SDR?","How much does it cost?","Book a demo"]'::jsonb,
  'You are the A-Gent Concierge — an autonomous AI sales agent on the A-Gent.co website. Confident, approachable, professional B2B SaaS. A-Gent deploys specialized AI workers (Researcher, SDR, Ops, Support, Success, Social) that detect buying signals and run outbound 24/7. Keep replies to 2-3 sentences and always move the conversation forward with a question. If asked pricing, say we are in early access with custom pricing for founding partners. Never invent features.',
  '{"primary_color":"#c9a227","headline":"Talk to a Live AI Agent","subcopy":"Ask anything you''d ask a human. I answer in real time — questions, a platform walkthrough, or a look at our AI workforce.","logo_url":"assets/agent-logo.svg"}'::jsonb,
  5,
  2000
),
(
  'demo',
  'A-Gent Demo',
  '65cca4cf-b7c8-4619-871f-84e2cf8b21d4',
  '864a26b8-bfba-4435-9cc5-1dd593de5ca7',
  'FULL',
  'Hi! I''m a live AI agent demo. Ask me anything and I''ll answer in real time.',
  '["What can you do?","How does this work?","Show me a use case","Book a demo"]'::jsonb,
  'You are a friendly live AI agent demo for A-Gent, showcasing real-time conversational avatars for sales and support. Keep answers short and engaging, and invite the visitor to imagine this on their own website.',
  '{"primary_color":"#c9a227","headline":"Meet a Live AI Agent","subcopy":"This is a real-time AI avatar you can talk to. Imagine it greeting every visitor on your site.","logo_url":"assets/agent-logo-master.svg"}'::jsonb,
  3,
  500
)
ON CONFLICT (slug) DO NOTHING;

-- ── Lock down (requires platform-schema.sql: auth_tenant_ids()) ──────────────
-- Public avatar pages read config via service-role functions (which bypass
-- RLS). Authenticated users manage only their tenant's agents; a super-admin
-- claim grants god-view across all tenants. Anon gets nothing.
CREATE OR REPLACE FUNCTION is_super_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin', false);
$$;

ALTER TABLE avatar_agents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE avatar_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS avatar_agents_rw ON avatar_agents;
CREATE POLICY avatar_agents_rw ON avatar_agents FOR ALL TO authenticated
  USING (is_super_admin() OR tenant_id IN (SELECT auth_tenant_ids()))
  WITH CHECK (is_super_admin() OR tenant_id IN (SELECT auth_tenant_ids()));

DROP POLICY IF EXISTS avatar_sessions_read ON avatar_sessions;
CREATE POLICY avatar_sessions_read ON avatar_sessions FOR SELECT TO authenticated
  USING (is_super_admin() OR tenant_id IN (SELECT auth_tenant_ids()));
