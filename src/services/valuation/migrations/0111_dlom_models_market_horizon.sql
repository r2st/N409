-- Additional DLOM models (409.ai gap: Longstaff / Ghaidarov / restricted-stock
-- studies alongside the existing Chaffee / Finnerty), plus the study-set
-- configuration the empirical model needs.
--
-- The enum grows rather than being replaced: `dlom_method` is on every
-- valuation_params row and referenced by stored calculations, so the existing
-- three values keep their meaning and their ordinals. ADD VALUE cannot be used
-- in the same transaction that reads the new label (the runner wraps each
-- migration in one), and nothing here reads it — the CHECK below names only
-- literals the *column* holds, not the enum — so a single migration is safe.
ALTER TYPE dlom_method ADD VALUE IF NOT EXISTS 'ghaidarov';
ALTER TYPE dlom_method ADD VALUE IF NOT EXISTS 'longstaff';
ALTER TYPE dlom_method ADD VALUE IF NOT EXISTS 'restricted_stock';

-- Study-set configuration for the `restricted_stock` method. All three are
-- nullable and only read when that method is selected:
--
--   dlom_studies     — the study names blended (NULL = the engine's default
--                      post-1997-amendment set)
--   dlom_statistic   — how the selected rows combine ('median' | 'mean')
--   dlom_study_table — a firm's own study table, replacing the engine's
--                      built-in one entirely. Held as JSONB rather than a
--                      table of its own because it is an *input to one
--                      calculation*, not a shared reference set: two
--                      engagements a year apart should be able to disagree
--                      about the table without one rewriting the other's.
ALTER TABLE valuation_params
  ADD COLUMN IF NOT EXISTS dlom_studies     text[],
  ADD COLUMN IF NOT EXISTS dlom_statistic   text,
  ADD COLUMN IF NOT EXISTS dlom_study_table jsonb;

ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dlom_statistic_ck;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dlom_statistic_ck
  CHECK (dlom_statistic IS NULL OR dlom_statistic IN ('median', 'mean'));

-- An empty selection is not "use the default" — it is a set with nothing in
-- it, which the engine refuses. NULL is how "use the default" is spelled.
ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_dlom_studies_ck;
ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_dlom_studies_ck
  CHECK (dlom_studies IS NULL OR cardinality(dlom_studies) > 0);

COMMENT ON COLUMN valuation_params.dlom_studies IS
  'Restricted-stock studies blended for dlom_method = restricted_stock; NULL uses the engine default set.';
COMMENT ON COLUMN valuation_params.dlom_statistic IS
  'How the selected restricted-stock studies combine: median (default) or mean.';
COMMENT ON COLUMN valuation_params.dlom_study_table IS
  'Firm-supplied restricted-stock study table replacing the engine built-ins for this valuation.';
