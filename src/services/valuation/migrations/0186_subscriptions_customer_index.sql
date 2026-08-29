-- The Stripe customer as a lookup key.
--
-- `charge.refunded` names a charge, an invoice and a customer, and never a
-- subscription of ours. When the invoice it names is not on file — a renewal
-- whose `invoice.paid` is still on Stripe's retry ladder, or one this platform
-- deliberately dropped because it could not resolve the account — the only
-- thing left on the event that can say whether the money was ours is
-- `charge.customer`. Answering that is a lookup on a column nothing indexed:
-- `subscriptions` is indexed by user and unique on the *subscription* id, and
-- the customer id is neither.
--
-- Not UNIQUE. One Stripe customer legitimately carries several subscription
-- rows here — a resubscribe issues a new subscription id and leaves the
-- cancelled one behind, and `findStripeCustomerId` already reads them
-- newest-first on that assumption.
CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
