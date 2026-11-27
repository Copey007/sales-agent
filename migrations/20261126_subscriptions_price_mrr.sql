-- Optional price / MRR columns for public.subscriptions.
--
-- DO NOT apply this to live Supabase from this PR. It is checked in so an
-- operator can review and apply it later (Supabase SQL editor or CLI) once
-- the Stripe webhook sync is ready to store unit amounts.
--
-- The webhook upserts the original core columns first and only then attempts
-- to PATCH these fields. If they do not exist yet, the core row still lands
-- and the optional PATCH is logged and ignored.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT,
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS unit_amount INTEGER,
  ADD COLUMN IF NOT EXISTS interval TEXT,
  ADD COLUMN IF NOT EXISTS interval_count INTEGER,
  ADD COLUMN IF NOT EXISTS quantity INTEGER,
  ADD COLUMN IF NOT EXISTS mrr_cents INTEGER;

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_price
  ON public.subscriptions (stripe_price_id);
