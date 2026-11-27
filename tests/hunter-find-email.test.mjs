// Fail-closed JWT-gated per-lead Hunter.io email finder.
import './helpers/env.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetFetch, route, mockAuth, req, calls } from './helpers/env.mjs';

const USERS = {
  member: { id: 'u-mem', email: 'cust@acme.test', email_confirmed_at: '2026-01-01T00:00:00Z' },
  orphan: { id: 'u-orphan', email: 'nobody@bv.test', email_confirmed_at: '2026-01-01T00:00:00Z' },
};
const MEMBERS = { 'u-mem': [{ role: 'owner', tenant_id: 't-acme', tenants: { id: 't-acme', slug: 'acme', name: 'Acme' } }] };
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const URL = 'https://aisdr.example.test/api/hunter-find-email';
const KEY = 'test-hunter-key-DO-NOT-LEAK-abc123';
const UPSTREAM_SECRET = 'hunter-raw-error-body-SECRET-should-never-leak';

const VALID = { domain: 'acme.com', first_name: 'Jane', last_name: 'Doe' };

function setup({ hunterKey = KEY } = {}) {
  resetFetch();
  mockAuth(USERS, MEMBERS);
  if (hunterKey == null) delete process.env.HUNTER_API_KEY;
  else process.env.HUNTER_API_KEY = hunterKey;
}

const logs = [];
const origError = console.error;
function captureLogs() {
  logs.length = 0;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
}
function restoreLogs() { console.error = origError; }
function leaked(haystacks, ...needles) {
  const text = haystacks.map((h) => typeof h === 'string' ? h : JSON.stringify(h)).join('\n');
  return needles.filter((n) => n && text.includes(n));
}

async function invoke() {
  return import('../netlify/functions/hunter-find-email.mjs');
}

async function asMember(mod, body, extraHeaders = {}) {
  return mod.default(req(URL, { method: 'POST', headers: { ...bearer('member'), ...extraHeaders }, body }), {});
}

async function read(res) {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

beforeEach(() => { captureLogs(); });
afterEach(() => { restoreLogs(); delete process.env.HUNTER_API_KEY; });

test('unauthenticated request → 401 and never calls Hunter', async () => {
  setup();
  const mod = await invoke();
  const res = await read(await mod.default(req(URL, { method: 'POST', body: VALID }), {}));
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'unauthorized');
  assert.equal(calls.filter((c) => c.url.includes('api.hunter.io')).length, 0);
  assert.deepEqual(leaked([res.text, ...logs], KEY), []);
});

test('authenticated non-member → 403 and never calls Hunter', async () => {
  setup();
  const mod = await invoke();
  const res = await read(await mod.default(req(URL, { method: 'POST', headers: bearer('orphan'), body: VALID }), {}));
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'forbidden');
  assert.equal(calls.filter((c) => c.url.includes('api.hunter.io')).length, 0);
  assert.deepEqual(leaked([res.text, ...logs], KEY), []);
});

test('missing HUNTER_API_KEY → 503 fail-closed (ignores client-supplied key)', async () => {
  setup({ hunterKey: null });
  const mod = await invoke();
  const res = await read(await asMember(mod, { ...VALID, api_key: KEY, hunter_api_key: KEY, HUNTER_API_KEY: KEY }));
  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'hunter_not_configured');
  assert.equal(calls.filter((c) => c.url.includes('api.hunter.io')).length, 0);
  assert.deepEqual(leaked([res.text, ...logs], KEY), []);
});

