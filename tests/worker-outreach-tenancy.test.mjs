// Multi-membership outreach queue: do not pick memberships rows[0].
// Fetch is mocked — no live API calls and no live sends.
import './helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, mockAuth, req, calls } from './helpers/env.mjs';

const wo = (await import('../netlify/functions/worker-outreach.mjs')).default;

const confirmed = '2026-01-01T00:00:00Z';
const USERS = { mark: { id: 'u-mark', email: 'mark@example.test', email_confirmed_at: confirmed } };
const MEMBERS = {
  'u-mark': [
    { role: 'owner', tenant_id: 't-agent', tenants: { id: 't-agent', slug: 'a-gent', name: 'A-Gent' } },
    { role: 'owner', tenant_id: 't-rgtm', tenants: { id: 't-rgtm', slug: 'refoundgtm', name: 'RefoundGTM' } },
  ],
};

function draft(over = {}) {
  return {
    id: 'd-r1', tenant_id: 't-rgtm', status: 'pending',
    worker_name: 'Labs', from_email: 'info@refoundgtm.com',
    prospect_email: 'a@x.test', prospect_name: 'A', prospect_company: 'X',
    subject: 'Hi', body: 'Hello',
    ...over,
  };
}

function mockTwoTenants(drafts) {
  mockAuth(USERS, MEMBERS);
  route('/rest/v1/worker_outreach', (u, init) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      const idm = /(?:^|[?&])id=eq\.([^&]+)/.exec(u);
      const d = drafts.find((x) => x.id === idm?.[1]);
      if (d) Object.assign(d, body);
      return { body: d ? [d] : [] };
    }
    const idm = /(?:^|[?&])id=eq\.([^&]+)/.exec(u);
    if (idm) return { body: drafts.filter((x) => x.id === idm[1]) };
    const eq = /tenant_id=eq\.([^&]+)/.exec(u);
    const inn = /tenant_id=in\.\(([^)]+)\)/.exec(u);
    const ids = eq ? [eq[1]] : inn ? inn[1].split(',') : [];
    const st = /status=eq\.([^&]+)/.exec(u)?.[1] || 'pending';
    return { body: drafts.filter((x) => ids.includes(x.tenant_id) && x.status === st) };
  });
}

function get(qs = '', headers = { Authorization: 'Bearer mark' }) {
  return wo(req(`https://aisdr.example.test/api/worker-outreach${qs}`, { headers }), {});
}

test('GET without a tenant slug returns pending drafts from every membership', async () => {
  resetFetch();
  const drafts = [draft(), draft({ id: 'd-agent', tenant_id: 't-agent', from_email: 'james@a-gent.co' })];
  mockTwoTenants(drafts);
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.drafts.length, 2);
  assert.deepEqual(new Set(body.drafts.map((d) => d.tenant_slug)), new Set(['a-gent', 'refoundgtm']));
  assert.equal(body.tenants.length, 2);
  assert.equal(body.drafts.find((d) => d.id === 'd-r1').tenant_name, 'RefoundGTM');
});

test('GET ?tenant=refoundgtm returns only that workspace, even if a-gent is first', async () => {
  resetFetch();
  mockTwoTenants([draft(), draft({ id: 'd-agent', tenant_id: 't-agent' })]);
  const res = await get('?tenant=refoundgtm');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.drafts.length, 1);
  assert.equal(body.drafts[0].id, 'd-r1');
  assert.equal(body.drafts[0].tenant_slug, 'refoundgtm');
});

test('GET ?tenant=a-gent hides the other workspace drafts', async () => {
  resetFetch();
  mockTwoTenants([draft()]);
  const res = await get('?tenant=a-gent');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).drafts, []);
});

test('GET ?tenant=not-a-member is 403', async () => {
  resetFetch();
  mockTwoTenants([draft()]);
  const res = await get('?tenant=otherco');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'not_a_member');
});

test('GET with X-Tenant-Slug matches the query-string filter', async () => {
  resetFetch();
  mockTwoTenants([draft()]);
  const res = await get('', { Authorization: 'Bearer mark', 'X-Tenant-Slug': 'refoundgtm' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).drafts[0].id, 'd-r1');
});

test('unauthenticated GET is 401', async () => {
  resetFetch();
  mockTwoTenants([draft()]);
  const res = await get('', {});
  assert.equal(res.status, 401);
});

test('approve of a second-membership draft succeeds (does not 404 on rows[0])', async () => {
  resetFetch();
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.COMPANY_POSTAL_ADDRESS = '1 Test Street, Testville';
  const d = draft();
  mockTwoTenants([d]);
  route('api.resend.com', () => ({ body: { id: 'resend-rgtm-1' } }));
  const res = await wo(req('https://aisdr.example.test/api/worker-outreach', {
    method: 'POST',
    headers: { Authorization: 'Bearer mark' },
    body: { id: 'd-r1', action: 'approve' },
  }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'sent');
  assert.equal(d.status, 'sent');
  assert.equal(calls.filter((c) => c.url.startsWith('https://api.resend.com')).length, 1);
});
