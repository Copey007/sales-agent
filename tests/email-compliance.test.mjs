// Commercial outbound must never reach Resend without a CAN-SPAM footer
// and List-Unsubscribe header. Tests mock fetch — no live API calls.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetFetch, route, mockAuth, req, calls } from './helpers/env.mjs';
import { complianceOrBlock } from '../netlify/functions/_email-compliance.mjs';

process.env.RESEND_API_KEY = 'test-resend-key';
process.env.COMPANY_POSTAL_ADDRESS = '1 Test Street, Testville';
process.env.UNSUBSCRIBE_EMAIL = 'unsubscribe@example.test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const resendCalls = () => calls.filter((c) => c.url.startsWith('https://api.resend.com'));

const confirmed = '2026-01-01T00:00:00Z';
const USERS = {
  member: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: confirmed },
};
const MEMBERS = {
  'u-mem': [{ role: 'owner', tenant_id: 't-acme', tenants: { id: 't-acme', slug: 'acme' } }],
};

const DRAFT = {
  id: 'd-1',
  tenant_id: 't-acme',
  status: 'pending',
  worker_name: 'James',
  from_email: 'james@a-gent.co',
  prospect_email: 'jane@prospect.test',
  prospect_name: 'Jane',
  prospect_company: 'Prospect Co',
  subject: 'Hello Jane',
  body: 'Hi Jane,\n\nQuick note.',
};

let draft;
function mockOutreach() {
  draft = { ...DRAFT };
  mockAuth(USERS, MEMBERS);
  route('/rest/v1/worker_outreach', (u, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'PATCH') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      Object.assign(draft, body);
      return { body: [draft] };
    }
    if (u.includes('id=eq.d-1')) return { body: [draft] };
    return { body: [] };
  });
  route('api.resend.com', () => ({ body: { id: 'resend-wo-1' } }));
}

const wo = (await import('../netlify/functions/worker-outreach.mjs')).default;
const approve = () => wo(req('https://aisdr.example.test/api/worker-outreach', {
  method: 'POST',
  headers: { Authorization: 'Bearer member' },
  body: { id: 'd-1', action: 'approve' },
}), {});

test('complianceOrBlock fails closed without COMPANY_POSTAL_ADDRESS', () => {
  const saved = process.env.COMPANY_POSTAL_ADDRESS;
  delete process.env.COMPANY_POSTAL_ADDRESS;
  try {
    const r = complianceOrBlock({ replyTo: 'james@a-gent.co' });
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.match(r.reason, /COMPANY_POSTAL_ADDRESS/);
  } finally { process.env.COMPANY_POSTAL_ADDRESS = saved; }
});

