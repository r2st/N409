-- The bridge from the prior 409A's concluded equity value to this one's.
--
-- `valuation_params.rolling_forward` has been a boolean on the params panel
-- since migration 0001, and nothing on the platform did anything with it. An
-- engagement flagged as a roll-forward was valued from scratch like any other:
-- the prior appraisal's equity value — the one figure on the whole engagement
-- that was calibrated to an arm's-length market transaction — was not an input
-- to anything, and the report never mentioned it.
--
-- `engine/v1/rollforward` has carried a prior calibrated value to a new date
-- since it was written (accretion at the prior required return, a new round
-- superseding the anchor, explicit adjustments, and a material-change scan)
-- and had no caller. This is the record of one run of it.
--
-- Shape follows from what the exhibit and an auditor need, and it is the same
-- shape `volatility_estimates` (0134) took, for the same reasons:
--
--   * Append-only. A run bridges two dated valuations, and re-running it later
--     against a different assumption does not make the first bridge wrong. The
--     newest run is the current one; the ones before it are why the anchor
--     moved.
--   * The calibration trail is stored step by step, not just its total. The
--     whole substance of a roll-forward disclosure is the arithmetic between
--     the two numbers — a rolled value with no trail behind it is the prior
--     value with extra steps.
--   * The material-change list is stored with it. It is what the analyst
--     answered "no fresh appraisal needed" *against*, and a reviewer's first
--     question is what was on that list at the time.
--   * `applied_at` records that this run's rolled value was written into the
--     engagement's engine inputs as the backsolve anchor. A run is a proposal
--     until somebody adopts it, and Exhibit B-2 may only cite the one the
--     calculation actually ran on.

CREATE TABLE IF NOT EXISTS rollforward_runs (
  id             ulid PRIMARY KEY,
  -- The engagement being rolled forward *to* — the new 409A.
  valuation_id   ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,

  -- The engagement rolled forward *from*. SET NULL rather than CASCADE: the
  -- bridge is evidence on the new report and does not stop being true when the
  -- old engagement is removed. Everything the exhibit prints about the prior
  -- valuation is denormalised below for exactly that case.
  prior_valuation_id  ulid REFERENCES valuations(id) ON DELETE SET NULL,
  -- The prior run whose `results.equity_value` was the anchor, and its number
  -- as the report cites it. Kept beside the id because the citation has to
  -- survive the row it points at.
  prior_calculation_id ulid REFERENCES calculations(id) ON DELETE SET NULL,
  prior_valuation_number text,

  prior_valuation_date date NOT NULL,
  new_valuation_date   date NOT NULL,
  -- Reported by the engine rather than recomputed here, so the exhibit's
  -- elapsed time and the factor it was compounded over cannot disagree.
  years_elapsed  numeric(10, 4) NOT NULL,

  -- The two ends of the bridge, in the engagement's own currency.
  prior_equity_value  numeric(20, 2) NOT NULL,
  rolled_equity_value numeric(20, 2) NOT NULL,
  -- Annual appreciation applied over the gap, as a fraction: 0.250000 is 25%.
  -- Zero when a new priced round superseded the time-decay anchor entirely.
  annual_accretion    numeric(10, 6) NOT NULL,
  -- The post-money of that round, when there was one. Null is the ordinary
  -- case: a company re-valuing *without* a new priced round is the whole
  -- reason a roll-forward exists.
  new_round_post_money numeric(20, 2),

  -- [{"step": "prior_equity_value", "value": 42000000.0}, {"step":
  -- "time_accretion", "annual_rate": 0.25, "years": 1.0, "factor": 1.25,
  -- "value": 52500000.0}, ...] — the trail, in the order it was applied.
  calibration_steps jsonb NOT NULL DEFAULT '[]',
  -- [{"field": "revenue", "material": true, "detail": "revenue moved +38.2%"}]
  -- — everything the engine flagged, material or not. The immaterial entries
  -- are not noise: "revenue moved 4%, below the 20% threshold" is a statement
  -- that the question was asked.
  material_changes  jsonb NOT NULL DEFAULT '[]',
  -- True when any change was material, i.e. the engine's own answer to "does
  -- this need a fresh appraisal rather than a roll-forward". Advisory: the
  -- analyst decides, and the run records what they decided against.
  requires_full_revaluation boolean NOT NULL DEFAULT false,
  -- The engine `inputs` document the next compute would run on, with the
  -- rolled value seeded as `last_round_post_money` and the new date set.
  pre_populated_inputs jsonb NOT NULL DEFAULT '{}',

  applied_at     timestamptz,
  applied_by     ulid REFERENCES users(id) ON DELETE SET NULL,
  created_by     ulid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every read is "the runs for this engagement, newest first".
CREATE INDEX IF NOT EXISTS rollforward_runs_valuation_idx
  ON rollforward_runs (valuation_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rollforward_runs_date_order') THEN
    ALTER TABLE rollforward_runs
      ADD CONSTRAINT rollforward_runs_date_order
      CHECK (new_valuation_date >= prior_valuation_date);
  END IF;
  -- Both ends positive: the engine refuses a non-positive anchor and a
  -- non-positive rolled value, and a row here that had one would be a bridge
  -- to a company worth nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rollforward_runs_values_positive') THEN
    ALTER TABLE rollforward_runs
      ADD CONSTRAINT rollforward_runs_values_positive
      CHECK (prior_equity_value > 0 AND rolled_equity_value > 0
             AND (new_round_post_money IS NULL OR new_round_post_money > 0));
  END IF;
  -- The same floor `rollforward.py` enforces: a rate of -100% or worse is a
  -- typo, not an assumption.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rollforward_runs_accretion_band') THEN
    ALTER TABLE rollforward_runs
      ADD CONSTRAINT rollforward_runs_accretion_band
      CHECK (annual_accretion > -1 AND annual_accretion <= 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rollforward_runs_years_nonneg') THEN
    ALTER TABLE rollforward_runs
      ADD CONSTRAINT rollforward_runs_years_nonneg
      CHECK (years_elapsed >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rollforward_runs_json_shapes') THEN
    ALTER TABLE rollforward_runs
      ADD CONSTRAINT rollforward_runs_json_shapes
      CHECK (jsonb_typeof(calibration_steps) = 'array'
             AND jsonb_typeof(material_changes) = 'array'
             AND jsonb_typeof(pre_populated_inputs) = 'object');
  END IF;
  -- A valuation cannot be rolled forward from itself. The route checks it too,
  -- with a message; this is the invariant that survives a future caller.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rollforward_runs_distinct_valuations') THEN
    ALTER TABLE rollforward_runs
      ADD CONSTRAINT rollforward_runs_distinct_valuations
      CHECK (prior_valuation_id IS NULL OR prior_valuation_id <> valuation_id);
  END IF;
END
$$;

COMMENT ON TABLE rollforward_runs IS
  'One run of engine/v1/rollforward: the prior 409A''s concluded equity value carried to this engagement''s date, the calibration trail that got there, and the material changes detected on the way. Append-only; the newest row is the current bridge.';
COMMENT ON COLUMN rollforward_runs.applied_at IS
  'Set when this run''s rolled equity value was written into valuation_params.engine_inputs as last_round_post_money. Null means proposed but not adopted, and Exhibit B-2 must not cite it as the anchor the calculation ran on.';
COMMENT ON COLUMN rollforward_runs.requires_full_revaluation IS
  'The engine''s answer to "is a roll-forward defensible here": true when any detected change was material. Advisory — the analyst decides, and this records what they decided against.';
