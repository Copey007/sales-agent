# Hunter.io verification policy

This is a **behaviour change** for prospect enrollment. It ships default-on.

Applies to the two enrollment paths that call Hunter's email verifier:

- `netlify/functions/researcher-background.mjs`
- `netlify/functions/campaign-orchestrator.mjs`

The MCP `verify_email` tool is a raw lookup and is unchanged: it still returns Hunter's status to the caller and does not enroll anyone.

## What changed

**Previously**

- `researcher-background` enrolled an address when Hunter returned `valid`, `accept_all` (catch-all), or `webmail` with score > 50.
- `campaign-orchestrator` was looser: `valid`, `accept_all`, **or any status with score > 50** (which could let through `unknown` or `disposable`).

High-confidence domain-search hits (confidence ≥ 90) skipped the verifier and were enrolled automatically.

**Now (default)**

| Hunter status | Enrolled? |
|---|---|
| `valid` | Yes |
| `webmail` and score > 50 | Yes |
| `accept_all` (catch-all) | **No** |
| `unknown` | **No** (already rejected on the researcher path; now also rejected on the orchestrator path even when score > 50) |
| `disposable` | **No** (same as unknown) |
| `invalid` or anything else | No |

If a high-confidence domain-search result already includes `verification.status`, that status is run through the same policy. Hits with no verification status still skip the verifier to preserve Hunter quota.

## Config

`HUNTER_ALLOW_RISKY` — unset or any value other than `true` / `1` / `yes` keeps the new default.

Set `HUNTER_ALLOW_RISKY=true` (Netlify env, not set by this PR) to also enroll `accept_all`. `unknown` and `disposable` stay rejected even with the flag. This does **not** restore the orchestrator's old "any status with score > 50" rule.

## Why

Catch-all domains accept any local part, so a "delivered" result is not evidence the mailbox exists. Unknown and disposable addresses have poor deliverability and raise complaint risk. Rejecting them is the free option-A fix from the W2-AG-07a deliverability comparison.

## Tests

See `tests/hunter-policy.test.mjs`. Tests mock Hunter; they never call the live API.
