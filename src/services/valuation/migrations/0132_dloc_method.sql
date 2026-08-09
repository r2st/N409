-- A derived discount for lack of control (engine dloc.py).
--
-- `dloc` has been a bare numeric since the first migration: a figure an analyst
-- typed, applied as-is, and reported with no derivation behind it — while the
-- DLOM in the column beside it accumulated four option models, two study
-- families and a weighting scheme. That asymmetry is not a reflection of the
-- appraisal literature; it is what got built first. It also made one whole
-- class of error unrepresentable, which is the real reason to fix it: with no
-- method recorded, nothing could distinguish a discount an appraiser derived
-- from a control premium from one they picked, and nothing could say what level
-- of value it was struck on.
--
-- Three methods, matching engine `dloc.DLOC_METHODS`:
--
--   control_premium — the appraiser states the premium, the engine inverts it
--                     (DLOC = 1 − 1/(1+CP)). The two are the same fact from
--                     opposite sides and the conversion is not symmetric: 25%
--                     one way is 20% the other, and subtracting the premium
--                     instead is the arithmetic slip this method prevents.
--   studies         — blend published control-premium observations, then invert
--                     once, on the premium scale.
--   qualitative     — the analyst's own figure, recorded as judgement rather
--                     than dressed as a derivation.
--
-- NULL stays legal and stays the default: it means `dloc` is applied as a
-- stated figure, which is what every row written before today does. A
-- recalculation of an engagement concluded last year must not change its number
-- because the engine grew a method vocabulary since.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dloc_method') THEN
    CREATE TYPE dloc_method AS ENUM ('control_premium', 'studies', 'qualitative');
  END IF;
END $$;

ALTER TABLE valuation_params
  ADD COLUMN IF NOT EXISTS dloc_method        dloc_method,
  ADD COLUMN IF NOT EXISTS control_premium    numeric(8, 6),
  ADD COLUMN IF NOT EXISTS dloc_synergy_share numeric(6, 5),
  ADD COLUMN IF NOT EXISTS dloc_studies       text[],
  ADD COLUMN IF NOT EXISTS dloc_statistic     text,
  ADD COLUMN IF NOT EXISTS dloc_study_table   jsonb;

-- A premium is unbounded above — 100%+ premiums are observed — so only the sign
-- is constrained. A negative one is a discount paid for control, which is a
-- finding about that transaction rather than evidence for a DLOC, and the
-- inversion would silently read it as a premium.
ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_control_premium_ck;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_control_premium_ck
  CHECK (control_premium IS NULL OR control_premium >= 0);

-- The share of an observed acquisition premium attributable to synergies rather
-- than to control, removed before the inversion. 1.0 is excluded: all of the
-- premium being synergy says control is worth nothing, which is a conclusion
-- about that transaction rather than an adjustment to it.
ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dloc_synergy_share_ck;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dloc_synergy_share_ck
  CHECK (dloc_synergy_share IS NULL OR (dloc_synergy_share >= 0 AND dloc_synergy_share < 1));

ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dloc_statistic_ck;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dloc_statistic_ck
  CHECK (dloc_statistic IS NULL OR dloc_statistic IN ('median', 'mean'));

-- Same rule as the DLOM study columns: an empty selection is not "use the
-- default", it is a set with nothing in it, which the engine refuses. NULL is
-- how "use the default" is spelled.
ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dloc_studies_ck;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dloc_studies_ck
  CHECK (dloc_studies IS NULL OR cardinality(dloc_studies) > 0);

ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dloc_study_table_is_array;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dloc_study_table_is_array
  CHECK (dloc_study_table IS NULL OR jsonb_typeof(dloc_study_table) = 'array');

COMMENT ON COLUMN valuation_params.dloc_method IS
  'How the discount for lack of control was derived. NULL applies dloc as a stated figure, which is what every row written before migration 0132 does.';
COMMENT ON COLUMN valuation_params.control_premium IS
  'The control premium for dloc_method = control_premium, as a fraction. Inverted to a discount by the engine: DLOC = 1 - 1/(1+CP).';
COMMENT ON COLUMN valuation_params.dloc_synergy_share IS
  'Share of the observed acquisition premium attributed to synergies rather than to control, removed before the inversion. An observed premium impounds what the buyer expected to do with the target as well as the value of control itself.';
COMMENT ON COLUMN valuation_params.dloc_studies IS
  'Control-premium studies blended for dloc_method = studies; NULL uses the engine default set.';
COMMENT ON COLUMN valuation_params.dloc_study_table IS
  'Firm-supplied control-premium table ({study, premium} rows) replacing the engine built-ins. The built-ins are decade summaries, not an extraction for the subject''s own industry and period, and a conclusion resting on them is flagged.';
