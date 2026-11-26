# Proposal: save avatar transcripts on the CRM record (not built)

Status: **proposal, decisions recorded — not built in this PR**. This PR does not write a transcript to any CRM, to `chrome.storage`, to a new A-Gent table, or to logs. The side panel may show the session’s turns after End so the person can reread or Copy them; that copy lives only in the panel page’s memory and is discarded when the panel is closed.

Mark’s decision (25 Nov 2026, 3:25 PM ET): transcripts are saved to the **CRM record** (A-Gent CRM, HubSpot, or Salesforce). Nothing is stored in the panel. This replaces the earlier `avatar_transcripts` table proposal.

Mark’s follow-up (25 Nov 2026, 4:43 PM ET): **keep transcripts for 90 days** and make sure they can be integrated with a CRM. Retention is 90 days across the A-Gent CRM, HubSpot, and Salesforce. There is an explicit delete path. HubSpot and Salesforce expiry is enforced by **our own scheduled cleanup job**, which deletes only the notes, Tasks, and ContentNotes we created, tracked by stored external IDs.

Save only when a contact is identified. If no contact is found, keep the turns in the panel for this session and do not create an orphan CRM record. Do not send the transcript to LiveAvatar as `context_id`, and do not use it for model training, unless that is approved separately.

## Where it would go, per CRM

### A-Gent CRM (`crm.a-gent.co`)

- **Object / field (proposed):** a note (or activity) on the open contact, e.g. `contact_notes` / `activities` with `contact_id`, `type = 'avatar_transcript'`, `body` (text), `session_id`, `created_at`. Exact table is **unknown** in `Copey007/sales-agent` — this repo has no CRM contacts/notes schema (the product is a separate host). Confirm against the A-Gent CRM codebase before building.
- **Visibility:** on the contact record, next to ordinary notes.
- **If the table does not exist:** add a tenant-scoped notes table with RLS matching other A-Gent CRM data (anon: none; authenticated: own tenant only; writes through a service-role function).

### HubSpot

