// Week 2 avatar pilot: 26th billing window, 30s cool-down, seat release on
// FULL-without-voice, permanent-stop alert, caps status, side-panel allowlist.
// Fetch is fully mocked — no real HeyGen or LiveAvatar calls.
import './helpers/env.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetFetch, route, req, calls, SB, mockAuth } from './helpers/env.mjs';
import {
  getAvatarCaps,
  billingWindow,
  billingWindowStartIso,
  DEFAULT_MONTHLY_MINUTE_CAP,
  DEFAULT_MAX_SESSION_SECONDS,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_BILLING_RESET_DAY,
} from '../netlify/functions/_avatar-caps.mjs';
import { operatorEmailsFromEnv, STOP_FAIL_ALERT_AFTER, alertPermanentStopFailure } from '../netlify/functions/_avatar-stop-alert.mjs';
import { siteForUrl, allowedCrmLabels, allowedSitesSummary, hostMatches } from '../avatar-side-panel/allowed-sites.js';
import { stateCopy } from '../avatar-side-panel/copy.js';
import { GMAIL_DRAFT_INSERT_ENABLED, CRM_HOOK_ENABLED, PREVIEW_ADMIN_CREDITS } from '../avatar-side-panel/config.js';

process.env.LIVEAVATAR_API_KEY = 'test-liveavatar-key';

const token = (await import('../netlify/functions/avatar-token.mjs')).default;
const capsStatus = (await import('../netlify/functions/avatar-caps-status.mjs')).default;
const reaper = (await import('../netlify/functions/avatar-reaper.mjs')).default;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LA = 'https://api.liveavatar.com';
const DEMO_AGENT = {
  slug: 'demo',
  tenant_id: 't-1',
  status: 'active',
  mode: 'FULL',
  avatar_id: '65cca4cf-b7c8-4619-871f-84e2cf8b21d4',
  voice_id: '864a26b8-bfba-4435-9cc5-1dd593de5ca7',
  max_concurrent: 3,
  monthly_minute_cap: 500,
};

function heygenCalls() {
  return calls.filter((c) => /api\.liveavatar\.com|api\.heygen\.com/i.test(c.url));
}

const confirmed = '2026-01-01T00:00:00Z';
function authMember({ role = 'member', tenant = 't-1', token = 'mem' } = {}) {
  mockAuth(
    { [token]: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed } },
    { 'u-mem': [{ role, tenant_id: tenant, tenants: { id: tenant, slug: 'acme', name: 'Acme' } }] },
  );
}
const MEM = { Authorization: 'Bearer mem' };

const savedEnv = {};
function setEnv(name, value) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = String(value);
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
}
beforeEach(() => resetFetch());
afterEach(() => restoreEnv());

function routeAgent(agent = DEMO_AGENT) {
  route(`${SB}/rest/v1/avatar_agents`, () => ({ body: [agent] }));
}

function routeSessions({ usage = [], seats = [], reserved = { id: 'row-1', status: 'pending', created_at: new Date().toISOString(), started_at: new Date().toISOString() }, ended = [], patches } = {}) {
  const patchLog = patches || [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const method = init.method || 'GET';
    if (method === 'POST') return { body: [reserved] };
    if (method === 'PATCH') {
      const body = JSON.parse(init.body || '{}');
      patchLog.push({ url, body });
      return { body: [{ ...(reserved || { id: 'row-1' }), ...body }] };
    }
    if (url.includes('select=duration_seconds')) return { body: usage };
    if (url.includes('status=in.(ended,reaped)')) return { body: ended };
    if (url.includes('status=in.(active,pending)') && url.includes('select=id,status,created_at')) {
      return { body: reserved ? [reserved, ...seats] : seats };
    }
    if (url.includes('created_at=gte')) return { body: [] };
    return { body: [] };
  });
  return patchLog;
}

// ── billing window (resets on the 26th) ────────────────────────────────────

