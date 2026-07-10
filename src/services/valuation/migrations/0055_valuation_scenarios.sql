-- Persisted what-if scenarios (IMPROVEMENTS_RESEARCH §5.7): named bull/base/
-- bear cases saved from the sandbox with their computed results, so clients
-- and analysts can compare scenarios side by side. The official calculation
-- chain is untouched — scenarios reference the baseline they were built from.
CREATE TABLE valuation_scenarios (
  id                      ulid PRIMARY KEY,
  valuation_id            ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  label                   text NOT NULL DEFAULT 'custom'
                            CHECK (label IN ('bull','base','bear','custom')),
  -- The sandbox knob overrides ({revenue, growth_rate, discount_rate, …}).
  inputs                  jsonb NOT NULL DEFAULT '{}',
  baseline_calculation_id ulid REFERENCES calculations(id) ON DELETE SET NULL,
  equity_value            numeric,
  fmv_per_share           numeric,
  results                 jsonb,
  created_by              ulid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX valuation_scenarios_valuation_idx
  ON valuation_scenarios (valuation_id, created_at DESC);