- **Object / field:** a **Note** engagement on the contact, via `POST /crm/objects/2026-09/notes` (or the current Notes API), properties `hs_timestamp` (required) and `hs_note_body` (text, documented limit **65,536 characters**), associated with the contact (`associationTypeId` **202**, note-to-contact).
- **Source:** [HubSpot Notes API](https://developers.hubspot.com/docs/api-reference/latest/crm/activities/notes/guide).
- **Title / first line:** `A-Gent avatar session · {date}` so it is easy to scan on the timeline.
- **If the body would exceed the limit:** split into a second note or attach a file; a 3-minute session should fit.

### Salesforce

- **Recommendation: a completed Task**, not a ContentNote, as the primary record.
- **Object / field:** `Task` with `WhoId` = Contact or Lead, `Status = Completed`, `Subject = 'A-Gent avatar session'`, `Description` = the transcript, `TaskSubtype` or a “Log a Call” style completed activity so it appears on the **Activity Timeline**.
- **Why a Task, not a Note:** Salesforce’s “Log a Call” action “creates a completed task or activity record” and is how communications are documented on a contact; in Lightning those records show under past activity on the [Activity Timeline](https://help.salesforce.com/s/articleView?id=sales.activity_timeline_parent.htm&language=en_US&type=5). [Log a Call](https://help.salesforce.com/s/articleView?id=000387963&language=en_US&type=1) (Help, 22 Sep 2026) is explicitly a Task. ContentNote (enhanced Notes / Files) is a document linked with `ContentDocumentLink`; it is not an activity and does not show in the Activity Timeline the same way. Tasks are also the type used in standard [Activity Reports](https://help.salesforce.com/s/articleView?id=analytics.reports_activity.htm&language=en_US&type=5).
- **Limits / fallback:** Task `Description` is a long text field (commonly 32,000 characters; confirm on the org). If a transcript would overflow, add a **ContentNote** (or a File) for the full text and keep a short completed Task that points at it. Do not use the legacy `Note` sObject (superseded by ContentNote).
- **App type:** build an **External Client App**, not a Connected App (new Connected Apps cannot be created as of Spring '26; Salesforce Help 005228017, 7 Oct 2026). Drop `openid`. Limit the `api` scope with admin-approved users, a permission set limited to Contact/Lead read and Task create, and refresh-token expiry / rotation.
- **Alternative considered:** ContentNote only. Better for long rich text, worse for timeline and activity reports. Not recommended as the only record.
## Consent (must be approved before building)

Replace bundled “By starting, you agree” with two separate choices:

1. **Workspace-admin toggle** that enables CRM saving at all. Default off until an admin turns it on. If this is off, the panel never offers to save and never writes to a CRM.
2. **Per-session save choice**, asked at End (or shown as a toggle defaulting off before End): “Save this conversation to {Contact name} in {CRM}?” The matched contact’s name is shown first, and the person must confirm that match before anything is written. If they decline, or no contact is confirmed, keep the turns in the panel memory only.

An audit record is stored when a save happens (and only then): user id, time (`consent_at` / `saved_at`), CRM, record ID of the note or task, notice version, and no transcript body. “Nothing is stored in the panel” still holds.

## Privacy notice (proposed text)

Disclose LiveAvatar / HeyGen (and LiveKit as the media path). There is **no BAA** with HeyGen or LiveAvatar, so health information must stay out.

> We can save this conversation to {Contact name} in {A-Gent CRM / HubSpot / Salesforce} so you and your workspace can reread it there. A-Gent does not keep a copy in this side panel. The live video and voice go through LiveAvatar / HeyGen (and LiveKit). Replies are generated by A-Gent’s concierge through the Manus LLM proxy (Claude Haiku). Their retention and data-processing terms apply, and A-Gent does not have a Business Associate Agreement (BAA) with LiveAvatar, HeyGen, or Manus. Do not discuss health information. By default we save the full transcript, with a length cap. A shorter summary is optional. Third-party emails and phone numbers that came from the email page are stripped. The note follows that CRM’s access rules. We keep it for 90 days, then delete it through the path below, or sooner if you ask us to delete it.

Short receipt after a successful save (week 4+): `Transcript saved to {Name} in {CRM} · just now`.

## What is saved (minimisation)

- Default: the **full transcript**, with a length cap. A shorter summary is optional (opt-in), not the default.
- Confirm the contact match before writing.
- Cap the stored length. If the full transcript exceeds the CRM field limit, keep the Salesforce **completed Task** and put the overflow in a **ContentNote** (or split a HubSpot note / A-Gent CRM note). The same overflow path applies to a chosen summary if it is too long.
- Strip third-party emails and phone numbers that came from Gmail content.
- Never log transcript bodies in Netlify function logs.
- Never pass the transcript (or summary) to LiveAvatar `context_id`.
- Never store the transcript in the panel, `chrome.storage`, or a new A-Gent table, unless a later approval says otherwise.

## Retention and deletion

**Retention is 90 days** across the A-Gent CRM, HubSpot, and Salesforce (Mark, 25 Nov 2026, 4:43 PM ET). The transcript is saved to the CRM record as designed in the sections above. Nothing is kept in the side panel, `chrome.storage`, or a new general-purpose A-Gent transcript table.

### Ledger (needed so we can delete only what we created)

When a save succeeds, store an audit / ledger row (no transcript body): user id, `consent_at` / `saved_at`, CRM name, contact / record id, notice version, and the **external IDs we created** — A-Gent CRM note id, HubSpot note id, Salesforce Task id, and ContentNote / ContentDocument id when overflow was used. The ledger is the only source of truth for what A-Gent is allowed to delete later. Do not scan a contact’s entire timeline and guess.

The A-Gent CRM notes table is still unknown in this repo; confirm against the CRM codebase before building. The ledger can live next to that table, tenant-scoped, with RLS matching other A-Gent CRM data.

### Explicit delete path

The person (or a workspace admin) can delete a saved transcript on request, and deletion also runs when the linked contact is deleted if the CRM tells us about that. The same deleter used by the scheduled job is used here: look up the ledger row, delete **only** the stored external IDs in that CRM, then mark the ledger row deleted (or delete it) once every remote delete has been confirmed or has returned a not-found. Never delete a note, Task, or ContentNote whose id is not in our ledger.

### Scheduled cleanup job (HubSpot and Salesforce; also used for A-Gent CRM)

HubSpot and Salesforce will not reliably expire our notes and Tasks after 90 days on their own, and we must not depend on a customer’s workspace retention policy. **Our own scheduled job** enforces the 90-day window.

**Design**

- A scheduled function (daily is enough; a Netlify scheduled function or existing cron style, like the avatar reaper) lists ledger rows with `saved_at` (or `consent_at`) older than 90 days and `deleted_at` empty.
- For each row it calls the CRM adapter’s `deleteTranscript(externalIds)`:
  - **A-Gent CRM:** delete the note / activity we created, by stored id, in the same tenant.
  - **HubSpot:** `DELETE` the Note engagement by the stored note id only.
  - **Salesforce:** delete the stored Task, and the stored ContentNote / ContentDocument if one was created for overflow. Do not delete other Activities, Tasks, or Files on the contact.
- Deletes are idempotent: a 404 / already-deleted response is success. Only after every stored id is gone or not-found do we mark the ledger row completed.
- The job is batched (a small page size) so a large backlog cannot overrun the function time limit; leftover rows run on the next tick.
- The job never creates CRM records, never writes transcript bodies, and never mints LiveAvatar sessions.

**Scopes**

- HubSpot: the existing notes OAuth scopes, including permission to delete a note the app created. Do not request scopes to delete contacts or unrelated engagements.
- Salesforce: the week-4 External Client App stays on a narrow permission set. Add Task delete and, if overflow is used, ContentNote / ContentDocument delete, still limited to what the app created. Keep admin-approved users, drop `openid`, and keep refresh-token expiry / rotation. Do not request broader “modify all” access.
- A-Gent CRM: server-side service-role or the signed-in tenant’s own notes, with RLS so one tenant cannot delete another’s row.
- The scheduled function uses the stored OAuth refresh tokens / service credentials already used to *save* the transcript, per workspace. If a token has been revoked, that is a failure (below), not a reason to skip the ledger row forever.

**Failure handling**

- Fail closed on an individual row: leave `deleted_at` empty, record `delete_fail_count`, `last_delete_error` (no transcript body, no tokens), and retry on the next run with a simple backoff (for example skip a row until `delete_fail_count` delays have passed).
- A 401/403 (revoked or missing scope) is retryable until an admin reconnects; surface it in operator logs. Do not invent `OPERATOR_EMAILS` if that env is unset; if it is set, a permanent failure after a small threshold (same idea as the avatar stop-alert) may email operators.
- Partial success (Task deleted, ContentNote still present) keeps the row open and retries only the remaining ids.
- The explicit delete path reports success / partial / failed in the UI and uses the same rules.
- The job must not delete a row that is younger than 90 days, and must not call a CRM delete API with an id that is not in the ledger.

**Tests** (mocked CRM APIs, no live HubSpot / Salesforce / paid calls)

- A ledger row older than 90 days is deleted at the stored HubSpot note id, Salesforce Task id, and ContentNote id only; no other ids are sent.
- A row newer than 90 days is left untouched.
- A 404 from the CRM is treated as success and the ledger row is closed.
- A 500 / 401 leaves the ledger row open and increments the fail count; the next run retries.
- Partial Salesforce success (Task 204, ContentNote 500) retries only the ContentNote.
- The explicit delete path deletes a 10-day-old transcript immediately, still only by stored ids.
- A spoofed or unknown id that is not in the ledger is rejected and produces zero CRM delete calls.
- Revoked OAuth does not skip the row silently; it is recorded as a failure.

## What this PR does instead

- No CRM write, no `avatar_transcripts` table, no `chrome.storage`.
- After End, the transcript can stay visible in the panel (Copy included) until the panel document is closed.
- The in-memory transcript now includes typed lines plus spoken user turns and avatar replies from LiveAvatar SDK events (`user.transcription`, `avatar.transcription`).
