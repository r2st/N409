-- The two questions a Stripe webhook could not answer: have I seen this event,
-- and is it the newest thing I know about this object.
--
-- Stripe delivers at least once and guarantees no ordering. Both endpoints here
-- were written knowing that, and every individual handler was made idempotent
-- by its own means — a compare-and-set on the payments row, `ON CONFLICT` on
-- the invoice, an upsert on the subscription with `WHERE status <> 'canceled'`.
-- That is the right foundation and it is not being replaced. What it cannot do
-- is the two things a ledger can:
--
--   1. Say whether *this delivery* is a replay. Per-handler idempotency makes a
--      replay harmless where the handler's own state machine can tell; it says
--      nothing about the effects beside the state change. A redelivered
--      `charge.dispute.created` re-notified every billing admin, because the
--      notification is not the dispute row and nothing compares the two.
--
--   2. Order two events about the same object. `customer.subscription.updated`
--      carries the subscription's status wholesale, so of two of them the
--      correct answer is simply the later one — and the upsert has no way to
--      know which it is holding. Stripe's own retry is the common way they
--      arrive reversed: a delivery that failed at 10:00 and succeeds on the
--      third attempt at 10:12 lands after the 10:05 event that superseded it,
--      and the subscription goes back to whatever it said at 10:00. R57 fixed
--      the one case where the stale half is knowable from the data
--      ('canceled' is terminal); every other pair — active over past_due, a
--      downgrade over an upgrade — has no such tell.
--
-- A row is written only after the handlers for that event have run to
-- completion. That is deliberate and it is what keeps the 5xx-for-redelivery
-- design intact: an event whose handling threw leaves no record, so Stripe's
-- redelivery re-runs it rather than being turned away as a duplicate.
--
-- Two concurrent deliveries of the same event can both find no row and both
-- proceed. This ledger does not claim to prevent that — the per-handler
-- compare-and-sets are still what makes it safe, and they remain the mechanism
-- of record. What the ledger removes is the far more common sequential replay:
-- Stripe's retry ladder, an operator resending from the dashboard, a backfill.
CREATE TABLE stripe_webhook_events (
  -- Stripe's `evt_…` id, unique per event and stable across every redelivery
  -- of it.
  event_id      text PRIMARY KEY,
  type          text NOT NULL,
  -- Which endpoint handled it. The same event id can only ever arrive at one
  -- of them, but knowing which is the difference between reading the payments
  -- code and the billing code when something is wrong.
  endpoint      text NOT NULL CHECK (endpoint IN ('payments', 'billing')),
  -- The Stripe object the event is about: a subscription id, a session id, a
  -- charge id. Null when the payload carries none.
  object_id     text,
  -- `event.created`, i.e. when Stripe made the event — not when it reached us.
  -- This is the only ordering that means anything; received_at orders our
  -- deliveries, which is the thing that is wrong.
  event_created timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- 'handled' or 'stale'. A stale event is recorded rather than dropped so a
  -- redelivery of it is answered from the ledger instead of being re-judged,
  -- and so "why did this event do nothing" has an answer.
  outcome       text NOT NULL DEFAULT 'handled' CHECK (outcome IN ('handled', 'stale'))
);

-- The ordering lookup: the newest event we have handled about this object.
-- Partial because an event with no object id can never be the answer to it.
CREATE INDEX stripe_webhook_events_object_idx
  ON stripe_webhook_events (object_id, event_created DESC)
  WHERE object_id IS NOT NULL;

-- Ledgers grow; this one is read by object id and swept by age.
CREATE INDEX stripe_webhook_events_received_idx ON stripe_webhook_events (received_at);
