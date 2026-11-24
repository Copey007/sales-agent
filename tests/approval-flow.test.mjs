import { getStore } from '@netlify/blobs';
const F = new URL('../netlify/functions/', import.meta.url).href;
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
Object.assign(process.env, {
  INTERNAL_API_TOKEN: 'tok', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon',
  OPERATOR_EMAILS: 'mark@a-gent.co', RESEND_API_KEY: 're_test', OPENAI_API_KEY: 'sk_test',
  SENDER_FROM_EMAIL: 'mark@a-gent.co', SENDER_FROM_NAME: 'Mark Cope', REPLY_TO_EMAIL: 'mark@a-gent.co',
  COMPANY_POSTAL_ADDRESS: '123 Test St, Testville, NY 10001', URL: 'https://aisdr.a-gent.co', MAX_DAILY_SEND_LIMIT: '50'
});
const store = await import(F + '_campaign-store.mjs');
const qm = (await import(F + 'queue-manager.mjs')).default;
const sw = (await import(F + 'send-worker.mjs')).default;
const admin = (await import(F + 'campaign-admin.mjs')).default;
const T = store.DEFAULTS.TENANT_ID;
const old = new Date(Date.now() - 30 * 864e5).toISOString();
await store.setFeatureFlag('multi_campaign_orchestration', true);
await store.setFeatureFlag('queue_manager_active', true);
await store.putCampaign({ id: 'c1', tenant_id: T, name: 'Test', status: 'active', daily_send_limit: 25, created_at: old });
await store.putProspect({ id: 'p1', tenant_id: T, email: 'jane@acme.test', contact_name: 'Jane', company_name: 'Acme' });
await store.putProspect({ id: 'p2', tenant_id: T, email: 'sup@acme.test', contact_name: 'Sup', company_name: 'Acme' });
await store.putEmailSend({ id: 's1', campaign_id: 'c1', prospect_id: 'p1', step_number: 1, status: 'queued', scheduled_at: old });
await store.putEmailSend({ id: 's2', campaign_id: 'c1', prospect_id: 'p2', step_number: 1, status: 'suppressed', scheduled_at: old });

const resendCalls = [];
globalThis.fetch = async (u, init = {}) => {
  u = String(u);
  if (u.endsWith('/api/send-worker')) return sw(new Request(u, { method: 'POST', headers: init.headers, body: init.body }));
  if (u.includes('api.resend.com')) { resendCalls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }
  if (u.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: '{"subject":"Quick idea","body":"Hi Jane, short note.","signals_used":[]}' } }] }), { status: 200 });
  if (u.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'mark@a-gent.co' }), { status: 200 });
  return new Response('[]', { status: 200 });
};

// Run 1: queue-manager → send-worker drafts only
await qm(new Request('https://x/.netlify/functions/queue-manager', { method: 'POST' }));
let s1 = await store.getEmailSend('s1');
ok(s1.status === 'pending_approval', `run 1: send becomes pending_approval (got ${s1.status})`);
ok(s1.email_subject === 'Quick idea', 'run 1: draft subject stored');
ok(resendCalls.length === 0, 'run 1: NO email delivered before approval');

// Direct attempt to force-send the suppressed record with a valid internal token
let r = await sw(new Request('https://x/api/send-worker', { method: 'POST', headers: { 'x-internal-token': 'tok' }, body: JSON.stringify({ campaign_id: 'c1', send_ids: ['s2', 's1'] }) }));
ok(resendCalls.length === 0, 'direct send-worker call cannot deliver suppressed / pending sends');

// List + approve as operator
r = await admin(new Request('https://x/api/campaign-admin?action=list_pending&campaign_id=c1', { headers: { authorization: 'Bearer good' } }));
const lp = await r.json();
ok(lp.count === 1 && lp.pending[0].to === 'jane@acme.test', 'list_pending shows the draft with recipient');
r = await admin(new Request('https://x/api/campaign-admin?action=approve_sends', { method: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify({ send_ids: ['s1'], edits: { s1: { body: 'Hi Jane — edited by Mark.' } } }) }));
const ap = await r.json();
ok(ap.count === 1, 'approve_sends approved 1');
s1 = await store.getEmailSend('s1');
ok(s1.status === 'queued' && s1.approved_by === 'mark@a-gent.co', 'approved send re-queued with approver recorded');

// Run 2: delivers exactly the approved content
await qm(new Request('https://x/.netlify/functions/queue-manager', { method: 'POST' }));
s1 = await store.getEmailSend('s1');
ok(resendCalls.length === 1, `run 2: exactly one email delivered (got ${resendCalls.length})`);
ok(resendCalls[0]?.text.startsWith('Hi Jane — edited by Mark.'), 'run 2: delivered the operator-edited body');
ok(resendCalls[0]?.text.includes('123 Test St') && resendCalls[0]?.headers?.['List-Unsubscribe'], 'run 2: compliance footer + List-Unsubscribe present');
ok(resendCalls[0]?.from === 'Mark Cope <mark@a-gent.co>', 'run 2: sender identity from env');
ok(s1.status === 'sent', `run 2: status sent (got ${s1.status})`);

// Run 3: nothing re-sent
await qm(new Request('https://x/.netlify/functions/queue-manager', { method: 'POST' }));
ok(resendCalls.length === 1, 'run 3: no duplicate delivery');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