test('billing window starts on the 26th, not the 1st, and wraps the year', () => {
  const before = billingWindow(new Date('2026-11-25T23:59:59Z'), 26);
  assert.equal(before.start.toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(before.resetAt.toISOString(), '2026-11-26T00:00:00.000Z');
  const onDay = billingWindow(new Date('2026-11-26T00:00:00Z'), 26);
  assert.equal(onDay.start.toISOString(), '2026-11-26T00:00:00.000Z');
  assert.equal(onDay.resetAt.toISOString(), '2026-12-26T00:00:00.000Z');
  const jan = billingWindow(new Date('2027-01-01T12:00:00Z'), 26);
  assert.equal(jan.start.toISOString(), '2026-12-26T00:00:00.000Z');
  assert.equal(jan.resetAt.toISOString(), '2027-01-26T00:00:00.000Z');
  assert.equal(billingWindowStartIso(new Date('2026-11-25T12:00:00Z')), '2026-10-26T00:00:00Z');
  assert.equal(DEFAULT_BILLING_RESET_DAY, 26);
});

test('60-minute and 180-second defaults are unchanged, and cooldown defaults to 30s', () => {
  const caps = getAvatarCaps();
  assert.equal(caps.monthlyMinuteCap, DEFAULT_MONTHLY_MINUTE_CAP);
  assert.equal(caps.maxSessionSeconds, DEFAULT_MAX_SESSION_SECONDS);
  assert.equal(caps.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS);
  assert.equal(caps.billingResetDay, 26);
  assert.equal(DEFAULT_MONTHLY_MINUTE_CAP, 60);
  assert.equal(DEFAULT_MAX_SESSION_SECONDS, 180);
  assert.equal(DEFAULT_COOLDOWN_SECONDS, 30);
});

test('monthly usage query uses the 26th window start, not the 1st', async () => {
  routeAgent();
  const patches = routeSessions({ usage: [{ duration_seconds: 0 }] });
  route(`${LA}/v1/sessions/token`, () => ({ body: { data: { session_token: 'tok', session_id: 'la-1' } } }));
  await token(req('https://aisdr.example.test/api/avatar-token', { method: 'POST', body: { slug: 'demo' } }));
  const usageCall = calls.find((c) => c.url.includes('select=duration_seconds'));
  assert.ok(usageCall, 'expected a usage query');
  const start = billingWindowStartIso(new Date());
  assert.ok(usageCall.url.includes(`started_at=gte.${start}`), usageCall.url);
  assert.doesNotMatch(usageCall.url, /started_at=gte\.\d{4}-\d{2}-01T00:00:00Z/);
  void patches;
});

// ── cool-down ──────────────────────────────────────────────────────────────

test('token returns 429 cooldown and does not mint when a session ended 10s ago', async () => {
  routeAgent();
  routeSessions({
    ended: [{ ended_at: new Date(Date.now() - 10_000).toISOString() }],
  });
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.9' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'cooldown');
  assert.ok(body.retry_after >= 19 && body.retry_after <= 30, body.retry_after);
  assert.equal(body.cooldown_seconds, 30);
  assert.equal(heygenCalls().length, 0);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('avatar_sessions')).length, 0);
});

test('token mints after the cool-down has elapsed', async () => {
  routeAgent();
  routeSessions({
    ended: [{ ended_at: new Date(Date.now() - 45_000).toISOString() }],
  });
  route(`${LA}/v1/sessions/token`, () => ({ body: { data: { session_token: 'tok', session_id: 'la-1' } } }));
  const res = await token(req('https://aisdr.example.test/api/avatar-token', {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.9' },
    body: { slug: 'demo' },
  }));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(heygenCalls().filter((c) => c.url.includes('/v1/sessions/token')).length, 1);
});

// ── seat release ───────────────────────────────────────────────────────────

test('FULL without voice_id does not reserve a seat and does not mint', async () => {
  const agent = { ...DEMO_AGENT, voice_id: null };
  routeAgent(agent);
  const patches = routeSessions();
  const res = await token(req('https://aisdr.example.test/api/avatar-token', { method: 'POST', body: { slug: 'demo' } }));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'agent_misconfigured');
  assert.equal(heygenCalls().length, 0);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('avatar_sessions')).length, 0);
  assert.equal(patches.length, 0);
});

// ── permanent stop alert ───────────────────────────────────────────────────

test('operatorEmailsFromEnv is empty when OPERATOR_EMAILS is unset and never invents an address', () => {
  assert.deepEqual(operatorEmailsFromEnv({}), []);
  assert.deepEqual(operatorEmailsFromEnv({ OPERATOR_EMAILS: '' }), []);
  assert.deepEqual(operatorEmailsFromEnv({ OPERATOR_EMAILS: 'ops@example.com, other@example.com' }), ['ops@example.com', 'other@example.com']);
});

test('permanent-stop alert logs only when OPERATOR_EMAILS is unset', async () => {
  const emails = [];
  const result = await alertPermanentStopFailure({
    session: { id: 'row-x', liveavatar_session_id: 'la-x' },
    error: 'LiveAvatar stop failed: 500',
    failCount: STOP_FAIL_ALERT_AFTER,
    env: { OPERATOR_EMAILS: '' },
    fetchImpl: async () => { emails.push('called'); return new Response('{}', { status: 200 }); },
  });
  assert.equal(result.emailed, false);
  assert.equal(result.reason, 'operator_emails_unset');
  assert.equal(emails.length, 0);
});

