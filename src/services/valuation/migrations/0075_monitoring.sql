-- Real-time valuation monitoring (feature 10): after a valuation completes it
-- can be monitored for events that suggest a fresh 409A is due (new funding
-- round, material revenue change, cap-table change, 12-month expiry). The
-- baseline snapshot captured at enable time is compared to live data on each
-- scan; fired alerts are deduped so a trigger is emailed once per signature.
CREATE TABLE valuation_monitors (
  id              ulid PRIMARY KEY,
  valuation_id    ulid NOT NULL UNIQUE REFERENCES valuations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT true,
  baseline        jsonb NOT NULL DEFAULT '{}',
  last_checked_at timestamptz,
  created_by      ulid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE monitor_alerts (
  id           ulid PRIMARY KEY,
  monitor_id   ulid NOT NULL REFERENCES valuation_monitors(id) ON DELETE CASCADE,
  valuation_id ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  trigger_type text NOT NULL,
  level        text NOT NULL,
  signature    text NOT NULL,
  notified_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (monitor_id, signature)
);
