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
| `https://esm.sh/*` | Load `@heygen/liveavatar-web-sdk@0.0.18` after the person clicks Start. |
| `https://api.liveavatar.com/*` | The SDK talks to LiveAvatar once a session token has been minted. |

There is no `storage` permission (transcripts are not stored). There is no Gmail send scope, no `<all_urls>`, and no content script in this week.

## What this week includes

- Design states for idle, connecting, live, speaking, thinking, ended, couldn’t start, cool-down / too many starts, monthly cap, session timeout, fail-closed, and not-allowed.
- “Buy more credits” is a placeholder card only: no billing link, no prices, no hard-coded caps.
- Captions may stay visible in the panel after End. They live in memory for this page only and are discarded when the panel is closed. Nothing is written to `chrome.storage`, disk, or the server.
- Gmail draft insertion (`GMAIL_DRAFT_INSERT_ENABLED`) and CRM hooks (`CRM_HOOK_ENABLED`) are off. Week 3 will use the person’s own Gmail signature; that work is not in this PR.

## Allowed sites

See `allowed-sites.js`. The list is the single source of truth and is meant to stay easy to extend (id, label, kind, hosts / hostTest). Launch sites: Gmail, A-Gent CRM, HubSpot, and Salesforce.
