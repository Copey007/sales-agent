# Week 3: Gmail draft insertion — DOM approach

Status: **built in this draft PR, not deployed**. The unpacked side panel can read the visible Gmail thread and insert a proposed reply into the open compose box. Gmail’s own Send button remains the only send action. There is no Gmail API, no `gmail.send` (or any send) scope, and no content script outside `https://mail.google.com/*`.

`GMAIL_DRAFT_INSERT_ENABLED` is on. CRM hooks and transcript save-to-CRM stay off (week 4).

## Why a content script

Week 2 only read the tab URL (via `tabs`) and never touched the Gmail page. Inserting text into compose, and reading the message that is already on screen, requires a content script in the tab. The manifest therefore adds:

- `host_permissions`: `https://mail.google.com/*` (justified: tab-only read of the visible thread and insert into compose).
- `content_scripts`: `gmail-content.js` on `https://mail.google.com/*` only, `document_idle`, module.

It does **not** add `<all_urls>`, `scripting`, `identity`, Gmail REST scopes, or any Google API host. `tabs` is kept so the allowlist still works on CRM hosts that do not yet have host permissions.

The service worker forwards `GMAIL_READ_THREAD` and `GMAIL_INSERT_DRAFT` only after checking `isGmailUrl(tab.url)`. Other hosts return `not_gmail` and no message is sent into the page.

## How we find the compose box and signature

Selectors live in `avatar-side-panel/gmail-dom.js` (`GMAIL_SELECTORS`) and are locked by the HTML fixtures under `tests/fixtures/gmail/`. A Gmail UI change that drops these hooks fails the suite instead of silently inserting nothing (or, worse, sending).

**Compose body** (first match wins, last box on the page is used if several are open):

1. `div[aria-label="Message Body"][contenteditable="true"]`
2. `div[aria-label="Message body"][contenteditable="true"]`
3. `div[g_editable="true"][role="textbox"][contenteditable="true"]`

**Signature** (searched *inside* the compose box only):

1. `[data-smartmail="gmail_signature"]`
2. `div.gmail_signature`

**Quoted thread**, used as a fallback anchor when no signature is found: `div.gmail_quote` or `blockquote.gmail_quote`.

**Visible message**, for the panel summary: the last `div[data-message-id] div.a3s` / `div.a3s.aiL`, with quoted history and signatures stripped, capped at 1,200 characters. Subject comes from `h2[data-thread-perm-id]` / `h2.hP`; sender from `span.gD[email]`.

## How insertion preserves the person’s signature

1. Sanitize the draft to plain text (tags stripped, length-capped). Never assign `innerHTML` on the compose box.
2. Build a `div[data-agent-draft="true"]` of text nodes and `<br>` elements.
3. If a previous A-Gent draft node exists, replace only that node.
4. Otherwise `insertBefore` the signature, or before the quoted thread if no signature is found, or append if the box is empty.
5. After the write, compare the signature element’s `outerHTML` to the snapshot taken before. If it changed, return `signature_clobbered` (we do not invent or overwrite a signature).
6. If compose is not open, click **Reply** (preferred) or **Compose** (`[aria-label="Reply"]` / `[role="button"][gh="cm"]`) and wait briefly for the box. Those clicks are rejected if the control looks like Send. If no box appears, return `compose_unavailable` so the panel can say so and leave the draft on screen to copy.

Gmail then keeps the signature it would have added if the person had typed the draft themselves. We never write an A-Gent signature, a name placeholder, or a blank over that block.

## What the panel does

- On Gmail, the panel shows a **Gmail draft** card: subject / sender, a short snippet of the visible message, **Read this email**, and **Propose a reply** once a live avatar session is running (the proposal uses the existing `/api/avatar-chat` path; it does not mint a new LiveAvatar session).
- **Insert draft** asks the content script to place the proposal in compose. **Copy draft** is always available when a draft exists, including after End and when compose could not be opened.
- Helper copy: “You click Send in Gmail. A-Gent never sends email.” There is no Send, “send for me”, or automatable send control in the panel, the content script, the service worker, or the aisdr API.

## Tests

`tests/avatar-week3-gmail-draft.test.mjs` drives the fixtures through jsdom. Every case asserts that the fixture’s Send control is never clicked. LLM, LiveAvatar, HeyGen, and CRM calls are not made.
