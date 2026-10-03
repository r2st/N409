-- Three new subscription tiers for the client-facing pricing page.
--
-- The existing catalogue (per_valuation, annual_retainer, enterprise) serves
-- the platform's internal model — high-touch, ops-managed plans. These three
-- sit alongside them and power the self-serve pricing page at /pricing:
--
--   starter    — $299 one-time, 1 valuation (the 409A entry point)
--   growth     — $199/month, 3 valuations/year, priority support
--   enterprise_monthly — $499/month, unlimited valuations
--
-- The existing `enterprise` tier is yearly at $50k; `enterprise_monthly` is
-- the self-serve monthly variant. Both are active: the yearly is sold by
-- ops/sales, the monthly is sold on /pricing.

INSERT INTO plan_limits (tier, name, valuation_limit, price_cents, currency, interval, active, sort_order)
VALUES
  ('starter',             'Starter',              1,    29900,  'usd', 'one_time', true, 10),
  ('growth',              'Growth',               3,    19900,  'usd', 'month',    true, 11),
  ('enterprise_monthly',  'Enterprise',           NULL, 49900,  'usd', 'month',    true, 12)
ON CONFLICT (tier) DO UPDATE SET
  name            = EXCLUDED.name,
  valuation_limit = EXCLUDED.valuation_limit,
  price_cents     = EXCLUDED.price_cents,
  currency        = EXCLUDED.currency,
  interval        = EXCLUDED.interval,
  active          = EXCLUDED.active,
  sort_order      = EXCLUDED.sort_order;

-- Orders table: tracks client-initiated plan purchases from /order.
-- Each order produces either a one-time checkout (starter) or a subscription
-- checkout (growth/enterprise_monthly). The Stripe webhook updates the status.
CREATE TABLE IF NOT EXISTS orders (
  id                     ulid PRIMARY KEY,
  user_id                ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_tier              text NOT NULL REFERENCES plan_limits(tier),
  company_name           text NOT NULL,
  company_url            text,
  amount_cents           integer NOT NULL,
  currency               text NOT NULL DEFAULT 'usd',
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'active', 'completed', 'canceled')),
  stripe_checkout_id     text,
  stripe_subscription_id text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, created_at DESC);
