# Deliverability metrics logging plan

Maps each metric in `/workspace/w2-ag07a/frameworks.md` §2 to a store, an event, and a status. This PR implements only the **trivial and safe** append-only `activity_log` writes listed under “Implemented here.” Everything else stays plan-only: no new tables, no Supabase migrations, no env vars, no dashboard copy changes, no auto-pause.

The frameworks doc was written against `origin/main` `1fc03c7`, before the option-A PRs in this stack. Where a later PR in this stack closes a “not logged” gap, the plan says so.

## Stores already in use

| Store | Kind | Writers | Notes |
|---|---|---|---|
| `email_sends` | Netlify Blobs | queue-manager, send-worker, inbound-webhook, campaign-admin | Campaign send ledger. Status is the source of truth for sent / blocked / suppressed / bounce / complaint after this stack. |
| `worker_outreach` | Supabase | worker-outreach | Worker-path drafts and sends. |
| `prospects`, `campaign_prospects` | Netlify Blobs | researcher, orchestrator, send-worker | Enrollment and prospect state. |
| `contact_pool` | Supabase | researcher-find / campaign-admin | Enrolled but not necessarily queued. |
| `suppression_list` | Netlify Blobs | addToSuppressionList | Key: `${tenant_id}:${email}` or `*:${email}` when the tenant is unknown (webhook). Emails are lowercased. |
| `replies` | Netlify Blobs | inbound-webhook | Human and auto-replies. Inactive in prod until `RESEND_WEBHOOK_SECRET` is set. |
| `activity_log` | Netlify Blobs | many functions | Append-only operational log. `logActivity({ type, timestamp, ... })`. List is newest-first, default 50. **Not a warehouse.** |

No new Supabase schema is proposed until someone needs a case-study export that Blobs cannot answer. A later warehouse, if built, should be a read model filled from these events, not a second write path on the send hot path.

## Event catalogue

### Implemented in this PR (trivial, append-only)

| Event `type` | When | Fields | Frameworks.md |
|---|---|---|---|
| `suppression_event` | After a signed bounce / complaint / provider-suppressed webhook, or an inbound “unsubscribe”/“stop” reply, writes the list | `reason` (`bounce` \| `complaint` \| `unsubscribe` \| `provider_suppressed`), `source` (Resend event type), `resend_id`, `emails[]`, `tenants[]`, `count` | §2.3, §2.4, §2.5 |
| `one_click_unsubscribe` | After a valid RFC 8058 POST writes suppression | `tenant_id`, `email`, `source: rfc8058` | §2.5 |
| `send_worker_batch` (extended) | Existing batch log now also includes `sends_suppressed` | previous fields + `sends_suppressed` | §2.1, §2.3 |

These writes cannot fail the user-facing path: they are wrapped in try/catch. They do not call Resend or Hunter. They do not change send/block behaviour.

### Already logged (unchanged)

| Event / record | Where | Frameworks.md |
|---|---|---|
| `email_sends` row `status: sent` + `resend_result.resend_id` | send-worker | §2.1, §2.2 Sent |
| `email_sends` `status: pending_approval` / `approved_*` / `rejected_*` | send-worker, campaign-admin | §2.9 |
| `email_sends` `status: suppressed` when the list already had the address at send time | send-worker | §2.1 |
| `send_worker_batch` | send-worker | §2.1, §2.10 |
| queue-manager activity (`effective_limit`, `sent_today`, `daily_budget_remaining`) | queue-manager | §2.10 |
| `reply_received` + `replies` blob | inbound-webhook (needs `RESEND_WEBHOOK_SECRET`) | §2.6 |
| enrollment / researcher / pool-feeder activity | researcher, orchestrator, queue-manager | §2.1 Contacts enrolled |

### Written onto `email_sends` by PR3, not yet rolled into dashboard KPIs

After this stack (webhook PR), a matching Resend event updates the original send and cancels follow-ups:

| `email_sends.status` | Source |
|---|---|
| `bounced` | `email.bounced` |
| `complained` | `email.complained` |
| `cancelled_unsubscribed` | unsubscribe reason on the matched send (rare; one-click usually has no `resend_id` match in this path) |
| `cancelled_suppressed` | queued / dispatched / pending_approval follow-ups for the same prospect |

How to measure §2.3 / §2.4 after this stack ships and `RESEND_WEBHOOK_SECRET` is set:

