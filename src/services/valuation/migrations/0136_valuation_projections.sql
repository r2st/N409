-- Where the DCF's cash flows came from.
--
-- `inputs.income.free_cash_flows` is the income approach's primary input — the
-- stream every discount factor is applied to — and on this platform it is a
-- column an analyst types into the financial-model form, one figure per year,
-- with nothing anywhere saying what revenue, what margin, what capital
-- intensity produced it. It is the same shape as the discount rate before 0135
-- and the volatility before 0134, on the larger number.
--
-- `engine/projection.py` has built that stream since it was written and had no
-- caller. It projects revenue two ways — top-down off a base and a growth
-- vector, or bottom-up off explicit per-year lines — takes COGS, OpEx, D&A,
-- CapEx and NWC as fractions of revenue or as figures, and derives
--
--     EBIT  = Revenue − COGS − OpEx − D&A
--     NOPAT = EBIT · (1 − tax)
--     FCFF  = NOPAT + D&A − CapEx − ΔNWC
--
-- returning the per-line build alongside the flows. None of it was reachable:
-- `/engine/v1/projection` is not called from anywhere in the platform, and no
-- table could hold what it returned.
--
-- This is the record of one run of it, and its shape follows `volatility_
-- estimates` for the same reasons:
--
--   * Append-only. A projection is a set of assumptions somebody made on a
--     date; it does not become wrong when a later one assumes differently. The
--     runs before the current one are why the forecast moved.
--   * The assumptions are stored, not just the flows. A cash-flow stream with
--     no build behind it is a typed column with extra steps — which is exactly
--     what this feature exists to replace. `inputs` is what was sent to the
--     engine, so a run can be re-struck on a corrected figure or checked
--     against the source it was drawn from.
--   * The per-line projection is stored, because "revenue grew to what, at what
--     margin" is the substance a reviewer questions, and it is not recoverable
--     from the flows.
--   * `applied_at` records that this run's flows were written into
--     `engine_inputs.income`. A run is a forecast until somebody adopts it, and
--     the report may only cite the one the calculation actually ran on.
--
-- What is deliberately *not* adopted with it is the terminal value. The engine
-- returns one, and `income_dcf` computes its own from `terminal_growth` /
-- `terminal_method` — writing the projection's figure into the inputs as well
-- would put it into the valuation twice. The terminal-year EBITDA is adopted
-- instead, as `terminal_metric`, which is the figure an exit-multiple terminal
-- value needs and the reason `income_dcf` otherwise falls back to the final
-- free cash flow and records the basis as `fcff`.

CREATE TABLE IF NOT EXISTS valuation_projections (
  id             ulid PRIMARY KEY,
  valuation_id   ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,

  -- 'growth' (top-down off a base and a growth vector) or 'driver' (bottom-up
  -- off explicit per-year lines). The engine is the authority on the label;
  -- this stores what it returned.
  method         text NOT NULL,
  -- The explicit forecast period. Bounded to the engine's own MAX_FORECAST_
  -- YEARS, which is 100 — well past any defensible horizon, and the point is
  -- to refuse the horizon that sizes eight per-year lists into gigabytes.
  years          integer NOT NULL,
  -- The rate NOPAT was struck at, as a fraction.
  tax_rate       numeric(6, 4) NOT NULL,

  -- What was sent to engine/v1/projection, whole. The assumptions *are* the
  -- disclosure, and the flows below cannot be reproduced or corrected without
  -- them.
  inputs         jsonb NOT NULL DEFAULT '{}',
  -- [{"year": 1, "revenue": ..., "cogs": ..., "ebitda": ..., "fcff": ...}, ...]
  projections    jsonb NOT NULL DEFAULT '[]',
  -- The stream itself, in year order. Adopted into engine_inputs.income.
  free_cash_flows jsonb NOT NULL DEFAULT '[]',

  -- 'gordon' | 'exit_multiple' | NULL. Recorded because it says what the run
  -- was *for*; the terminal value itself is not adopted (see above), but a run
  -- struck with no terminal method is a different forecast from one struck
  -- with a Gordon tail, and the reader should be able to tell them apart.
  terminal_method text,
  terminal_value numeric(20, 2),

  applied_at     timestamptz,
  applied_by     ulid REFERENCES users(id) ON DELETE SET NULL,
  created_by     ulid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every read is "the runs for this engagement, newest first".
CREATE INDEX IF NOT EXISTS valuation_projections_valuation_idx
  ON valuation_projections (valuation_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valuation_projections_method_check') THEN
    ALTER TABLE valuation_projections
      ADD CONSTRAINT valuation_projections_method_check
      CHECK (method IN ('growth', 'driver'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valuation_projections_terminal_method_check') THEN
    ALTER TABLE valuation_projections
      ADD CONSTRAINT valuation_projections_terminal_method_check
      CHECK (terminal_method IS NULL OR terminal_method IN ('gordon', 'exit_multiple'));
  END IF;
  -- The same bound engine/projection.py enforces when it builds the flows, and
  -- approaches.py enforces when it is handed them directly.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valuation_projections_years_band') THEN
    ALTER TABLE valuation_projections
      ADD CONSTRAINT valuation_projections_years_band
      CHECK (years >= 1 AND years <= 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valuation_projections_tax_rate_band') THEN
    ALTER TABLE valuation_projections
      ADD CONSTRAINT valuation_projections_tax_rate_band
      CHECK (tax_rate >= 0 AND tax_rate < 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valuation_projections_shapes') THEN
    ALTER TABLE valuation_projections
      ADD CONSTRAINT valuation_projections_shapes
      CHECK (
        jsonb_typeof(inputs) = 'object'
        AND jsonb_typeof(projections) = 'array'
        AND jsonb_typeof(free_cash_flows) = 'array'
      );
  END IF;
END
$$;

COMMENT ON TABLE valuation_projections IS
  'One run of engine/v1/projection: the assumptions sent, the per-line build returned, and the FCFF stream. Append-only; the newest row is the current forecast.';
COMMENT ON COLUMN valuation_projections.inputs IS
  'What was sent to the engine, whole. The assumptions are the disclosure — the flows cannot be reproduced or corrected without them.';
COMMENT ON COLUMN valuation_projections.applied_at IS
  'Set when this run''s flows were written into engine_inputs.income. Null means forecast but not adopted, and the report must not cite it as the stream the calculation ran on.';
COMMENT ON COLUMN valuation_projections.terminal_value IS
  'The engine''s terminal value, recorded but never adopted: income_dcf computes its own from terminal_growth/terminal_method, and writing this into the inputs too would put it into the valuation twice.';
