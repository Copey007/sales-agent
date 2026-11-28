// After contact_pool tenancy, writes/Hunter stay home/master-only.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POOL_MASTER_TENANT_ID, poolWritableFor } from '../netlify/functions/_supabase-rest.mjs';
import { homeTenantId, STEALTH_TENANT_IDS } from '../netlify/functions/_tenant.mjs';

const OTHER = 'aaaaaaaa-0000-4000-8000-00000000000a';

test('poolWritableFor is true only for master and the operator home tenant', async () => {
  assert.equal(await poolWritableFor(POOL_MASTER_TENANT_ID), true);
  assert.equal(await poolWritableFor(homeTenantId()), true);
  assert.equal(await poolWritableFor(null), true); // defaults to master
  assert.equal(await poolWritableFor(OTHER), false);
  assert.equal(await poolWritableFor(STEALTH_TENANT_IDS[0]), false);
});
