-- ASC 718 Public (feature: ASC 718 Public). The ASC 718 measurement itself is
-- stateless (computed on demand, like sensitivity), but a public-company
-- engagement carries persistent configuration the private path does not: the
-- issuer type, the subject ticker whose market price/volatility drives the
-- underlying, and the parameters of the award types public issuers grant
-- (ESPP lookback/discount, RSU performance conditions, relative-TSR peer
-- basket). One settings row per valuation.
CREATE TABLE asc718_settings (
  valuation_id            ulid PRIMARY KEY REFERENCES valuations(id) ON DELETE CASCADE,
  company_type            text NOT NULL DEFAULT 'private'
                          CHECK (company_type IN ('private', 'public')),
  -- Public underlying: the issuer's own traded ticker (resolved via the market
  -- feed) and the expected-term method public issuers elect.
  ticker                  text,
  expected_term_method    text NOT NULL DEFAULT 'simplified'
                          CHECK (expected_term_method IN ('simplified', 'lattice', 'historical')),
  -- ESPP (§423 plan with lookback).
  espp_discount_pct       numeric(6, 4),
  espp_lookback_months    integer,
  -- RSU performance/market conditions (jsonb: target units, attainment,
  -- hurdle, etc. — shape validated by the route's zod schema).
  rsu_performance_conditions jsonb,
  -- Relative-TSR peer basket (jsonb array of { name, volatility, correlation }).
  tsr_peer_basket         jsonb,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              ulid REFERENCES users(id)
);