test('complianceOrBlock attaches postal footer, mailto, and RFC 8058 one-click headers', () => {
  const r = complianceOrBlock({ replyTo: 'james@a-gent.co', toEmail: 'jane@prospect.test', tenantId: 't-acme' });
  assert.equal(r.ok, true);
  assert.match(r.footer, /1 Test Street, Testville/);
  assert.match(r.footer, /unsubscribe@example.test/);
  assert.match(r.headers['List-Unsubscribe'], /^<mailto:unsubscribe@example\.test\?subject=unsubscribe>, <https:\/\/aisdr\.example\.test\/api\/unsubscribe\?token=/);
  assert.equal(r.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('worker-outreach approve without COMPANY_POSTAL_ADDRESS is blocked, draft stays pending', async () => {
  resetFetch();
  const saved = process.env.COMPANY_POSTAL_ADDRESS;
  delete process.env.COMPANY_POSTAL_ADDRESS;
  try {
    mockOutreach();
    const res = await approve();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.blocked, true);
    assert.match(body.error, /COMPANY_POSTAL_ADDRESS/);
    assert.equal(resendCalls().length, 0);
    assert.equal(draft.status, 'pending');
  } finally { process.env.COMPANY_POSTAL_ADDRESS = saved; }
});

test('worker-outreach approve sends approved text plus footer and List-Unsubscribe', async () => {
  resetFetch(); mockOutreach();
  const res = await approve();
  assert.equal(res.status, 200);
  const rc = resendCalls();
  assert.equal(rc.length, 1);
  const sent = JSON.parse(rc[0].body);
  assert.equal(sent.subject, 'Hello Jane');
  assert.ok(sent.text.startsWith('Hi Jane,\n\nQuick note.'));
  assert.match(sent.text, /1 Test Street, Testville/);
  assert.match(sent.text, /unsubscribe/i);
  assert.match(sent.headers['List-Unsubscribe'], /^<mailto:unsubscribe@example\.test\?subject=unsubscribe>, <https:\/\/aisdr\.example\.test\/api\/unsubscribe\?token=/);
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.deepEqual(sent.to, ['jane@prospect.test']);
  assert.equal(draft.status, 'sent');
});

test('worker-outreach approve without a login never reaches Resend', async () => {
  resetFetch(); mockOutreach();
  const res = await wo(req('https://aisdr.example.test/api/worker-outreach', {
    method: 'POST',
    body: { id: 'd-1', action: 'approve' },
  }), {});
  assert.equal(res.status, 401);
  assert.equal(resendCalls().length, 0);
  assert.equal(draft.status, 'pending');
});

// ── Source scan: no commercial send path can skip the helper ──────────────

const INTERNAL_NOTIFICATION = new Set([
  'netlify/functions/inbound-webhook.mjs',      // forwards a reply to the operator
  'netlify/functions/worker-daily-report.mjs',  // daily report to the workspace owner
  'netlify/functions/worker-runtime.mjs',       // manager health alert
]);
const DISABLED_BEFORE_SEND = new Set([
  'netlify/functions/_mcp-connectors.mjs',      // throw is before the fetch
]);
const MUST_USE_COMPLIANCE = new Set([
  'netlify/functions/send-worker-background.mjs',
  'netlify/functions/worker-outreach.mjs',
]);
const LEGACY_CLI = new Set([
  'integrations/email.js',                      // not imported by any Netlify function
]);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'tests') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(js|mjs|cjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

function isResendSendSite(src) {
  return /https:\/\/api\.resend\.com\/emails/.test(src) || /\.emails\.send\s*\(/.test(src);
}

test('every Resend send site is classified; commercial paths use complianceOrBlock', () => {
  const files = walk(ROOT);
  const sites = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).replaceAll('\\', '/');
    const src = readFileSync(abs, 'utf8');
    if (isResendSendSite(src)) sites.push({ rel, src });
  }
  const known = new Set([
    ...INTERNAL_NOTIFICATION,
    ...DISABLED_BEFORE_SEND,
    ...MUST_USE_COMPLIANCE,
    ...LEGACY_CLI,
    'netlify/functions/_email-compliance.mjs',
  ]);
  // The helper itself does not send; exclude it if it ever mentions the URL.
  const unexpected = sites.filter((s) => !known.has(s.rel) && s.rel !== 'netlify/functions/_email-compliance.mjs');
  assert.deepEqual(unexpected.map((s) => s.rel), [], 'new Resend send site must be classified in this test');

  for (const rel of MUST_USE_COMPLIANCE) {
    const site = sites.find((s) => s.rel === rel);
    assert.ok(site, `missing send site ${rel}`);
    assert.match(site.src, /complianceOrBlock\s*\(/, `${rel} must call complianceOrBlock before sending`);
    assert.match(site.src, /_email-compliance\.mjs/, `${rel} must import the compliance helper`);
  }

  const mcp = sites.find((s) => s.rel === 'netlify/functions/_mcp-connectors.mjs');
  assert.ok(mcp);
  const throwAt = mcp.src.indexOf("throw new Error('resend.send is disabled");
  const fetchAt = mcp.src.indexOf('https://api.resend.com/emails');
  assert.ok(throwAt !== -1 && throwAt < fetchAt, 'resend.send must throw before fetch');

  // Legacy CLI path is not wired into any Netlify function.
  for (const abs of files) {
    const rel = relative(ROOT, abs).replaceAll('\\', '/');
    if (!rel.startsWith('netlify/')) continue;
    const src = readFileSync(abs, 'utf8');
    assert.equal(/integrations\/email/.test(src), false, `${rel} must not import integrations/email.js`);
  }
});
