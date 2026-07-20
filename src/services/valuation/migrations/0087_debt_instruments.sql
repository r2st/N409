-- Debt / credit instrument valuation (feature: Debt Valuation Engine). A new
-- engine domain separate from the equity approaches: bonds, term loans,
-- convertible notes and SAFEs priced by discounting contractual cash flows at a
-- market yield (benchmark + credit spread), with embedded-option instruments
-- bridging to equity.
CREATE TABLE debt_instruments (
  id                ulid PRIMARY KEY,
  name              text NOT NULL,
  instrument_type   text NOT NULL
                    CHECK (instrument_type IN ('bond', 'term_loan', 'convertible', 'safe', 'credit_spread')),
  currency          text NOT NULL DEFAULT 'USD',
  -- Instrument-type-specific parameters (face, coupon_rate, frequency,
  -- maturity_years, conversion_ratio, valuation_cap, discount, …). The route's
  -- zod schema validates the shape per type; the engine consumes it directly.
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by        ulid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX debt_instruments_created_idx ON debt_instruments (created_at DESC);

-- Credit-specific terms for an instrument (1:1). Drives the discount yield.
CREATE TABLE credit_terms (
  instrument_id     ulid PRIMARY KEY REFERENCES debt_instruments(id) ON DELETE CASCADE,
  rating            text,
  benchmark_yield   numeric(10, 6),
  spread            numeric(10, 6),
  seniority         text NOT NULL DEFAULT 'senior'
                    CHECK (seniority IN ('senior_secured', 'senior', 'subordinated', 'mezzanine')),
  secured           boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- A stored valuation run for an instrument (history). Append-only.
CREATE TABLE debt_valuations (
  id                ulid PRIMARY KEY,
  instrument_id     ulid NOT NULL REFERENCES debt_instruments(id) ON DELETE CASCADE,
  valuation_date    date NOT NULL,
  inputs            jsonb NOT NULL,
  result            jsonb NOT NULL,
  fair_value        numeric(24, 6),
  created_by        ulid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX debt_valuations_instrument_idx ON debt_valuations (instrument_id, created_at DESC);
