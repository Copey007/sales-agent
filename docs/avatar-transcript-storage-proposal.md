# Proposal: save avatar transcripts on the CRM record (not built)

Status: **proposal only**. This PR does not write a transcript to any CRM, to `chrome.storage`, to a new A-Gent table, or to logs. The side panel may show the session’s turns after End so the person can reread or Copy them; that copy lives only in the panel page’s memory and is discarded when the panel is closed.

Mark’s decision (25 Nov 2026, 3:25 PM ET): transcripts are saved to the **CRM record** (A-Gent CRM, HubSpot, or Salesforce). Nothing is stored in the panel. This replaces the earlier `avatar_transcripts` table proposal.

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

> We can save this conversation to {Contact name} in {A-Gent CRM / HubSpot / Salesforce} so you and your workspace can reread it there. A-Gent does not keep a copy in this side panel. The live video and voice go through LiveAvatar / HeyGen (and LiveKit). Replies are generated by A-Gent’s concierge through the Manus LLM proxy (Claude Haiku). Their retention and data-processing terms apply, and A-Gent does not have a Business Associate Agreement (BAA) with LiveAvatar, HeyGen, or Manus. Do not discuss health information. By default we save the full transcript, with a length cap. A shorter summary is optional. Third-party emails and phone numbers that came from the email page are stripped. The note follows that CRM’s access rules. Retention is pending Mark’s decision.

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

**Retention is pending Mark.** Do not ship auto-delete or an indefinite keep until he picks one policy. Options to present:

- Let each CRM’s own retention govern (no A-Gent auto-delete).
- A single A-Gent-side expiry (for example 30 days) that deletes the CRM note or task everywhere.
- A hybrid: A-Gent CRM expires, HubSpot / Salesforce follow the workspace policy.

Until that decision, the proposal records the created HubSpot note ID, Salesforce Task (and ContentNote) IDs, and the A-Gent CRM note ID so a **delete path** can remove them on request or when the contact is deleted. The A-Gent CRM table is still unknown in this repo; confirm against the CRM codebase before building.

## What this PR does instead

- No CRM write, no `avatar_transcripts` table, no `chrome.storage`.
- After End, the transcript can stay visible in the panel (Copy included) until the panel document is closed.
- The in-memory transcript now includes typed lines plus spoken user turns and avatar replies from LiveAvatar SDK events (`user.transcription`, `avatar.transcription`).
