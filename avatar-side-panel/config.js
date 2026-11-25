/** Extension runtime config. No secrets. */

export const API_BASE = 'https://aisdr.a-gent.co';
export const DEFAULT_SLUG = 'a-gent';

/** Week 3: Gmail draft insertion. Off in this PR — do not build or enable it. */
export const GMAIL_DRAFT_INSERT_ENABLED = false;

/** Week 4: CRM lookup / notes. Off in this PR; allowed sites already include the three CRMs. */
export const CRM_HOOK_ENABLED = false;

/** LiveAvatar API origin for the locally bundled SDK (no remote script host). */
export const LIVEAVATAR_API_URL = 'https://api.liveavatar.com';

/**
 * Until the panel is signed in and /api/avatar-caps returns can_buy, treat
 * the user as a non-admin. Only admins may buy credits; the server must
 * re-check memberships.role IN ('owner','admin') before any real checkout.
 * Set true only to preview the admin checkout placeholders in a local review.
 * Checkout is design-only and never opens a real billing page or asks for a card.
 */
export const PREVIEW_ADMIN_CREDITS = false;
