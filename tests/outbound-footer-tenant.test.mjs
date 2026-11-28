// Tenant-aware outbound CTA: A-Gent/AskArlen get the AskArlen line;
// RefoundGTM stealth is left untouched; unknown tenants get no brand CTA.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isHomeTenant, MASTER_TENANT_ID, homeTenantId } from '../netlify/functions/_tenant.mjs';
import {
  ensureFleetSignature,
  REFOUND_GTM_TENANT_ID,
  ASKARLEN_OUTBOUND_CTA,
} from '../netlify/functions/send-worker-background.mjs';

const AGENT = homeTenantId();
const UNKNOWN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STEALTH = 'If useful, I can walk you through the scope in 20 minutes.\n\nRefoundGTM Labs\nrefoundgtm.com';

test('constants and wording: AskArlen CTA, no design-partner language', () => {
  assert.equal(ASKARLEN_OUTBOUND_CTA, 'Get GTM done with AskArlen: https://askarlen.com');
  assert.equal(REFOUND_GTM_TENANT_ID, '293f61ad-0d46-460e-b0f2-e69c9462001a');
  assert.doesNotMatch(ASKARLEN_OUTBOUND_CTA, /design partner/i);
  assert.match(readFileSync(new URL('../netlify/functions/send-worker-background.mjs', import.meta.url), 'utf8'), /Get GTM done with AskArlen: https:\/\/askarlen\.com/);
});

test('A-Gent / master home tenants get the AskArlen CTA, not a-gent.co', () => {
  assert.equal(isHomeTenant(AGENT), true);
  assert.equal(isHomeTenant(MASTER_TENANT_ID), true);
  for (const tid of [AGENT, MASTER_TENANT_ID]) {
    const out = ensureFleetSignature('Hello, just checking in.', 'Mark', tid);
    assert.match(out, /Get GTM done with AskArlen: https:\/\/askarlen\.com/);
    assert.doesNotMatch(out, /Deploy your A-Gent Fleet/);
    assert.doesNotMatch(out, /https:\/\/a-gent\.co/);
    assert.doesNotMatch(out, /design partner/i);
  }
});

test('A-Gent body that already has the old footer is rewritten in place', () => {
  const prior = 'Hello.\n\nMark | A-Gent Fleet\nDeploy your A-Gent Fleet: https://a-gent.co';
  const out = ensureFleetSignature(prior, 'Mark', AGENT);
  assert.equal(out, 'Hello.\n\nMark | A-Gent Fleet\nGet GTM done with AskArlen: https://askarlen.com');
});

test('RefoundGTM stealth body is returned byte-identical; empty body stays empty', () => {
  assert.equal(ensureFleetSignature(STEALTH, 'Labs', REFOUND_GTM_TENANT_ID), STEALTH);
  assert.equal(ensureFleetSignature('', 'Labs', REFOUND_GTM_TENANT_ID), '');
  assert.doesNotMatch(ensureFleetSignature(STEALTH, 'Labs', REFOUND_GTM_TENANT_ID), /askarlen|a-gent\.co|A-Gent Fleet/i);
});

test('unknown tenants get the safe default: body unchanged, no brand CTA', () => {
  const body = 'A draft for some other customer.';
  assert.equal(ensureFleetSignature(body, 'Mark', UNKNOWN), body);
  assert.equal(ensureFleetSignature(body, 'Mark', ''), body);
  assert.equal(ensureFleetSignature(body, 'Mark', undefined), body);
});
