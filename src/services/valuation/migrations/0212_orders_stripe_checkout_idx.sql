-- Stripe webhook lookups by checkout session id were doing a sequential scan
-- (R394, methodology M8). Five queries in repos/orders.ts filter on this column.
CREATE INDEX IF NOT EXISTS orders_stripe_checkout_idx
  ON orders (stripe_checkout_id) WHERE stripe_checkout_id IS NOT NULL;

-- Same table, one query filters by stripe_subscription_id.
CREATE INDEX IF NOT EXISTS orders_stripe_subscription_idx
  ON orders (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
