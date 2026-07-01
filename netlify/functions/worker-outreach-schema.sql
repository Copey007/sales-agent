-- ============================================================================
-- Worker outreach review queue. SDR workers draft personalized emails here as
-- 'pending'; a human approves in Mission Control and approval sends via Resend.
-- Run in the Supabase SQL editor. Requires platform-schema.sql (tenants,
-- auth_tenant_ids(), is_super_admin()).
-- ============================================================================

CREATE TABLE IF NOT EXISTS worker_outreach (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hire_id           UUID,
  worker_id         TEXT,
  worker_name       TEXT,
  from_email        TEXT,                                -- the worker's sending identity
  prospect_name     TEXT,
  prospect_email    TEXT,
  prospect_company  TEXT,
  subject           TEXT,
  body              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | rejected
  resend_id         TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  reviewed_at       TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_worker_outreach_tenant ON worker_outreach(tenant_id, status);

ALTER TABLE worker_outreach ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS worker_outreach_rw ON worker_outreach;
CREATE POLICY worker_outreach_rw ON worker_outreach FOR ALL TO authenticated
  USING (is_super_admin() OR tenant_id IN (SELECT auth_tenant_ids()))
  WITH CHECK (is_super_admin() OR tenant_id IN (SELECT auth_tenant_ids()));
