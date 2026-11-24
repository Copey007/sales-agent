/**
 * RFC 8058 one-click unsubscribe.
 *
 *   POST /api/unsubscribe?token=...
 *        Body may be "List-Unsubscribe=One-Click" (RFC 8058). A valid signed
 *        token is enough; the body is not used as authorization.
 *        Writes the address to suppression_list. Idempotent.
 *        No session, cookie, or JWT — the HMAC token is the only credential,
 *        and it can only insert that email for that tenant. Invalid tokens
 *        return 401. This is not an auth bypass for any other data.
 *
 *   GET /api/unsubscribe?token=...
 *        Confirmation page only. GET never mutates (email clients prefetch).
 */
import { verifyUnsubToken } from './_email-compliance.mjs';
import { addToSuppressionList, logActivity, DEFAULTS } from './_campaign-store.mjs';

function headers(extra = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>${esc(title)}</h1>${body}</body></html>`;
}

async function recordUnsub({ email, tenantId }) {
  const tid = tenantId || DEFAULTS.TENANT_ID;
  const addr = String(email).trim().toLowerCase();
  // Idempotent: the store key is tenant:email, so a second POST overwrites
  // the same record and still returns 200.
  await addToSuppressionList({
    tenant_id: tid,
    email: addr,
    reason: 'one_click_unsubscribe',
    source: 'rfc8058',
    suppressed_at: new Date().toISOString(),
  });
  try {
    await logActivity({
      type: 'one_click_unsubscribe',
      tenant_id: tid,
      email: addr,
      source: 'rfc8058',
    });
  } catch (err) {
    console.error('[unsubscribe] activity log failed:', err.message);
  }
  return { email: addr, tenantId: tid };
}

const __handler = async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';
  const verdict = verifyUnsubToken(token);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!verdict.ok) {
      return new Response(page('Unsubscribe', '<p>This unsubscribe link is invalid or has expired.</p>'), {
        status: 401, headers: headers(),
      });
    }
    const action = esc(`/api/unsubscribe?token=${token}`);
    const html = page('Unsubscribe',
      `<p>Confirm you want to stop receiving these emails.</p>
       <form method="post" action="${action}">
         <input type="hidden" name="List-Unsubscribe" value="One-Click">
         <button type="submit">Unsubscribe</button>
       </form>`);
    return new Response(req.method === 'HEAD' ? null : html, { status: 200, headers: headers() });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'GET, POST', 'X-Robots-Tag': 'noindex' },
    });
  }

  if (!verdict.ok) {
    return new Response(JSON.stringify({ error: 'invalid token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' },
    });
  }

  await recordUnsub({ email: verdict.email, tenantId: verdict.tenantId });
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    return new Response(page('Unsubscribed', '<p>You have been unsubscribed. You will not receive further emails from this sender.</p>'), {
      status: 200, headers: headers(),
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' },
  });
};

export const config = { path: '/api/unsubscribe' };
export default __handler;
