-- The pre-IPO empirical DLOM family (Emory / Willamette) alongside the
-- restricted-stock studies added in 0111.
--
-- Why a second family rather than more rows in the existing study table: a
-- pre-IPO study measures the discount at which shares changed hands privately
-- in the months before an IPO, against the IPO price. Those discounts run
-- roughly twice the post-1997 restricted-stock ones, and part of the gap is
-- measurement rather than marketability — the sample is companies that went on
-- to complete an IPO, so some of what is observed is the change in prospects
-- over the period. Averaging the two families silently would produce a figure
-- describing neither, which is the same objection migration 0111's engine notes
-- already make about blending across the 1997 Rule 144 amendment. An appraiser
-- who wants both weights them explicitly through `dlom_methods`.
--
-- The enum grows rather than being replaced, for the reason 0111 gives:
-- `dlom_method` is on every valuation_params row and referenced by stored
-- calculations, so the existing values keep their meaning and their ordinals.
-- ADD VALUE cannot be used in the same transaction that reads the new label
-- (the runner wraps each migration in one), and nothing here reads it.
ALTER TYPE dlom_method ADD VALUE IF NOT EXISTS 'pre_ipo';

-- Study-set configuration for the `pre_ipo` method, mirroring the
-- restricted-stock columns above it. Separate columns rather than reusing
-- `dlom_studies` / `dlom_study_table`: the two tables share no study names, so
-- one column could not address both — and the case that matters is exactly the
-- one where both are live, a `dlom_methods` blend weighting a restricted-stock
-- leg against a pre-IPO one, where a shared column would make each leg's
-- selection unrepresentable in the presence of the other.
--
-- `dlom_statistic` IS shared, deliberately: it says how the selected rows
-- combine (median or mean), which is the same question for either table, and a
-- blend concluding on the median of one family and the mean of the other would
-- be a difference nobody chose.
ALTER TABLE valuation_params
  ADD COLUMN IF NOT EXISTS dlom_pre_ipo_studies text[],
  ADD COLUMN IF NOT EXISTS dlom_pre_ipo_table   jsonb;

-- An empty selection is not "use the default" — it is a set with nothing in it,
-- which the engine refuses. NULL is how "use the default" is spelled.
ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dlom_pre_ipo_studies_ck;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dlom_pre_ipo_studies_ck
  CHECK (dlom_pre_ipo_studies IS NULL OR cardinality(dlom_pre_ipo_studies) > 0);

ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dlom_pre_ipo_table_is_array;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dlom_pre_ipo_table_is_array
  CHECK (dlom_pre_ipo_table IS NULL OR jsonb_typeof(dlom_pre_ipo_table) = 'array');

COMMENT ON COLUMN valuation_params.dlom_pre_ipo_studies IS
  'Pre-IPO studies blended for dlom_method = pre_ipo; NULL uses the engine default set (the recent window from each study family plus Emory''s combined figure).';
COMMENT ON COLUMN valuation_params.dlom_pre_ipo_table IS
  'Firm-supplied pre-IPO study table replacing the engine built-ins for this valuation.';
