-- ASC 820 fund-holdings valuation (feature: ASC 820 Fund Holdings). Distinct
-- from the corporate parent/subsidiary consolidation in organizations (0079):
-- here an investment fund (VC/PE/credit) marks a portfolio of equity positions
-- to fair value, classifies each in the ASC 820 hierarchy (Level 1/2/3), rolls
-- them up into NAV, and distributes proceeds through an LP waterfall.
CREATE TABLE fund_portfolios (
  id                      ulid PRIMARY KEY,
  name                    text NOT NULL,
  fund_type               text NOT NULL DEFAULT 'vc'
                          CHECK (fund_type IN ('vc', 'pe', 'credit', 'growth', 'other')),
  currency                text NOT NULL DEFAULT 'USD',
  vintage_year            integer,
  created_by              ulid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fund_portfolios_created_idx ON fund_portfolios (created_at DESC);

-- One equity position (holding) the fund owns in a portfolio company.
CREATE TABLE fund_positions (
  id                      ulid PRIMARY KEY,
  fund_id                 ulid NOT NULL REFERENCES fund_portfolios(id) ON DELETE CASCADE,
  company_name            text NOT NULL,
  security_type           text NOT NULL DEFAULT 'preferred'
                          CHECK (security_type IN ('common', 'preferred', 'safe', 'note', 'warrant', 'other')),
  quantity                numeric(24, 6) NOT NULL DEFAULT 0,
  cost_basis              numeric(24, 4) NOT NULL DEFAULT 0,
  -- Default marking method for the position (a mark row can override).
  mark_method             text NOT NULL DEFAULT 'cost'
                          CHECK (mark_method IN ('market', 'last_round', 'calibrated_opm', 'cost')),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fund_positions_fund_idx ON fund_positions (fund_id);

-- A fair-value mark for a position at a measurement date (mark history). Each
-- roll-forward / re-mark appends a row so the mark trail is auditable.
CREATE TABLE fund_marks (
  id                      ulid PRIMARY KEY,
  position_id             ulid NOT NULL REFERENCES fund_positions(id) ON DELETE CASCADE,
  measurement_date        date NOT NULL,
  method                  text NOT NULL
                          CHECK (method IN ('market', 'last_round', 'calibrated_opm', 'cost')),
  fair_value              numeric(24, 4) NOT NULL,
  level                   smallint NOT NULL CHECK (level IN (1, 2, 3)),
  inputs                  jsonb,
  created_by              ulid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fund_marks_position_idx ON fund_marks (position_id, measurement_date DESC);

-- LP economic terms for the fund (1:1). Drives the distribution waterfall.
CREATE TABLE lp_terms (
  fund_id                 ulid PRIMARY KEY REFERENCES fund_portfolios(id) ON DELETE CASCADE,
  committed_capital       numeric(24, 4) NOT NULL DEFAULT 0,
  contributed_capital     numeric(24, 4) NOT NULL DEFAULT 0,
  preferred_return_rate   numeric(8, 4) NOT NULL DEFAULT 0.08,
  carry_pct               numeric(6, 4) NOT NULL DEFAULT 0.20,
  gp_catch_up             boolean NOT NULL DEFAULT true,
  management_fee_pct      numeric(6, 4) NOT NULL DEFAULT 0.02,
  management_fees_paid    numeric(24, 4) NOT NULL DEFAULT 0,
  gp_distributions_to_date numeric(24, 4) NOT NULL DEFAULT 0,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
