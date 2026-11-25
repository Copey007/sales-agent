# Public `/api/concierge` hardening

## What changed

Anonymous callers can only use public agent slugs (default `a-gent,demo`, overridable with `PUBLIC_CONCIERGE_SLUGS`). Any other slug returns 404 `agent_not_found` without loading `avatar_agents` or calling the LLM, so a private tenant prompt or knowledge base cannot leak.

Chat and qualify accept only `user` and `assistant` roles. History is capped at the last 12 turns, 2,000 characters per message, and 8,192 characters total.

`/agent.html` (and the `/a/demo`, `/a/a-gent` rewrites) keep working: the page default slug is `demo`, and both public slugs remain on the allowlist. A future customer `/a/<slug>` widget will 404 for anonymous visitors until that slug is added to the allowlist, or a later `is_public` flag is added.

## `agent_memory` review

Previously every chat turn called `remember()` with the visitor's last message and the first 200 characters of the reply. `start` stored `visitorInfo` as JSON, and `qualify` stored qualified-lead PII (name, email, company, role, pain point).

Those writes are removed. Conversation text is not stored server-side for anonymous concierge chats. Qualified leads are still written to the `contacts` table only.

`recall()` has been removed from the anonymous chat path. A client-supplied `visitorEmail` is ignored (it is not used to search memory or to insert a contacts row from chat). Qualified leads still go to the `contacts` table via the qualify action. The 66 production `agent_memory` concierge rows from 25–30 June 2026 were deleted after Mark approved the purge. No other `agent_memory` rows were touched.

## Out of scope

This change does not add authentication to `/api/concierge`. Tenant members talking to a private agent should use a future authenticated path (the panel uses `/api/avatar-chat` on the week-2 branch). No database migration is included.

## Server-side lead capture

If a visitor's *user* message contains an email address, the server extracts, lowercases and length-checks it, then inserts a `contacts` row (source `signup:concierge`). The duplicate lookup is case-insensitive at query time (`ilike`, with `%`, `_` and `*` escaped so the match stays exact); no migration is required. At most one new lead is captured per Netlify connection IP (`x-nf-client-connection-ip`, never `x-forwarded-for`) per hour, using a windowed count in the same style as the avatar-token IP throttle (Netlify Blobs, no new table). A client `visitorEmail` field is ignored. Capture failures and rate-limit skips are non-fatal to the chat. Nothing is written to `agent_memory`.
