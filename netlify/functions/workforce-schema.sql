-- ============================================================================
-- Workforce hires — the persisted, per-tenant "I hired this worker" record.
-- A hired worker is its OWN entity (distinct from tenant_modules): a tenant can
-- hire several workers off the same template, each with its own goal/context and
-- lifecycle. Powers the Mission Control → A-Gent Workforce manage view.
-- Run this in the Supabase SQL editor (DDL). Requires platform-schema.sql
-- (tenants, auth_tenant_ids(), is_super_admin()).
-- ============================================================================

CREATE TABLE IF NOT EXISTS workforce_hires (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  worker_id      TEXT NOT NULL,                       -- template id: researcher|sdr|ops|social|support|success|manager
  name           TEXT NOT NULL,                       -- worker display name (e.g. "Sarah Chen")
  title          TEXT,                                -- role (e.g. "Sales Researcher")
  avatar         TEXT,                                -- emoji or image url
  goal           TEXT,                                -- the objective they were hired for
  context        TEXT,                                -- company/background context
  company        TEXT,
  status         TEXT NOT NULL DEFAULT 'active',      -- active | paused | archived
  last_activity  TEXT,                                -- human-readable last action
  last_active_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workforce_hires_tenant ON workforce_hires(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workforce_hires_status ON workforce_hires(status);

-- 30-day trial clock lives on the tenant (one clock per workspace).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- keep updated_at fresh (function defined in platform-schema.sql; create defensively)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workforce_hires_updated_at ON workforce_hires;
CREATE TRIGGER workforce_hires_updated_at
  BEFORE UPDATE ON workforce_hires
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── RLS: a tenant manages only its own hires; super-admin sees all ───────────
ALTER TABLE workforce_hires ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workforce_hires_rw ON workforce_hires;
CREATE POLICY workforce_hires_rw ON workforce_hires FOR ALL TO authenticated
  USING (is_super_admin() OR tenant_id IN (SELECT auth_tenant_ids()))
  WITH CHECK (is_super_admin() OR tenant_id IN (SELECT auth_tenant_ids()));
