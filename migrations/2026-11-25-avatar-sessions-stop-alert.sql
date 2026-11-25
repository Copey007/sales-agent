-- Add stop-failure counters used by the avatar reaper's permanent-stop alert.
--
-- APPLY THIS MIGRATION TO PRODUCTION BEFORE DEPLOYING the week-2 reaper
-- code that selects stop_fail_count / stop_alerted_at.
-- Applying it to prod needs Mark's go. Do not apply it as part of this PR.
--
-- If the columns are missing, the reaper falls back to the previous select
-- so abandoned sessions still get stopped; only the alert is disabled.

ALTER TABLE public.avatar_sessions
  ADD COLUMN IF NOT EXISTS stop_fail_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_alerted_at TIMESTAMPTZ;
