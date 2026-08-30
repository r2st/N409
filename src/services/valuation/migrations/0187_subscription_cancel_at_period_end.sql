-- A cancellation that has been *scheduled* but has not happened yet.
--
-- Stripe's hosted portal — the one "Manage subscription" opens — cancels by
-- setting `cancel_at_period_end` on the subscription, which stays `active`
-- and keeps serving until the period runs out. Every self-serve cancellation
-- passes through this state, often for a month or a year, and the column it is
-- reported in was not read: the subscription stayed 'active' here with nothing
-- recording that it ends, so the Billing screen told a customer who had just
-- cancelled that their plan was active and said nothing about when it stops.
--
-- Additive and defaulted, so a row written before this column existed reads as
-- what it was: a subscription with no cancellation scheduled.
ALTER TABLE subscriptions
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;
