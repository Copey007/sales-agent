-- ============================================================================
-- A-Gent Platform Core — the shared multi-tenant backbone.
--
-- Every module (avatar, sdr, researcher, social, crm, concierge, copilot)
-- becomes a tenant-scoped consumer of these tables. Identity is Supabase Auth
-- (auth.users); isolation is Row-Level Security keyed by membership; service-
-- role functions bypass RLS to do trusted work.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Tenants (customers/accounts) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               TEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  plan               TEXT NOT NULL DEFAULT 'trial',     -- trial | starter | growth | enterprise
  status             TEXT NOT NULL DEFAULT 'active',    -- active | past_due | suspended | cancelled
  stripe_customer_id TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- ── Users ↔ tenants (with role) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',           -- owner | admin | member
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user   ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);

-- ── Billing ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  plan                   TEXT NOT NULL,
  status                 TEXT NOT NULL,                 -- trialing | active | past_due | canceled
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id);

-- ── Per-tenant per-module enablement + config + limits (entitlements) ────────
CREATE TABLE IF NOT EXISTS tenant_modules (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module     TEXT NOT NULL,                             -- avatar | sdr | researcher | social | crm | concierge | copilot
  enabled    BOOLEAN NOT NULL DEFAULT true,
  config     JSONB DEFAULT '{}'::jsonb,
  limits     JSONB DEFAULT '{}'::jsonb,                 -- e.g. {"monthly_minutes":2000,"max_concurrent":5}
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, module)
);
CREATE INDEX IF NOT EXISTS idx_tenant_modules_tenant ON tenant_modules(tenant_id);

-- ── Usage metering (billing basis, all modules) ─────────────────────────────
CREATE TABLE IF NOT EXISTS usage_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module      TEXT NOT NULL,
  metric      TEXT NOT NULL,                            -- avatar_seconds | emails_sent | lookups | llm_tokens
  quantity    NUMERIC NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ DEFAULT now(),
  metadata    JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_time   ON usage_events(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_metric ON usage_events(tenant_id, module, metric);

-- ── Encrypted per-tenant integration secrets (Hunter, Buffer, HubSpot, …) ────
CREATE TABLE IF NOT EXISTS tenant_secrets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,                             -- hunter | buffer | hubspot | heygen | liveavatar | stripe
  secret_enc TEXT NOT NULL,                             -- AES-256-GCM {iv,data,tag}
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

-- ── updated_at triggers ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_updated_at ON tenants;
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS subscriptions_updated_at ON subscriptions;
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS tenant_modules_updated_at ON tenant_modules;
CREATE TRIGGER tenant_modules_updated_at BEFORE UPDATE ON tenant_modules FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS tenant_secrets_updated_at ON tenant_secrets;
CREATE TRIGGER tenant_secrets_updated_at BEFORE UPDATE ON tenant_secrets FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Tenant ids the current authenticated user belongs to (SECURITY DEFINER so it
-- bypasses RLS on memberships and avoids recursion).
CREATE OR REPLACE FUNCTION auth_tenant_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM memberships WHERE user_id = auth.uid();
$$;

ALTER TABLE tenants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;  -- no policy => service-role only

-- Authenticated users may READ their own tenant's rows. Writes go through
-- service-role functions (which bypass RLS), so no write policies are granted
-- to authenticated/anon — that keeps the control plane trusted.
DROP POLICY IF EXISTS tenants_read ON tenants;
CREATE POLICY tenants_read ON tenants FOR SELECT TO authenticated
  USING (id IN (SELECT auth_tenant_ids()));

DROP POLICY IF EXISTS memberships_read ON memberships;
CREATE POLICY memberships_read ON memberships FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR tenant_id IN (SELECT auth_tenant_ids()));

DROP POLICY IF EXISTS subscriptions_read ON subscriptions;
CREATE POLICY subscriptions_read ON subscriptions FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT auth_tenant_ids()));

DROP POLICY IF EXISTS tenant_modules_read ON tenant_modules;
CREATE POLICY tenant_modules_read ON tenant_modules FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT auth_tenant_ids()));

DROP POLICY IF EXISTS usage_events_read ON usage_events;
CREATE POLICY usage_events_read ON usage_events FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT auth_tenant_ids()));

-- ── Link the existing avatar module to a tenant ─────────────────────────────
INSERT INTO tenants (slug, name, plan, status)
VALUES ('a-gent', 'A-Gent', 'enterprise', 'active')
ON CONFLICT (slug) DO NOTHING;

-- Point existing avatar agents at the A-Gent tenant, then enforce the FK.
UPDATE avatar_agents
   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'a-gent')
 WHERE tenant_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'avatar_agents_tenant_fk'
  ) THEN
    ALTER TABLE avatar_agents
      ADD CONSTRAINT avatar_agents_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Seed the avatar module entitlement for A-Gent.
INSERT INTO tenant_modules (tenant_id, module, enabled, limits)
SELECT id, 'avatar', true, '{"monthly_minutes":2000,"max_concurrent":5}'::jsonb
FROM tenants WHERE slug = 'a-gent'
ON CONFLICT (tenant_id, module) DO NOTHING;
