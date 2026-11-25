# Public `/api/concierge` hardening

Draft only — do not merge or deploy until Mark approves.

## What changed

Anonymous callers can only use public agent slugs (default `a-gent,demo`, overridable with `PUBLIC_CONCIERGE_SLUGS`). Any other slug returns 404 `agent_not_found` without loading `avatar_agents` or calling the LLM, so a private tenant prompt or knowledge base cannot leak.

Chat and qualify accept only `user` and `assistant` roles. History is capped at the last 12 turns, 2,000 characters per message, and 8,192 characters total.

`/agent.html` (and the `/a/demo`, `/a/a-gent` rewrites) keep working: the page default slug is `demo`, and both public slugs remain on the allowlist. A future customer `/a/<slug>` widget will 404 for anonymous visitors until that slug is added to the allowlist, or a later `is_public` flag is added.

## `agent_memory` review

Previously every chat turn called `remember()` with the visitor's last message and the first 200 characters of the reply. `start` stored `visitorInfo` as JSON, and `qualify` stored qualified-lead PII (name, email, company, role, pain point).

Those writes are removed. Conversation text is not stored server-side for anonymous concierge chats. Qualified leads are still written to the `contacts` table only.

`recall()` still runs when the client sends `visitorEmail`, and may surface older pre-hardening notes. New notes are no longer written.

## Out of scope

This change does not add authentication to `/api/concierge`. Tenant members talking to a private agent should use a future authenticated path (the panel uses `/api/avatar-chat` on the week-2 branch). No production deploy or database change is included.
