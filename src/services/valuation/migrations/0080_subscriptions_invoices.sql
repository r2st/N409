-- Subscription / retainer billing + invoicing (feature 7). Extends the
-- one-time Stripe checkout (0041/0043) with recurring plans, usage tracking
-- against a plan limit, and generated invoices.

-- Plan catalogue. valuation_limit NULL = unlimited; interval 'one_time' is the
-- pay-per-valuation tier (no subscription), 'year'/'month' are recurring.
CREATE TABLE plan_limits (
  tier            text PRIMARY KEY,
  name            text NOT NULL,
  valuation_limit integer,               -- NULL = unlimited
  price_cents     integer NOT NULL,
  currency        text NOT NULL DEFAULT 'usd',
  interval        text NOT NULL DEFAULT 'year'
                  CHECK (interval IN ('one_time', 'month', 'year')),
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0
);

INSERT INTO plan_limits (tier, name, valuation_limit, price_cents, currency, interval, sort_order) VALUES
  ('per_valuation',   'Per valuation',    1,    200000,  'usd', 'one_time', 1),
  ('annual_retainer', 'Annual retainer',  12,  2000000,  'usd', 'year',     2),
  ('enterprise',      'Enterprise',       NULL, 5000000, 'usd', 'year',     3);

CREATE TABLE subscriptions (
  id                   ulid PRIMARY KEY,
  user_id              ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_tier            text NOT NULL REFERENCES plan_limits(tier),
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'trialing', 'past_due', 'canceled')),
  stripe_subscription_id text UNIQUE,
  stripe_customer_id   text,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  -- Usage consumed in the current period; reset on renewal.
  valuations_used      integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  canceled_at          timestamptz
);
-- One active subscription per user (a canceled one can coexist historically).
CREATE UNIQUE INDEX subscriptions_one_active_per_user
  ON subscriptions (user_id) WHERE status IN ('active', 'trialing', 'past_due');
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);

CREATE TABLE invoices (
  id                 ulid PRIMARY KEY,
  number             text NOT NULL UNIQUE,
  user_id            ulid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id    ulid REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount_cents       integer NOT NULL,
  currency           text NOT NULL DEFAULT 'usd',
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('draft', 'open', 'paid', 'void')),
  period_start       timestamptz,
  period_end         timestamptz,
  line_items         jsonb NOT NULL DEFAULT '[]',
  stripe_invoice_id  text UNIQUE,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_user_idx ON invoices (user_id, issued_at DESC);
CREATE INDEX invoices_subscription_idx ON invoices (subscription_id);
