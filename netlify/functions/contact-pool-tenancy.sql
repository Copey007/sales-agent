-- Contact pool multi-tenancy migration — run once in the Supabase SQL editor.
-- Until this runs, the code detects the missing tenant_id column and keeps the
-- legacy single-pool behaviour (everything on the demo tenant).
--
-- 1. Add tenant_id; existing rows backfill to the demo tenant.
alter table contact_pool
  add column if not exists tenant_id uuid not null
  default '00000000-0000-0000-0000-000000000001';

-- 2. Dedup guarantee becomes per-tenant: unique (tenant_id, email) replaces
--    the old global unique (email).
alter table contact_pool drop constraint if exists contact_pool_email_key;
alter table contact_pool
  add constraint contact_pool_tenant_email_key unique (tenant_id, email);

-- 3. Fast tenant-scoped reads.
create index if not exists contact_pool_tenant_idx on contact_pool (tenant_id);
