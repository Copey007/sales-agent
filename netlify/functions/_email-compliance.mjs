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
 */
import { env } from './_auth.mjs';

export function complianceOrBlock({ replyTo } = {}) {
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
  return { ok: true, footer, headers, unsubscribeEmail, postalAddress };
}