test('invalid input → 400 (missing domain, missing name, bad JSON, empty names)', async () => {
  setup();
  const mod = await invoke();
  const cases = [
    { body: { first_name: 'Jane', last_name: 'Doe' } },
    { body: { domain: '', first_name: 'Jane', last_name: 'Doe' } },
    { body: { domain: 'not a domain', first_name: 'Jane', last_name: 'Doe' } },
    { body: { domain: 'acme.com' } },
    { body: { domain: 'acme.com', first_name: 'Jane' } },
    { body: { domain: 'acme.com', full_name: 'Jane' } },
    { body: { domain: 'acme.com', first_name: '   ', last_name: 'Doe' } },
    { raw: 'not-json' },
  ];
  for (const c of cases) {
    const request = c.raw
      ? req(URL, { method: 'POST', headers: { ...bearer('member'), 'Content-Type': 'application/json' }, body: c.raw })
      : req(URL, { method: 'POST', headers: bearer('member'), body: c.body });
    const res = await read(await mod.default(request, {}));
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(c)}`);
    assert.equal(res.json.error, 'invalid_input');
  }
  assert.equal(calls.filter((c) => c.url.includes('api.hunter.io')).length, 0);
});

test('mocked Hunter success returns normalized non-secret JSON', async () => {
  setup();
  route('api.hunter.io/v2/email-finder', (url, init, headers) => {
    assert.match(url, /domain=acme\.com/);
    assert.match(url, /first_name=Jane/);
    assert.match(url, /last_name=Doe/);
    assert.equal(url.includes('api_key'), false, 'API key must not be in the URL');
    assert.equal(url.includes(KEY), false);
    assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
    return {
      body: {
        data: {
          first_name: 'Jane',
          last_name: 'Doe',
          email: 'jane.doe@acme.com',
          score: 92,
          domain: 'acme.com',
          position: 'CEO',
          sources: [{ domain: 'linkedin.com' }, { domain: 'about.me' }],
          verification: { status: 'valid' },
        },
        errors: [{ details: UPSTREAM_SECRET }],
      },
    };
  });
  const mod = await invoke();
  const res = await read(await asMember(mod, {
    domain: 'https://www.acme.com/team',
    full_name: 'Jane Doe',
    api_key: 'client-supplied-key-SHOULD-NOT-BE-USED',
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    email: 'jane.doe@acme.com',
    score: 92,
    status: 'valid',
    domain: 'acme.com',
    first_name: 'Jane',
    last_name: 'Doe',
    position: 'CEO',
    sources_count: 2,
  });
  assert.equal(calls.filter((c) => c.url.includes('api.hunter.io')).length, 1);
  assert.equal(calls[calls.length - 1].headers.get('authorization')?.includes('client-supplied-key'), false);
  assert.deepEqual(leaked([res.text, ...logs], KEY, 'client-supplied-key-SHOULD-NOT-BE-USED', UPSTREAM_SECRET), []);
});

test('mocked Hunter not-found returns 200 with email null and status not_found', async () => {
  setup();
  route('api.hunter.io/v2/email-finder', () => ({
    body: { data: { first_name: 'Jane', last_name: 'Doe', email: null, score: null, domain: 'acme.com', sources: [] } },
  }));
  const mod = await invoke();
  const res = await read(await asMember(mod, VALID));
  assert.equal(res.status, 200);
  assert.equal(res.json.email, null);
  assert.equal(res.json.status, 'not_found');
  assert.equal(res.json.domain, 'acme.com');
  assert.equal(res.json.first_name, 'Jane');
  assert.equal(res.json.last_name, 'Doe');
  assert.equal(res.json.position, null);
  assert.equal(res.json.sources_count, 0);
  assert.deepEqual(leaked([res.text, ...logs], KEY), []);
});

test('mocked Hunter upstream error → 502 with zero secret leakage', async () => {
  setup();
  route('api.hunter.io/v2/email-finder', () => ({
    status: 401,
    body: { errors: [{ id: 'invalid_api_key', details: UPSTREAM_SECRET, meta: { api_key: KEY } }] },
  }));
  const mod = await invoke();
  const res = await read(await asMember(mod, VALID));
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, { error: 'hunter_upstream_error' });
  assert.deepEqual(leaked([res.text, ...logs], KEY, UPSTREAM_SECRET, 'invalid_api_key'), []);
  assert.match(logs.join('\n'), /upstream status 401/);
});

test('function is registered at /api/hunter-find-email', async () => {
  const mod = await invoke();
  assert.equal(mod.config.path, '/api/hunter-find-email');
});
