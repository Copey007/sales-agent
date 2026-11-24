/**
 * CAN-SPAM + List-Unsubscribe helpers for commercial outbound (prospect) mail.
 *
 * Every Netlify path that sends a prospect-facing email through Resend must
 * call complianceOrBlock() and refuse to send when it returns ok: false.
 * Internal operator notifications (reply forwards, daily reports, health
 * alerts) are not required to use this helper.
 *
 * COMPANY_POSTAL_ADDRESS is required (fail closed). UNSUBSCRIBE_EMAIL falls
 * back to the message's reply-to address.
 *
 * RFC 8058 one-click: when a recipient email is provided and a signing secret
 * is available (UNSUBSCRIBE_SIGNING_SECRET, else INTERNAL_API_TOKEN), headers
 * also include an https List-Unsubscribe URL and List-Unsubscribe-Post.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './_auth.mjs';

export function unsubSigningSecret() {
  return env('UNSUBSCRIBE_SIGNING_SECRET', env('INTERNAL_API_TOKEN'));
}

export function publicSiteUrl() {
  return (env('URL', env('SITE_URL', 'https://aisdr.a-gent.co')) || 'https://aisdr.a-gent.co').replace(/\/$/, '');
}

export function signUnsubToken({ email, tenantId } = {}) {
  const secret = unsubSigningSecret();
  const addr = String(email || '').trim().toLowerCase();
  if (!secret || !addr) return null;
  const payload = Buffer.from(JSON.stringify({
    e: addr,
    t: String(tenantId || ''),
    iat: Math.floor(Date.now() / 1000),
  }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyUnsubToken(token) {
  const secret = unsubSigningSecret();
  if (!secret) return { ok: false, reason: 'UNSUBSCRIBE_SIGNING_SECRET not configured' };
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'missing token' };
  }
  const cut = token.lastIndexOf('.');
  const payload = token.slice(0, cut);
  const sig = token.slice(cut + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'bad payload' }; }
  const email = String(data?.e || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { ok: false, reason: 'missing email' };
  return { ok: true, email, tenantId: data.t ? String(data.t) : '', iat: data.iat };
}

export function unsubscribeUrl({ email, tenantId } = {}) {
  const token = signUnsubToken({ email, tenantId });
  if (!token) return null;
  return `${publicSiteUrl()}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function complianceOrBlock({ replyTo, toEmail, tenantId } = {}) {
  const unsubscribeEmail = env('UNSUBSCRIBE_EMAIL', replyTo || '');
  const postalAddress = env('COMPANY_POSTAL_ADDRESS');
  if (!postalAddress) {
    return {
      ok: false,
      blocked: true,
      reason: 'COMPANY_POSTAL_ADDRESS not configured — refusing to send without compliance footer',
    };
  }
  const footer = `\n\n--\n${postalAddress}\nTo stop receiving these emails, reply "unsubscribe" or email ${unsubscribeEmail}.`;
  const headers = {
    'List-Unsubscribe': `<mailto:${unsubscribeEmail}?subject=unsubscribe>`,
  };
  const oneClick = toEmail ? unsubscribeUrl({ email: toEmail, tenantId }) : null;
  if (oneClick) {
    headers['List-Unsubscribe'] = `<mailto:${unsubscribeEmail}?subject=unsubscribe>, <${oneClick}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return { ok: true, footer, headers, unsubscribeEmail, postalAddress, unsubUrl: oneClick };
}