- Bounce rate = count(`status = bounced`) / count(`status ∈ {sent, bounced, complained}` or, more strictly, accepted-by-Resend in the window). Soft delays are still not persisted (plan-only).
- Complaint rate = count(`status = complained`) / delivered (or accepted, if delivered is still unavailable — say which).
- Unique unsubs = distinct emails in `suppression_list` with `reason` in `{unsubscribe, one_click_unsubscribe}` plus inbound opt-out, over unique contacts reached.

### Plan only — do not implement yet

1. **`email.delivered` / `email.opened` / `email.clicked` → `email_sends`**  
   Stamp `delivered_at`, `opened_at`, `clicked_at` by `resend_id`. Then `handleFunnel` can stop treating “sent and delivered !== false” as delivered (§2.2). **Held back** because open/click tracking is privacy-sensitive and needs a product decision (pixel/link tracking in Resend, plus copy). Soft bounce / `email.delivery_delayed` would live here too.

2. **Daily snapshot (optional later Supabase table `deliverability_daily`)**  
   Proposed columns: `day` (UTC date), `tenant_id`, `campaign_id`, `sent`, `delivered`, `bounced`, `complained`, `unsubscribed`, `replies`, `replies_ex_ooo`, `positive_replies`, `capped_at`. Filled by a scheduled function from Blobs, never on the send hot path. This is the case-study export. Not built.

3. **Approval edit rate (§2.9)**  
   Preserve `original_subject` / `original_body` and an `edited` flag when `approve_sends` applies edits. Small change, but it is a product/schema change on the approval path, so it stays plan-only.

4. **Meetings and pipeline (§2.8)**  
   Stay in the partner CRM or a spreadsheet. Do not invent an opportunity object in this stack.

5. **Sentiment quality (§2.7)**  
   Keep default `unclassified`. Do not auto-publish LLM labels. Inbound opt-out replies already get `sentiment: unsubscribe` (PR3).

6. **Auto-pause at a 5% bounce threshold**  
   Competitor operating practice, not a law. Needs Mark’s sign-off and a clear “pause vs notify” rule. Not in option A.

7. **Google Postmaster / Yahoo CFL**  
   Process, not code. Enroll the sending domain; store nothing in A-Gent until there is an export job.

## How a design-partner case study should be pulled (after this stack + env)

Assume `COMPANY_POSTAL_ADDRESS` and `RESEND_WEBHOOK_SECRET` are set, and the PRs in this stack are merged and deployed (not part of this PR).

| Frameworks metric | Query |
|---|---|
| §2.1 Contacts reached | Distinct `prospects.email` with at least one `email_sends.status = sent` in the window, plus distinct `worker_outreach.prospect_email` where `status = sent` |
| §2.2 Sent | `email_sends` / `worker_outreach` with `status = sent`. Label as “accepted by Resend,” not inbox placement |
| §2.2 Delivered / opened | Resend dashboard/export until plan item 1 ships. Do not publish funnel figures |
| §2.3 Bounce | `email_sends.status = bounced` and `activity_log` type `suppression_event` reason `bounce` |
| §2.4 Complaint | `status = complained` and `suppression_event` reason `complaint` |
| §2.5 Unsubscribe | `suppression_list` + `one_click_unsubscribe` + inbound opt-out `suppression_event` |
| §2.6 Reply rate | `replies`, excluding auto-replies and `sentiment = unsubscribe`, unique emails |
| §2.7 Positive reply | Manual classification until the partner has seen labels |
| §2.8 Meetings | CRM / spreadsheet |
| §2.9 Approve / reject | Ledger fields. Edit rate: not available (plan item 3) |
| §2.10 Ramp | `countSentToday` vs `effective_limit` in queue-manager logs |

## Env vars

This docs/logging PR introduces none.

Related env from earlier PRs in the stack (still unset in production unless Mark has set them):

- `COMPANY_POSTAL_ADDRESS` — required to send (PR1)
- `UNSUBSCRIBE_EMAIL` — optional; falls back to reply-to
- `UNSUBSCRIBE_SIGNING_SECRET` — preferred for one-click tokens; falls back to `INTERNAL_API_TOKEN` (PR2)
- `RESEND_WEBHOOK_SECRET` — required for bounce/complaint/inbound unsub to be recorded (PR3)
- `HUNTER_ALLOW_RISKY` — optional; default rejects catch-all (PR4)

## Tests

`tests/metrics-logging.test.mjs` asserts the two new activity types are written, with Hunter/Resend still mocked.
