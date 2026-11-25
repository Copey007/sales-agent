# A-Gent avatar pilot — weeks 2 to 4, and Web Designer asks

Week 1 is the sales-agent PR for caps, fail-closed minting, and LiveAvatar stop on abandon / timeout / tab close. This note covers the next three weeks of the A-Gent-only pilot (Chrome side panel, Gmail draft insertion, CRM hook). It does not ship other products (RefoundGTM, AskArlen, PlanVeya).

Constraints carried forward:

- No LiveAvatar or HeyGen plan or billing changes. Overage stays off.
- Stock face and stock voice (Katya, already on aisdr). No custom look in this window.
- Draft only: the avatar never sends email. The person clicks Send.
- No paid session calls in tests. Prefer mocks. One short real session only if later approved.
- Do not deploy week-1 or later work to production until Eng Lead / Mark says go.

LiveAvatar allowance (read 25 Nov 2026, 2:34 PM ET window): `GET /v1/users/credits` returned `credits_left: 210.0` and no plan name or monthly ceiling. Official public docs no longer list Starter ($19). Historical Starter was 200 credits / month (~100 FULL-mode minutes at 2 credits/min) with a 5-minute session max. 210 remaining is consistent with a 200 + 10 bonus allotment that is almost unused. Week-1 defaults: `AVATAR_MONTHLY_MINUTE_CAP=60` minutes and `AVATAR_MAX_SESSION_SECONDS=180` (3 minutes), both env-overridable, always the tighter of the platform cap and the agent row.

---

## Week 2 — Chrome side panel with the live avatar

**Goal.** An unlisted / unpacked Chrome side panel opens next to a test Gmail inbox and next to an allowed CRM (A-Gent CRM, HubSpot, or Salesforce), shows the stock avatar, and starts a live conversation within 5 seconds of the user clicking Start. It reuses the existing aisdr token + caps + stop paths. No email sending. No production Chrome Web Store listing yet.

**Acceptance criteria**

- Installing the unpacked extension and pinning it opens a side panel on `mail.google.com` and on the allowed CRM hosts (A-Gent CRM, HubSpot, Salesforce).
- The panel loads the stock Katya avatar and a live session starts within 5 seconds of Start, using `POST /api/avatar-token` only (no GET).
- Heartbeat, `pagehide` / `sendBeacon` end, and the server reaper all still stop the LiveAvatar session. Closing the panel or the tab ends billing within one reaper interval (about one minute, plus the 60s heartbeat timeout).
- Hitting the monthly cap or the per-session max shows a clear in-panel state and does not mint another session.
- If the usage store is down, Start fails closed (5xx/429/503 surfaced as an error state). No token is minted.
- A kill switch / allowed-sites list can be stubbed or deferred to a follow-up, but the panel must refuse to start on a non-Gmail, non-CRM tab if that list is present.
- Automated tests mock LiveAvatar. No paid session is required to call week 2 done.
- Design is implemented from the Web Designer kit below, at WCAG 2.2 AA for the panel UI (contrast, focus, names).

**Dependencies from Web Designer:** the side panel kit in the section below, approved by Mark if mockups are shown to him first.

### Week 2 engineering follow-ups (in the week-2 draft PR)

These came out of the #15 re-review and are implemented in the week-2 draft (still not deployed):

- **Release the reserved seat when a FULL session without voice is rejected.** If minting is refused because FULL mode has no `voice_id`, cancel the pending `avatar_sessions` reservation so it does not hold a concurrency seat until the reaper runs.
- **Alert when a LiveAvatar stop fails permanently.** After five failed retryable stops, log `PERMANENT_STOP_FAILURE` and try to email `OPERATOR_EMAILS`. If that env is unset, fail quietly to the log and do not invent an address. The row stays open.

Mark's later answers that change the week-2+ plan:

- Billing window resets on the **26th** (UTC), not the 1st. Monthly cap default stays 60 minutes; per-session default stays 180 seconds. Server enforces a **30-second cool-down** between sessions.
- Launch CRMs: **A-Gent CRM, HubSpot, and Salesforce**. The panel allowlist is one extensible list (`avatar-side-panel/allowed-sites.js`).
- On monthly cap or session timeout, the panel offers **"Buy more credits"** as a placeholder only: no billing link, no purchases, no hard-coded prices or caps in that CTA. Cap numbers shown in the limit notices come from the server.
- Gmail drafts use **the person's own Gmail signature** (the earlier "no signature" answer is withdrawn). Planned in week 3; not built in week 2.
- The transcript should persist after End. **Storage is not built** until Eng Lead / Mark approve `docs/avatar-transcript-storage-proposal.md`. Until then, captions may stay in the panel's memory only.

---

## Week 3 — Gmail draft insertion (draft only)

**Goal.** From the open Gmail thread, the avatar can read the visible message (in the tab, not via background Gmail scopes) and insert a draft into the open compose box, including the person's own Gmail signature. Nothing is sent except when the person clicks Gmail's Send.

**Acceptance criteria**

- On an open Gmail thread, the panel can summarize the visible message and propose a reply.
- "Insert draft" writes the proposal into the open compose box (or opens compose and inserts there). Gmail's Send button remains the only send action.
- The inserted draft uses **the person's existing Gmail signature**, not an A-Gent signature and not a name we invent. Prefer Gmail's own compose signature (the one Gmail would add if the person typed the draft). If the signature cannot be read from the open compose box, leave Gmail's signature in place and insert only the body above it; never overwrite a signature with a blank. Document the DOM approach in the PR. This is week-3 work; it is behind `GMAIL_DRAFT_INSERT_ENABLED` (off) until then.
- There is no Send, "send for me", or automatable send path in the extension, the avatar tools, or the aisdr API.
- If compose is not open and cannot be opened, the panel says so and leaves the draft on screen for copy.
- A test account run shows: draft appears with the person's signature still present, no message is sent until a person clicks Send, and a sent-mail search does not contain a bot-sent copy from that run.
- Gmail DOM selectors are covered by a test fixture so a UI change fails the suite instead of silently sending nothing (or, worse, sending).
- Still no background `gmail.send` or similar scope that would trigger Google's security audit. Tab-only access. Week 3 may add a `mail.google.com` content script / host permission; justify it then. Do not add it in week 2.
- Transcript storage is still not built unless the proposal has been approved. Drafting may use in-memory captions only.

---

## Week 4 — CRM hooks (A-Gent, HubSpot, Salesforce) + private test

**Goal.** The same panel can look up the current contact and write a note / next step in **A-Gent CRM, HubSpot, and Salesforce**. Shared hook interface, three adapters, same panel states (contact found / not found / note saved / note failed). Mark uses it for a private week and signs off. Still draft-only for email.

The allowlist and hook should stay easy to extend: one `allowed-sites.js` entry plus one CRM adapter that implements `lookupContact(context)` and `logNote(contactId, text)`. Do not special-case the UI per CRM beyond the source label and "Open in CRM" URL.

**Shared acceptance criteria**

- From a test contact in the current CRM tab (and, if an email is visible in Gmail, by matching that address), the panel shows a short history (name, last activity, open tasks) from that CRM's official API with the user's existing auth. Prefer APIs over scraping the DOM. Reading the tab URL to identify the record is fine.
- "Log note" / "log next step" creates a note on that contact. The test row is visible in the CRM UI and can be deleted afterwards.
- Failures (unknown contact, auth missing, CRM down) are explicit in the panel. No silent writes.
- No email is sent from this hook. CRM writes are notes and tasks only.
- Private test: Mark can use it for a week on the stock face/voice, within the configured caps (still below the Starter allowance). Sign-off is his go / no-go for any later store listing or persona work.
- Custom Holly-style face/voice stays out of this window unless Mark later approves a likeness and a plan that allows it.

**A-Gent CRM**

- Host already allowlisted: `crm.a-gent.co`. Use A-Gent's own contact/notes APIs and the signed-in session if one exists; otherwise an explicit sign-in state.
- No marketplace review. This is our product.

**HubSpot**

