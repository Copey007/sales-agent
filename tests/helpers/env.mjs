// Shared test environment: fake config + a programmable fetch mock.
// No real keys — every value here is a dummy.
export const SB = 'https://test-project.supabase.co';
process.env.SUPABASE_URL = SB;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_ANON_KEY = 'test-publishable-key';
process.env.INTERNAL_API_TOKEN = 'test-internal-token-0123456789';
process.env.URL = 'https://aisdr.example.test';
process.env.OPERATOR_EMAILS = 'ops@example.com';

export const calls = [];
let routes = [];
export function route(match, handler) { routes.push({ match, handler }); }
export function resetFetch() { calls.length = 0; routes = []; }
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers || {});
  calls.push({ url, method: init.method || 'GET', headers, body: init.body });
  for (const r of routes) {
    if (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)) {
      const out = await r.handler(url, init, headers);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out.body ?? out), { status: out.status || 200, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export function req(url, { method = 'GET', headers = {}, body } = {}) {
  return new Request(url, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
}
export const INTERNAL = { 'X-Internal-Token': 'test-internal-token-0123456789' };

/** Mock Supabase Auth: token -> user, plus memberships per user id. */
export function mockAuth(users, memberships = {}) {
  route(`${SB}/auth/v1/user`, (u, init, h) => {
    const tok = (h.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = users[tok];
    return user ? { body: user } : { status: 401, body: { msg: 'invalid JWT' } };
  });
  route(`${SB}/rest/v1/memberships`, (u) => {
    const m = /user_id=eq\.([^&]+)/.exec(u);
    return { body: (m && memberships[decodeURIComponent(m[1])]) || [] };
  });
}
