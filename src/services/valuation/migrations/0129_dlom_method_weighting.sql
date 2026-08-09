-- A marketability discount weighted across several methods.
--
-- The engine could only conclude on one DLOM method. But a marketability
-- discount is the one figure in a 409A with no single defensible derivation:
-- the option models (Chaffee, Finnerty, Ghaidarov, Longstaff) price the cost of
-- being unable to sell from the subject's own volatility and expected holding
-- period, and the restricted-stock studies report the discounts at which
-- restricted shares actually changed hands. Those are evidence of different
-- kinds, and the standard appraisal answer is to weight them rather than to
-- declare one correct — which is what the legacy deliverable's "DLOM Method /
-- Weight / Selected DLOM" table is.
--
-- With one method per run, an appraiser wanting a 50/50 of Finnerty and the
-- studies had to do the arithmetic by hand and enter the result under
-- `dlom_method = 'qualitative'`. That records their calculation as judgement,
-- and leaves the report unable to say where the number came from — the exact
-- opposite of what a weighting table is for.
--
-- Shape: [{"method": "finnerty", "weight": 0.5}, ...], validated by
-- engine/validate.py `_check_dlom_blend` at save time and by
-- engine/compute.py `_blended_dlom` at run time. The weights must sum to 1 and
-- are deliberately not normalised: weights totalling 0.9 are a mistake in
-- somebody's spreadsheet, not an instruction to scale up by a ninth, and
-- rescaling them would conclude on a discount nobody chose. Same rule the four
-- approach weights follow.
--
-- Mutually exclusive with `dlom_method`, enforced below rather than only in the
-- engine: a row carrying both would leave two different answers to "which
-- discount was concluded", and whichever the engine happened to read would be
-- the one the analyst did not mean.
--
-- jsonb rather than a child table. It is a short list read and written whole
-- with the rest of the params, never queried across engagements or joined to,
-- and it lives beside `dlom_study_table` which is jsonb for the same reason.
ALTER TABLE valuation_params
  ADD COLUMN IF NOT EXISTS dlom_methods jsonb;

ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dlom_methods_is_array;

ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dlom_methods_is_array
    CHECK (dlom_methods IS NULL OR jsonb_typeof(dlom_methods) = 'array');

ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_one_dlom_form;

ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_one_dlom_form
    CHECK (dlom_methods IS NULL OR dlom_method IS NULL);

COMMENT ON COLUMN valuation_params.dlom_methods IS
  'Weighted DLOM: [{method, weight}] summing to 1. Mutually exclusive with dlom_method. Weights are never normalised — see migration 0129.';
