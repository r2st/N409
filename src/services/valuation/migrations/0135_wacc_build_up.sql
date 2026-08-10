-- Where the discount rate came from.
--
-- `income.discount_rate` is the DCF's most-questioned input and it arrived the
-- same way the volatility did before 0134: as a number somebody typed. The
-- report's Appendix I — Discount Rate Build-Up (WACC) has existed in the
-- exhibit layer and in the index of exhibits since it was written, and has
-- never rendered on any engagement, because it reads `results.auto.wacc` and
-- nothing on the platform ever asked the engine to produce one.
--
-- The engine's side was complete. `engine/wacc.py` builds the cost of equity on
-- a modified CAPM — a treasury yield matched to the forecast horizon, a
-- guideline beta unlevered and re-levered to the subject's target structure, a
-- size premium off the capitalisation tier, a company-specific premium — and
-- blends it with the after-tax cost of debt. `compute.py` runs it under the
-- `auto_wacc` flag, writes the result into `income.discount_rate` where the
-- analyst has not set one, and records the whole build-up under
-- `results.auto.wacc`. All three estimation-autopilot flags (auto_wacc,
-- auto_volatility, auto_comparables) were unreachable: nothing in the service
-- set any of them.
--
-- These two columns are the missing half — the inputs to hand the engine, and
-- the switch that says to use them.
--
--   * `wacc_inputs` is jsonb for the reason `dlom_study_table` is: it is a
--     small document read and written whole with the rest of the params, never
--     queried across engagements or joined to. Its keys are validated against
--     the engine's own `_WACC_KEYS` by routes/params.ts, and again by the
--     engine's pre-flight, which rejects an unknown key rather than ignoring
--     it.
--   * `auto_wacc` is separate from the presence of `wacc_inputs`, so an
--     analyst can keep a build-up on the engagement without it driving the
--     discount rate — which is exactly what they need while deciding whether
--     to adopt it.
--
-- A manually entered `income.discount_rate` still wins, in the engine, by
-- design: the autopilot fills a gap and never overrides an analyst entry. The
-- build-up is still recorded and still printed, so Appendix I can show the
-- reader the derived figure beside the applied one.

ALTER TABLE valuation_params
  ADD COLUMN IF NOT EXISTS wacc_inputs jsonb;

ALTER TABLE valuation_params
  ADD COLUMN IF NOT EXISTS auto_wacc boolean NOT NULL DEFAULT false;

ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_wacc_inputs_is_object;

ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_wacc_inputs_is_object
    CHECK (wacc_inputs IS NULL OR jsonb_typeof(wacc_inputs) = 'object');

COMMENT ON COLUMN valuation_params.wacc_inputs IS
  'Inputs to engine/wacc.py compute_wacc, keyed exactly as it takes them. Validated against the engine key set by routes/params.ts.';
COMMENT ON COLUMN valuation_params.auto_wacc IS
  'When true the calculation asks the engine to build the WACC from wacc_inputs and use it as the DCF discount rate where no rate was entered by hand. The build-up is recorded on the run either way and printed as Appendix I.';
