# Proposal: persist avatar-session transcripts (not built)

Status: **proposal only**. This PR does not create a table, write captions, or send transcript text to an LLM store. The side panel may keep captions in memory after End so the person can reread them until they close the panel; closing the panel discards them.

Mark asked that the transcript persist after the session ends. This is the storage design for Eng Lead / Mark to approve before any implementation.

## Where it would be stored

New table `avatar_transcripts` in the same Supabase project as `avatar_sessions` (`byospmliiokgrdjjxsde`), not on the extension, not in `chrome.storage`, and not in logs.

Suggested schema:

```sql
CREATE TABLE avatar_transcripts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES avatar_sessions(id) ON DELETE CASCADE,
  tenant_id           UUID,                 -- copy of the session's tenant
  agent_slug          TEXT NOT NULL,
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  -- Ordered turns. speaker is 'user' | 'agent'. text is the finished sentence
  -- (the panel already updates captions once per sentence, not per word).
  turns               JSONB NOT NULL DEFAULT '[]',
  -- Optional redaction / consent metadata
  consent_at          TIMESTAMPTZ,
  retention_until     TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

One row per session, written only when the session ends (or on a periodic flush of finished sentences if we later need crash-safety). No partial word stream. The extension would POST finished sentences to a new authenticated endpoint; it would not keep a second copy.

## RLS and tenant scoping

- Enable RLS. Anon: **no** access (same posture as `avatar_sessions` after the lockdown).
- Authenticated: `SELECT` (and no client-side insert/update/delete) only when `tenant_id IN (SELECT auth_tenant_ids())` or `is_super_admin()`.
- Writes go through a service-role Netlify function after `requireTenant` / the existing session-row owner check, so a caller can only append to their own `session_row`.
- Operators (`OPERATOR_EMAILS`) may read via an operator-guarded admin path if Mark later wants support access; until then, operator read is out of scope.
- The service role key never ships to the extension.

## Retention and deletion

Proposal, pending Mark’s confirmation:

- Default retention: **30 days** from `ended_at` (`retention_until`). Env-overridable later, not before approval.
- A scheduled job deletes rows where `retention_until < now()`. Deleting the parent `avatar_sessions` row cascades.
- The person (or a tenant admin) can request earlier deletion; the function hard-deletes the row, it does not soft-delete.
- Backups follow the project’s existing Supabase backup window; we should say so in a privacy notice before launch.

Unknown until Mark confirms: whether 30 days is the right default, and whether a “download my transcript” export is required.

## PII and consent

Transcripts can contain names, email subject lines, and whatever the person or the avatar says about a lead. Treat the row as **personal data**.

- Do not put raw Gmail body dumps into the transcript; only the spoken / typed turns and a short “read 1 open message from X” receipt (as the design already shows), not the full email.
- Show a one-line notice before the first session that records: that the conversation is kept for a stated period so the person can reread it, and who in their workspace can see it.
- Record `consent_at` when they Start after that notice. If they decline, run the session with in-memory captions only (today’s behaviour).
- Do not use transcripts for model training. Do not send them to LiveAvatar as a `context_id` unless that is separately approved (today we omit LiveAvatar’s context_id).
- Access logs for the read API should record tenant and actor, not the transcript text.

## What would be sent to the LLM

Until this is approved, **nothing** is stored and the concierge only sees the current in-session turns already sent through `repeat(text)` / the existing speak path.

If approved, a later week could:

- Send the current session’s prior turns (not other sessions, not other tenants) as short context when drafting a reply, still fail-closed if the store is down.
- Cap context size (for example the last N turns or ~2k tokens) and strip email signatures and quoted history.
- Never send another tenant’s transcript, and never send the store contents to a third-party model without a documented processor list.

Week 3 Gmail insertion can draft from the in-memory captions and the visible message, without this table.

## What this PR does instead

- No `avatar_transcripts` table, no endpoint, no `chrome.storage`.
- Captions remain in the side-panel page’s memory after End, and go away when the panel document is closed.
