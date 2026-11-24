import { createHmac } from 'node:crypto';
const F = new URL('../netlify/functions', import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

process.env.INTERNAL_API_TOKEN = 'test-internal-token';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.OPERATOR_EMAILS = 'mark@a-gent.co';

const auth = await import(`${F}/_auth.mjs`);
const mk = (headers = {}, method = 'POST', url = 'https://aisdr.a-gent.co/api/x') => new Request(url, { method, headers });

// CORS
ok(auth.corsHeaders(mk({ origin: 'https://missioncontrol.a-gent.co' }))['Access-Control-Allow-Origin'] === 'https://missioncontrol.a-gent.co', 'CORS echoes allowlisted origin');
ok(!('Access-Control-Allow-Origin' in auth.corsHeaders(mk({ origin: 'https://evil.example' }))), 'CORS omits ACAO for foreign origin');

// requireAuth
ok((await auth.requireAuth(mk())).status === 401, 'no token → 401');
ok((await auth.requireAuth(mk({ 'x-internal-token': 'test-internal-token' }))) === null, 'internal token → allowed');
ok((await auth.requireAuth(mk({ 'x-internal-token': 'wrong' }))).status === 401, 'wrong internal token → 401');

// verifyUser with mocked Supabase /auth/v1/user
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  if (String(u).endsWith('/auth/v1/user')) {
    const tok = init.headers.Authorization.split(' ')[1];
    if (tok === 'good') return new Response(JSON.stringify({ id: 'u1', email: 'mark@a-gent.co' }), { status: 200 });
    if (tok === 'other') return new Response(JSON.stringify({ id: 'u2', email: 'someone@gmail.com' }), { status: 200 });
    return new Response('{}', { status: 401 });
  }
  return realFetch(u, init);
};
ok((await auth.requireAuth(mk({ authorization: 'Bearer good' }))) === null, 'operator JWT → allowed');
ok((await auth.requireAuth(mk({ authorization: 'Bearer other' }))).status === 403, 'non-operator JWT → 403');
ok((await auth.requireAuth(mk({ authorization: 'Bearer bad' }))).status === 401, 'invalid JWT → 401');

// Handlers deny unauthenticated callers before doing any work
const sw = (await import(`${F}/send-worker.mjs`)).default;
let r = await sw(new Request('https://aisdr.a-gent.co/api/send-worker', { method: 'POST', body: JSON.stringify({ campaign_id: 'x', send_ids: ['a'] }) }));
ok(r.status === 403, 'send-worker without X-Internal-Token → 403');

const wf = (await import(`${F}/workforce.mjs`)).default;
r = await wf(new Request('https://aisdr.a-gent.co/api/workforce', { method: 'POST', body: JSON.stringify({ action: 'execute', agent: 'sdr', objective: 'x', context: { toEmail: 'victim@example.com' } }) }));
ok(r.status === 401, 'workforce execute without JWT → 401');
r = await wf(new Request('https://aisdr.a-gent.co/api/workforce', { method: 'GET' }));
ok(r.status === 401, 'workforce GET list without JWT → 401');

for (const [name, path, method] of [
  ['campaign-orchestrator', '/api/campaign-orchestrator?action=status', 'GET'],
  ['campaign-admin', '/api/campaign-admin?action=trigger_queue', 'GET'],
  ['enqueue-send', '/api/enqueue-send', 'POST'],
  ['gap-email-pipeline', '/api/gap-email-pipeline', 'POST'],
  ['generate-gap-email', '/api/generate-gap-email', 'POST'],
  ['gather-signals', '/api/gather-signals', 'POST'],
]) {
  const h = (await import(`${F}/${name}.mjs`)).default;
  const res = await h(new Request('https://aisdr.a-gent.co' + path, { method, body: method === 'POST' ? '{}' : undefined }));
  ok(res.status === 401, `${name} without JWT → 401`);
}
// Preflight from foreign origin gets no ACAO
const pre = await wf(new Request('https://aisdr.a-gent.co/api/workforce', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
ok(pre.status === 204 && !pre.headers.get('access-control-allow-origin'), 'preflight from foreign origin → no ACAO');

// Setup-schema: literal "setup" no longer accepted
delete process.env.QUEUE_MANAGER_SECRET;
const setup = (await import(`${F}/_setup-schema.mjs`)).default;
r = await setup(new Request('https://aisdr.a-gent.co/api/setup-schema', { method: 'POST', body: JSON.stringify({ secret: 'setup' }) }));
ok(r.status === 503, 'setup-schema with secret "setup" and no env secret → 503 (was: accepted)');

// Svix vector from docs.svix.com manual-verification page
const secret = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
const sig = createHmac('sha256', Buffer.from(secret.split('_')[1], 'base64'))
  .update(`msg_loFOjxBNrRLzqYUf.1731705121.{"event_type":"ping","data":{"success":true}}`).digest('base64');
ok(sig === 'rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=', 'Svix HMAC matches documented test vector');

// inbound-webhook end-to-end with a freshly signed payload
process.env.RESEND_WEBHOOK_SECRET = secret;
const iw = (await import(`${F}/inbound-webhook.mjs`)).default;
r = await iw(new Request('https://aisdr.a-gent.co/api/inbound-webhook', { method: 'POST', body: '{"type":"email.received","data":{}}' }));
ok(r.status === 401, 'inbound-webhook unsigned → 401');
const ts = String(Math.floor(Date.now() / 1000));
const body = '{"type":"email.received","data":{"from":"a@b.co"}}';
const good = createHmac('sha256', Buffer.from(secret.split('_')[1], 'base64')).update(`msg_1.${ts}.${body}`).digest('base64');
globalThis.fetch = async () => new Response('{}', { status: 200 });
r = await iw(new Request('https://aisdr.a-gent.co/api/inbound-webhook', { method: 'POST', body, headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${good}` } }));
ok(r.status !== 401, `inbound-webhook correctly signed → passes verification (status ${r.status})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
