# A-Gent avatar Chrome side panel (week 2 scaffold)

Unpacked Manifest V3 side panel for the A-Gent avatar pilot. It is **not** listed on the Chrome Web Store. Do not submit it.

This directory is separate from the existing `extension/` tree. **Do not modify `extension.zip`.**

## Load unpacked for review

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder (`avatar-side-panel`).
4. Pin the A-Gent action, then click it to open the side panel.
5. Open Gmail (`mail.google.com`), the A-Gent CRM (`crm.a-gent.co`), HubSpot (`app.hubspot.com` or `app-eu1` / `app-ap1`), or a Salesforce Lightning / `*.my.salesforce.com` tab. Anywhere else, the panel shows the “off on this site” state.

**Please do not click Start against production unless Eng Lead has approved a paid session.** Start calls `POST https://aisdr.a-gent.co/api/avatar-token` and will use LiveAvatar credits. Review the UI states (idle, not allowed, cap, fail-closed, Buy more credits placeholder) without starting a session.

## Permissions (minimal)

| Permission | Why |
| --- | --- |
| `sidePanel` | Open the Chrome side panel UI. |
| `tabs` | Read the active tab’s URL so the panel can allow only Gmail and the launch CRMs, and show the not-allowed state everywhere else. |
| `https://aisdr.a-gent.co/*` | The service worker calls the existing avatar-token, avatar-caps, heartbeat, and end APIs. The panel has no send path. |
| `https://api.liveavatar.com/*` | The locally bundled SDK talks to LiveAvatar once a session token has been minted. |

There is no `storage` permission (transcripts are not stored). There is no Gmail send scope, no `<all_urls>`, and no content script in this week. The LiveAvatar web SDK (`@heygen/liveavatar-web-sdk@0.0.18`) is bundled at `vendor/liveavatar-web-sdk.js` and loaded from the extension origin only. There is no remote script host (esm.sh is not permitted).

`tabs` is required in week 2 to read the active tab URL on sites we do not yet have `host_permissions` for. Once weeks 3–4 add host permissions for the allowed sites, `tab.url` is available for those hosts without `tabs`, so **`tabs` can be dropped then** (or replaced with `activeTab` if we only need the tab the person clicked the action on). The Web Store currently shows a “Read your browsing history” warning because of `tabs`.

### Microphone permission

Chrome side panels often cannot show a `getUserMedia` permission prompt. On Start the panel queries the microphone permission for the extension origin and, if it is not already granted, opens `mic-permission.html` in a tab (script is in `mic-permission-page.js`, not inline). A user gesture on that page grants the permission for the whole extension origin, including the side panel. That page does not mint a session or call LiveAvatar. See `mic-permission.js`.

## What this week includes

- Design states for idle, connecting, live, speaking, thinking, ended, couldn’t start, cool-down / too many starts, monthly cap, session timeout, fail-closed, not-allowed, the buy-credits placeholders, and Contact your A-Gent admin.
- Only admins can buy credits. Non-admins see “Contact your A-Gent admin” instead of Buy more credits. The purchase flow is design-only: TBD chips, no prices, no card fields, and no real billing URL. Checkout buttons are labelled “(preview)” and do not open a tab. The server `can_buy` flag (from a signed-in `/api/avatar-caps` call) is the source of truth; `PREVIEW_ADMIN_CREDITS` only previews the admin placeholders locally.
- After End, the transcript can stay visible in the panel (Copy included). It is only in this page’s memory and is discarded when the panel closes. It is not written to `chrome.storage`, disk, or a server. Saving to the CRM record is proposed, not built (see `docs/avatar-transcript-storage-proposal.md`).
- Gmail draft insertion (`GMAIL_DRAFT_INSERT_ENABLED`) and CRM hooks (`CRM_HOOK_ENABLED`) are off. Week 3 will use the person’s own Gmail signature; that work is not in this PR.

## Allowed sites and URL patterns

See `allowed-sites.js`. The list is the single source of truth and is meant to stay easy to extend (id, label, kind, hosts / hostTest). Detection uses the `tabs` permission (the tab URL). **Week 2 does not add CRM or Gmail `host_permissions`**, because this PR does not inject into those pages or call their APIs.

Allowed URL patterns (JavaScript allowlist):

| Site | Patterns |
| --- | --- |
| Gmail | `mail.google.com` |
| A-Gent CRM | `crm.a-gent.co` |
| HubSpot | `app.hubspot.com`, `app-eu1.hubspot.com`, `app-ap1.hubspot.com`, and any `app-<region>.hubspot.com` (`/^app(-[a-z0-9]+)?\.hubspot\.com$/i`). Not `www.hubspot.com`. |
| Salesforce | `*.lightning.force.com`, `*.my.salesforce.com`. Not GovCloud (`*.lightning.crmforce.mil`), `help.salesforce.com`, `login.salesforce.com`, or the rest of `*.salesforce.com`. |

Proposed **future** `host_permissions` (week 3–4, not in this manifest): `https://mail.google.com/*`, `https://crm.a-gent.co/*`, `https://app.hubspot.com/*`, `https://app-eu1.hubspot.com/*`, `https://app-ap1.hubspot.com/*`, `https://*.lightning.force.com/*`, `https://*.my.salesforce.com/*`.

## Panel login, caps, and checkout (not built)

`GET /api/avatar-caps` now requires a signed-in tenant member (or operator) and is scoped to the caller's tenant. It returns `can_buy: true|false` for that caller. It never returns admin email addresses.

There is **no** `GET /api/tenant-admins` (and one must not be added if it would return emails to the client). "Contact your A-Gent admin" stays a compose path that does not reveal addresses, or is handled server-side later.

Before any **real** checkout (this PR stays design-only):

1. The panel must be authenticated (a panel login that attaches a Bearer token to API calls).
2. The server must check `memberships.role IN ('owner','admin')` for the caller's tenant and create the checkout session itself.
3. Unauthenticated, non-member, or lookup errors fail closed with 401/403, and never a billing URL.

Until that login exists, the unpacked panel's caps refresh returns 401 and `can_buy` stays false unless `PREVIEW_ADMIN_CREDITS` is on for a local preview.

## Database migration (do not apply from this PR)

`stop_fail_count` and `stop_alerted_at` are required on production `avatar_sessions` for the permanent-stop alert. The SQL is in `migrations/2026-11-25-avatar-sessions-stop-alert.sql`. Applying it to prod needs Mark's go. **Apply the migration before deploying this code.** Until then, the reaper falls back to the previous select so abandoned sessions still get stopped; only the alert is disabled.

## SDK usage

Start loads `vendor/liveavatar-web-sdk.js` first, then mints a token. The session starts, then attaches to a `<video>` element on `session.stream_ready` (the stream is not ready before that). Typed questions go to `/api/concierge` (the A-Gent brain: `avatar_agents` prompt and knowledge, default model `claude-haiku-4-5`), and the avatar speaks that reply with `session.repeat()`. `session.message()` is not used, because that would be LiveAvatar’s own AI. `voiceChat` is off, matching `agent.html`. User and avatar turns are captured from SDK transcription events into the in-memory transcript only. Each Ask costs one concierge LLM completion (max 300 output tokens) on top of the LiveAvatar session minutes already being used; there is no LiveAvatar `context_id` charge because we do not set one.
