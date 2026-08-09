-- Where the expected volatility came from.
--
-- `valuation_params.volatility` describes itself as "Equity volatility from
-- guideline companies", and nothing on the platform derived it from guideline
-- companies. It arrived as a number somebody typed, defaulted to 0.65, and fed
-- the OPM allocation, every option-based DLOM and the ASC 718 assumptions
-- table without a single row anywhere saying which companies, over which
-- window, on which estimator. Sigma is the input a reviewer questions second
-- after the multiple, and the honest answer was unavailable.
--
-- `engine/v1/volatility` has estimated it from comparable price series since it
-- was written — three estimators, per-company breakdown, a dispersion-graded
-- confidence — and had no caller. This is the record of one run of it.
--
-- Shape follows from what an exhibit and an auditor need:
--
--   * Append-only. A run is an observation of the market over a window, and the
--     window it observed does not become wrong when a later run observes a
--     different one. The newest run is the current estimate; the ones before it
--     are why the number moved.
--   * The per-company breakdown is stored, not just the median. "Which peers,
--     and what did each one measure" is the whole substance of the disclosure —
--     a median with no set behind it is a typed number with extra steps.
--   * The window is stored as the dates requested, because the answer depends
--     on them entirely and they are not recoverable from the result.
--   * `applied_at` records that this run's recommendation was written into the
--     params override. A run is an estimate until somebody adopts it, and the
--     report may only cite the one the calculation actually ran on.

CREATE TABLE IF NOT EXISTS volatility_estimates (
  id             ulid PRIMARY KEY,
  valuation_id   ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,

  -- 'historical' | 'ewma' | 'parkinson' as requested, or 'manual' when the
  -- analyst pinned a value and the engine echoed it back. The engine is the
  -- authority on the label; this stores what it returned.
  method         text NOT NULL,
  -- Annualisation factor the estimate was struck on (252 for daily closes).
  periods_per_year integer NOT NULL DEFAULT 252,
  -- The observation window, as sent to the price feed.
  window_start   date NOT NULL,
  window_end     date NOT NULL,
  -- Matched to the OPM term when one is set, so a reader can see whether the
  -- window and the horizon the sigma is used over agree.
  time_to_exit_years numeric(8, 4),

  -- The engine's recommendation and the distribution it came out of. Every one
  -- is a fraction: 0.6412 is 64.12%.
  recommended    numeric(8, 4) NOT NULL,
  median_vol     numeric(8, 4),
  mean_vol       numeric(8, 4),
  min_vol        numeric(8, 4),
  max_vol        numeric(8, 4),
  coefficient_of_variation numeric(8, 4),
  -- 'high' | 'medium' | 'low' | 'manual', graded by comp count and dispersion.
  confidence     text NOT NULL,
  manual_override numeric(8, 4),

  -- [{"ticker": "ABC", "volatility": 0.61, "used": true, "observations": 251}]
  companies      jsonb NOT NULL DEFAULT '[]',
  -- [{"ticker": "XYZ", "reason": "no measurable price movement"}] — comps the
  -- engine dropped, plus the tickers whose price series the feed could not
  -- serve. Both are "considered and not counted", which is the column an
  -- auditor asks about.
  excluded       jsonb NOT NULL DEFAULT '[]',

  applied_at     timestamptz,
  applied_by     ulid REFERENCES users(id) ON DELETE SET NULL,
  created_by     ulid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every read is "the runs for this engagement, newest first".
CREATE INDEX IF NOT EXISTS volatility_estimates_valuation_idx
  ON volatility_estimates (valuation_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_estimates_method_check') THEN
    ALTER TABLE volatility_estimates
      ADD CONSTRAINT volatility_estimates_method_check
      CHECK (method IN ('historical', 'ewma', 'parkinson', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_estimates_confidence_check') THEN
    ALTER TABLE volatility_estimates
      ADD CONSTRAINT volatility_estimates_confidence_check
      CHECK (confidence IN ('high', 'medium', 'low', 'manual'));
  END IF;
  -- The same band routes/params.ts enforces on the override this feeds. An
  -- estimate outside it cannot be adopted, so storing one is storing a number
  -- with nowhere to go.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_estimates_recommended_band') THEN
    ALTER TABLE volatility_estimates
      ADD CONSTRAINT volatility_estimates_recommended_band
      CHECK (recommended > 0 AND recommended <= 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_estimates_window_order') THEN
    ALTER TABLE volatility_estimates
      ADD CONSTRAINT volatility_estimates_window_order
      CHECK (window_end > window_start);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_estimates_companies_is_array') THEN
    ALTER TABLE volatility_estimates
      ADD CONSTRAINT volatility_estimates_companies_is_array
      CHECK (jsonb_typeof(companies) = 'array' AND jsonb_typeof(excluded) = 'array');
  END IF;
END
$$;

COMMENT ON TABLE volatility_estimates IS
  'One run of engine/v1/volatility over the engagement''s peer set: the window, the per-company measurements, and the recommendation. Append-only; the newest row is the current estimate.';
COMMENT ON COLUMN volatility_estimates.applied_at IS
  'Set when this run''s recommendation was written into the valuation_params.volatility override. Null means estimated but not adopted, and the report must not cite it as the sigma the calculation ran on.';
