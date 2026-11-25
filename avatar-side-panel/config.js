/** Extension runtime config. No secrets. */

export const API_BASE = 'https://aisdr.a-gent.co';
export const DEFAULT_SLUG = 'a-gent';

/** Week 3: Gmail draft insertion. Off in this PR — do not build or enable it. */
export const GMAIL_DRAFT_INSERT_ENABLED = false;

/** Week 4: CRM lookup / notes. Off in this PR; allowed sites already include the three CRMs. */
export const CRM_HOOK_ENABLED = false;

/** LiveAvatar web SDK, loaded only after the user clicks Start. */
export const LIVEAVATAR_SDK_URL = 'https://esm.sh/@heygen/liveavatar-web-sdk@0.0.18';
export const LIVEAVATAR_API_URL = 'https://api.liveavatar.com';

/**
 * Until the panel can read the signed-in membership role (owner | admin |
 * member), treat the user as a non-admin. Only admins may buy credits.
 * Set true only to preview the admin checkout placeholders in a local review.
 * Checkout is design-only and never opens a real billing page or asks for a card.
 */
export const PREVIEW_ADMIN_CREDITS = false;
