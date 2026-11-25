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
- **Alternative considered:** ContentNote only. Better for long rich text, worse for timeline and activity reports. Not recommended as the only record.

## Retention and deletion

- **HubSpot and Salesforce:** the transcript lives under the **customer’s CRM retention and deletion policy**. Public docs do not give a single default retention period we can promise; it depends on the hub / org (and any GDPR / HIPAA add-ons). Unknown: whether Mark wants an A-Gent-side expiry that deletes the CRM note after N days. Proposed default: **do not auto-delete in the CRM**; let the workspace’s CRM policy govern, and support a manual “delete this note” later.
- **A-Gent CRM:** proposed default **30 days** from session end, env-overridable, plus hard-delete on request or when the contact is deleted (cascade). Confirm with Mark.
- **The panel:** no retention, because nothing is stored there.

## Privacy and consent notice (proposed text)

Show this once before the first session that can be saved, after a contact is in context (or as a general start notice when a CRM tab is allowed). Record `consent_at` only after they Start. If they decline, run the session with in-memory captions only.

> We can save this conversation to the contact in {A-Gent CRM / HubSpot / Salesforce} so you and your workspace can reread it there. A-Gent does not keep a copy in this side panel. The note follows that CRM’s access and retention rules. We only save finished sentences, not a raw email dump. By starting, you agree to save this session to the open contact when one is found.

Short receipt after a successful save (week 4+): `Transcript saved to {Name} in {CRM} · just now`.

## What this PR does instead

- No CRM write, no `avatar_transcripts` table, no `chrome.storage`.
- After End, the transcript can stay visible in the panel (Copy included) until the panel document is closed.
