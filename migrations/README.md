# Database migrations

These SQL files are the source of truth for schema changes that must be applied
to a live database. Editing `netlify/functions/avatar-schema.sql` is not enough:
that file is documentation for a fresh create, and nothing in the deploy applies it.

## Deploy order (avatar stop-alert columns)

1. Get Mark's approval to apply `2026-11-25-avatar-sessions-stop-alert.sql` to production.
2. Apply the migration (the two `IF NOT EXISTS` columns on `avatar_sessions`).
3. Confirm the columns exist in the catalog.
4. Then deploy the application code that selects or patches those columns.

Do **not** apply this migration to production from this draft PR. Until it is
applied, the reaper must keep stopping abandoned sessions even if the new
columns are missing (it falls back and skips only the alert).
