-- One Stripe event, two endpoints, two independent decisions to make about it.
--
-- Migration 0155 keyed the ledger on `event_id` alone. That reads as obviously
-- right — an event id is unique in Stripe, and it is stable across every
-- redelivery, which is the property the whole ledger is built on. What it misses
-- is that uniqueness in Stripe is not uniqueness *here*: an Event is created
-- once and then delivered to every registered endpoint subscribed to its type,
-- carrying the same `evt_…` id to each. Two endpoints receiving one event is not
-- a replay, and it is not a duplicate. It is two deliveries that both have work
-- to do.
--
-- This service has exactly that arrangement, and not by accident.
-- `checkout.session.completed` is the one event type both webhooks must be
-- subscribed to, because each handles a different half of it: the payments
-- endpoint (/api/v1/stripe/webhook) fulfils a `mode: 'payment'` session — the
-- one-off purchase of a valuation — and the billing endpoint
-- (/api/v1/billing/webhook) starts the subscription for a `mode: 'subscription'`
-- one. Each branches on `mode` and ignores the other's. Subscribing only one of
-- them to the type would break whichever half was left out, so a correctly
-- configured deployment has both.
--
-- With a single-column key, whichever delivery arrived second was answered
-- `duplicate` from the ledger and its handler never ran. Both directions are a
-- client paying and receiving nothing:
--
--   * A one-off valuation checkout reaches the billing endpoint, matches no
--     branch there (its mode is 'payment'), falls through to the ledger write
--     and is recorded 'handled'. The payments delivery is then turned away as a
--     duplicate, `fulfill()` never runs, and the payments row stays 'pending'
--     forever: the engagement is never released and the only party who knows the
--     charge succeeded is Stripe. This is precisely the failure the
--     STRIPE_WEBHOOK_SECRET boot check was added to prevent, reintroduced
--     underneath it — and worse, because here the webhook answers 200, so Stripe
--     never retries and there is no failed-delivery list to find it in.
--
--   * A subscription checkout reaches the payments endpoint, is resolved to no
--     payments row, recorded as dealt with, and the billing delivery is refused.
--     The subscriber is charged on a recurring plan that was never created.
--
-- The identity of a delivery is therefore (event, endpoint), which is what the
-- ledger now keys on. Each endpoint keeps its own idempotency and its own
-- ordering stream; a redelivery to the same endpoint is still a duplicate, which
-- is the case the ledger was built for and is unchanged.
--
-- Safe on existing rows: `event_id` was already unique, so every row is
-- trivially unique under the wider key and nothing can collide.
ALTER TABLE stripe_webhook_events DROP CONSTRAINT stripe_webhook_events_pkey;
ALTER TABLE stripe_webhook_events ADD PRIMARY KEY (event_id, endpoint);

-- The ordering lookup is scoped per endpoint for the same reason, so the index
-- leads with the endpoint's own stream. Subscription state is written only by
-- the billing endpoint, so this changes no answer it gives today; what it
-- prevents is the payments endpoint's copy of a subscription-mode checkout
-- session — which it records as dealt with precisely *because* it ignores it —
-- ever being read as evidence about a subscription it took no part in.
DROP INDEX stripe_webhook_events_object_idx;
CREATE INDEX stripe_webhook_events_object_idx
  ON stripe_webhook_events (endpoint, object_id, event_created DESC)
  WHERE object_id IS NOT NULL;
