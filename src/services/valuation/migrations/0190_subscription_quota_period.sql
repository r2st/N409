-- Which billing period the usage counter is counting.
--
-- `valuations_used` was reset to zero whenever a `customer.subscription.*`
-- event carried a `current_period_start` different from the one on file, and
-- nothing in that rule asked whether the new period had been paid for. Stripe
-- advances the period the moment it *raises* the renewal invoice, not when the
-- invoice settles: a renewal that is declined arrives here as one event
-- carrying both the next period and `status: 'past_due'`. So an annual
-- retainer that had spent all twelve of its valuations was handed twelve more
-- for a period nobody paid for — and `past_due` is a served status with no
-- end, so it kept them.
--
-- The counter therefore has to remember which period it counts against, which
-- `current_period_start` cannot do once it has moved ahead of the money. This
-- column is that memory: `valuations_used` counts the period beginning here,
-- and the reset happens when a *paying* status (see
-- BILLING_SUBSCRIPTION_STATUSES) arrives for a period this column does not
-- already name. A customer who fixes their card then gets the new period's
-- quota on the event that says the money arrived, which is the transition that
-- should have granted it all along.
--
-- Additive and backfilled from the period on file, so every existing row reads
-- as what it was: a counter already counting its current period.
ALTER TABLE subscriptions
  ADD COLUMN quota_period_start timestamptz;

UPDATE subscriptions SET quota_period_start = current_period_start;