test('reaper leaves a row open after a failed stop, increments fail count, and alerts after the threshold without inventing an address', async () => {
  setEnv('OPERATOR_EMAILS', '');
  const patches = [];
  route(`${SB}/rest/v1/avatar_sessions`, (url, init) => {
    const method = init.method || 'GET';
    if (method === 'PATCH') {
      patches.push(JSON.parse(init.body || '{}'));
      return { body: [{ id: 'r1', ...JSON.parse(init.body || '{}') }] };
    }
    return {
      body: [{
        id: 'r1',
        liveavatar_session_id: 'la-bad',
        started_at: '2020-01-01T00:00:00Z',
        last_heartbeat: '2020-01-01T00:00:00Z',
        duration_seconds: 5,
        status: 'active',
        stop_fail_count: STOP_FAIL_ALERT_AFTER - 1,
        stop_alerted_at: null,
      }],
    };
  });
  route(`${LA}/v1/sessions/stop`, () => ({ status: 500, body: { error: 'nope' } }));
  const res = await reaper(req('https://aisdr.example.test/.netlify/functions/avatar-reaper', { method: 'POST' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reaped, 0);
  assert.equal(body.skipped, 1);
  assert.ok(patches.some((p) => p.stop_fail_count === STOP_FAIL_ALERT_AFTER));
  assert.ok(patches.some((p) => p.stop_alerted_at));
  assert.equal(calls.filter((c) => c.url.includes('api.resend.com')).length, 0);
});

// ── caps status (no mint) ──────────────────────────────────────────────────

test('GET /api/avatar-caps returns usage and reset_at and never calls LiveAvatar', async () => {
  authMember({ role: 'member' });
  routeAgent();
  routeSessions({ usage: [{ duration_seconds: 120 }] });
  const res = await capsStatus(req('https://aisdr.example.test/api/avatar-caps?slug=demo', { method: 'GET', headers: MEM }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.monthly_minute_cap, Math.min(60, 500));
  assert.ok(body.reset_at);
  assert.equal(new Date(body.reset_at).toISOString().slice(8, 10), '26');
  assert.equal(body.cooldown_seconds, 30);
  assert.equal(heygenCalls().length, 0);
});

test('GET /api/avatar-caps is fail-closed when the store is down; POST is 405 with no LiveAvatar call', async () => {
  authMember({ role: 'member' });
  route(`${SB}/rest/v1/avatar_agents`, () => ({ status: 500, body: { error: 'down' } }));
  const res = await capsStatus(req('https://aisdr.example.test/api/avatar-caps?slug=demo', { method: 'GET', headers: MEM }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'usage_store_unavailable');
  resetFetch();
  const post = await capsStatus(req('https://aisdr.example.test/api/avatar-caps', { method: 'POST', body: { slug: 'demo' } }));
  assert.equal(post.status, 405);
  assert.equal(heygenCalls().length, 0);
});

// ── side panel allowlist, copy, permissions ────────────────────────────────

test('panel is allowed on Gmail, A-Gent CRM, HubSpot, and Salesforce, and blocked elsewhere', () => {
  assert.equal(siteForUrl('https://mail.google.com/mail/u/0/#inbox').site.id, 'gmail');
  assert.equal(siteForUrl('https://crm.a-gent.co/contacts/1').site.id, 'agent-crm');
  assert.equal(siteForUrl('https://app.hubspot.com/contacts/123/record/0-1/456').site.id, 'hubspot');
  assert.equal(siteForUrl('https://app-eu1.hubspot.com/').site.id, 'hubspot');
  assert.equal(siteForUrl('https://na139.lightning.force.com/lightning/r/Contact/001/view').site.id, 'salesforce');
  assert.equal(siteForUrl('https://acme.my.salesforce.com/001').site.id, 'salesforce');
  assert.equal(siteForUrl('https://example.com/').allowed, false);
  assert.equal(siteForUrl('https://www.hubspot.com/').allowed, false);
  assert.equal(siteForUrl('https://help.salesforce.com/').allowed, false);
  assert.equal(siteForUrl('https://a-gent.co/').allowed, false);
  assert.equal(siteForUrl('https://acme.lightning.crmforce.mil/lightning/r/Contact/001/view').allowed, false);
  assert.ok(hostMatches('foo.lightning.force.com', '*.lightning.force.com'));
  assert.equal(hostMatches('lightning.force.com', '*.lightning.force.com'), false);
  const crms = allowedCrmLabels();
  assert.deepEqual(crms, ['A-Gent CRM', 'HubSpot', 'Salesforce']);
  assert.match(allowedSitesSummary(), /Gmail/);
  assert.match(allowedSitesSummary(), /HubSpot/);
  assert.match(allowedSitesSummary(), /Salesforce/);
});

test('Buy more credits is admin-only, uses TBD chips, and has no prices or billing link', () => {
  const buy = stateCopy('choose-credits', { isAdmin: true });
  assert.equal(buy.title, 'Choose credits');
  assert.doesNotMatch(JSON.stringify(buy), /\$/);
  assert.match(buy.action, /preview/i);
  assert.doesNotMatch(JSON.stringify(buy), /https?:\/\//);
  assert.ok(buy.packs.every((p) => /Pack /.test(p.name)));
  const capAdmin = stateCopy('monthly-cap', { isAdmin: true });
  assert.equal(capAdmin.buyMore, true);
  assert.equal(capAdmin.contactAdmin, true);
  assert.equal(capAdmin.action, 'Buy more credits');
  assert.equal(capAdmin.secondaryAction, 'Contact your A-Gent admin');
  assert.ok(capAdmin.chips.some((c) => c.label.includes('TBD')));
  assert.doesNotMatch(JSON.stringify(capAdmin), /\b60\b/);
  const capMember = stateCopy('monthly-cap', { isAdmin: false });
  assert.equal(capMember.buyMore, false);
  assert.equal(capMember.action, 'Contact your A-Gent admin');
  assert.match(capMember.title, /Only admins/);
  const timeoutMember = stateCopy('session-timeout', { isAdmin: false });
  assert.equal(timeoutMember.buyMore, false);
  assert.equal(timeoutMember.action, 'Start new session');
  assert.equal(timeoutMember.secondaryAction, 'Contact your A-Gent admin');
  const timeoutAdmin = stateCopy('session-timeout', { isAdmin: true });
  assert.equal(timeoutAdmin.buyMore, true);
  assert.equal(timeoutAdmin.secondaryAction, 'Buy more credits');
  assert.match(stateCopy('checkout-wait').action, /preview/i);
  const contact = stateCopy('contact-admin');
  assert.doesNotMatch(contact.message, /@/);
  assert.doesNotMatch(contact.message, /mailto:/);
});

test('extension manifest permissions stay minimal, CRM hooks stay off, and there is no send path', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'avatar-side-panel/manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['sidePanel', 'tabs'].sort());
  assert.deepEqual(manifest.host_permissions.sort(), [
    'https://aisdr.a-gent.co/*',
    'https://api.liveavatar.com/*',
    'https://mail.google.com/*',
  ].sort());
  assert.ok(!manifest.host_permissions.some((h) => /esm\.sh/i.test(h)));
  assert.ok(!manifest.host_permissions.some((h) => /googleapis|gmail\.googleapis/i.test(h)));
  assert.ok(manifest.side_panel.default_path);
  assert.equal(GMAIL_DRAFT_INSERT_ENABLED, true);
  assert.equal(CRM_HOOK_ENABLED, false);
  assert.equal(PREVIEW_ADMIN_CREDITS, false);
  const js = readFileSync(join(ROOT, 'avatar-side-panel/sidepanel.js'), 'utf8')
    + readFileSync(join(ROOT, 'avatar-side-panel/background.js'), 'utf8');
  assert.doesNotMatch(js, /gmail\.send/i);
  assert.doesNotMatch(js, /chrome\.storage/);
  assert.match(js, /In-memory only/);
  assert.doesNotMatch(js, /chrome\.storage\.local/);
  assert.match(js, /aria-label="Ask"/);
  assert.match(js, /Type to A-Gent/);
  const html = readFileSync(join(ROOT, 'avatar-side-panel/sidepanel.html'), 'utf8');
  assert.doesNotMatch(html, />\s*Send\s*</);
  assert.doesNotMatch(js, /["']Send["']/);
});

test('extension.zip is unchanged and the new panel lives in its own directory', () => {
  const zipPath = join(ROOT, 'extension.zip');
  assert.equal(existsSync(zipPath), true);
  const head = execFileSync('git', ['show', 'HEAD:extension.zip'], { cwd: ROOT });
  const work = readFileSync(zipPath);
  assert.equal(createHash('sha256').update(work).digest('hex'), createHash('sha256').update(head).digest('hex'));
  assert.equal(existsSync(join(ROOT, 'avatar-side-panel/manifest.json')), true);
  assert.equal(existsSync(join(ROOT, 'avatar-side-panel/sidepanel.html')), true);
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  assert.doesNotMatch(toml, /\/api\/avatar-session[^\-]/);
});