- Hosts: `app.hubspot.com` and regional `app-<region>.hubspot.com` (already in the allowlist).
- Use a HubSpot private app or OAuth app in Mark's hub for the private test. Official APIs for contacts and notes; no DOM scrape of HubSpot data.
- **Marketplace listing is not required for an unpacked private pilot.** It would be required later if we list a public HubSpot app. Listing needs OAuth as the sole auth method, at least three active unique installs, and the other [app listing requirements](https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements).
- If the extension is later offered as part of a HubSpot Marketplace app, HubSpot's [certification requirements](https://developers.hubspot.com/docs/apps/developer-platform/list-apps/apply-for-certification/certification-requirements) say: browser extensions must not be created specifically for the HubSpot UI or as a workaround to HubSpot's APIs, must not inject capabilities or components into HubSpot's UI, and "Your app will be subjected to an additional security assessment if it includes a browser extension." Week 4 should keep CRM UI in the Chrome side panel (not injected into HubSpot's page) and use official APIs. Certification review time and any fee are **unknown** from the public docs (they describe process, not a published SLA or price).
- Chrome Web Store review is a separate later step and is still out of scope.

**Salesforce — review cost and time (flag)**

- Hosts already allowlisted: `*.lightning.force.com`, `*.my.salesforce.com` (not the whole `*.salesforce.com` tree, so help/docs/login marketing sites stay not-allowed).
- A private unpacked extension that only reads the tab URL and calls Salesforce APIs from a backend needs a **Connected App** (OAuth) in Mark's org. Creating a connected app in one org is not the same as listing on AppExchange. Official docs describe security review as a requirement **before listing on AppExchange** ([AppExchange Starter Pack for ISVs](https://www.salesforce.com/en-us/wp-content/uploads/sites/4/documents/partners/readiness/the_appexchange_starter_pack_for_isvs.pdf), copyright August 2023). Whether a *private* connected app used only in Mark's org needs any Salesforce review is **not stated** in those sources; the working assumption is "no listing, no review," and we should confirm with a Partner Account Manager before any distribution outside that org.
- If we later list on AppExchange (or AgentExchange), plan for a security review:
  - **Fee (current public figures):** **$999 per attempt** for paid or freemium solutions; free listings can be waived. The Starter Pack (Aug 2023) also says submissions typically take **two attempts ($1,998)** and points at the AppExchange Security Review Fee Update. The same **$999 per attempt** figure is restated for AgentExchange in Salesforce Help, published **24 Nov 2026**: [AgentExchange Security Review Fees, Waivers, and FAQs](https://help.salesforce.com/s/articleView?id=005467094&language=en_US&type=1). Retests after a real failure cost another $999; false-positive-only resubmits can be $0. New versions of an already-approved package generally do not need a new review.
  - **Conflict / stale figure:** [partners.salesforce.com Security Review education page](https://partners.salesforce.com/s/education/appinnovators/Security_Review?language=en) still quotes a **$2,700** initial fee and a **$150** annual listing fee. That matches the old 2013-era pricing and contradicts the 2023 Starter Pack and the 2026 Help article. Treat **$2,700 as stale** unless a Partner Account Manager confirms otherwise.
  - **Time:** The same education page and the Starter Pack ask you to plan **4–6 weeks** from a complete submission. The Starter Pack diagram: **1–2 weeks** for Security Review Ops to verify the submission, then the package enters the product-security queue for testing (the 4–6 week bar sits on that overall process). Trailhead's security-review module (AgentExchange wording) says a solution typically takes **4–5 weeks**. Each failed attempt adds another cycle; Salesforce does not control your fix time.
- Listing on AppExchange also requires the partner program / PADA path and, after a first AppExchange sale, percentage net revenue (ISVforce **15%**, OEM **25%**, per the same Starter Pack). Those commercial terms matter only if we publish a listing; they are out of scope for a private week-4 test.
- Unknown: whether a Chrome extension packaged with a Salesforce connected app is reviewed as a "Salesforce Platform API solution" (the Starter Pack lists Platform API solutions as a security-review category) even for a private install. Confirm before any org-to-org distribution.

**Suggested week-4 order:** ship the shared hook + A-Gent CRM adapter first (no third-party review), then HubSpot OAuth in Mark's hub, then a Salesforce connected app in Mark's org. Do not start an AppExchange or HubSpot Marketplace submission in this window.

---

## What Web Designer needs to deliver

Deliver a side-panel design kit Mark can approve, then a build-ready spec the A-Gent implementer can follow without inventing UI. Desktop Chrome only (side panel is not a phone UI). Use the existing A-Gent visual language (gold accent, dark ink, Inter, no Orbitron). WCAG 2.2 AA.

### Sizes

- Default side panel width: 360px. Also show 320px (narrow Chrome panel) and 400–420px (user-resized).
- Video stage: 16:9 or the current aisdr framing (Katya mid-shot), with a safe crop so a 320px panel does not clip the face.
- Collapsed launcher: a compact 48px-tall bar or toolbar button state, plus the expanded panel.
- Two context frames: Gmail (panel beside the thread/compose) and A-Gent CRM (panel beside a contact record). One component, two environments — note any chrome (padding against Gmail's grey, CRM's navy) that has to change.

### States (every one needs a mock at 360px, plus a 320px check)

1. Idle / not started (stock still or last frame, Start control).
2. Connecting (within the 5-second start budget).
3. Live, listening / waiting for the user.
4. Live, avatar speaking (caption area).
5. Thinking / drafting a reply (no speech).
6. Error: could not start (generic), rate limited, at capacity.
7. Cap reached: monthly limit vs session timed out, as two distinct messages. No "try Start anyway" that would mint.
8. Usage store unavailable / fail-closed (session refused).
9. Session ended / thanks, with Start again.
10. Gmail: reading the open thread (light confirmation of what was read, no raw PII dump in the mock).
11. Gmail: draft ready, inserted into compose. The primary action is "Insert draft". There is no Send button in the panel. Helper copy: "You click Send in Gmail."
12. Gmail: compose missing / could not insert.
13. CRM: contact found, short history.
14. CRM: contact not found.
15. CRM: note saved, and note failed.
16. Offline / extension not allowed on this site (if the allowed-sites list is in play).

Include keyboard focus and error-text for 6–8, 12, 14 and 15. Reduced-motion: no essential information only in the video.

### Assets

- Stock Katya still / poster (reuse aisdr `assets/demo-agent.png` or a new 2x crop at 720px wide, no custom likeness).
- A-Gent logo (existing mark) at 16, 32, 48, 128 for the extension action and panel header.
- Icons at 24px, 2x: Start, Stop / end, mute, insert draft, copy draft, log note, retry, close. Monochrome, currentColor, named.
- Empty-state illustration only if it stays on-brand and optional; a typographic empty state is fine.

### Tokens

- Map to the current A-Gent tokens: accent (`#c9a227` or the live theme token), `--on-accent`, surface, sunken, text, muted text, border, danger, focus ring.
- Type scale for the 360px panel (recommended: 12 / 14 / 16 / 20, Inter, line-length inside the panel).
- Spacing: 4px base, panel padding, stage radius, button height (min 32px, 44px preferred for primary).
- Contrast: body text and captions ≥ 4.5:1, UI chrome ≥ 3:1, focus visible on the dark stage and on Gmail's light inbox.

### Delivery

- A Figma or Page of the states above, plus a short written spec (component names, tokens, what the implementer must not add — especially any Send control).
- Export of icons and the poster at the sizes above.
- One annotated Gmail frame and one annotated CRM frame showing the panel next to real chrome, for Mark's approval.

---

## Out of scope until a later go

- Chrome Web Store listing (unlisted or public).
- Custom Holly-style face or voice.
- Avatar-sent email, background Gmail access, Google security audit.
- RefoundGTM embed, AskArlen / HubSpot, PlanVeya.
- LiveAvatar plan changes or turning overage on.
- Mission Control minute/dollar dashboard (mentioned in the scope doc's phase 0; not in the week-1 PR).
