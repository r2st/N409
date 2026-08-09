-- A firm's own required-rate-of-return ladder by stage of development.
--
-- Appendix III prints the indicative required returns the venture capital
-- literature reports by stage, so a reviewer can read the concluded discount
-- rate against what is expected of a company at that stage. The built-in ladder
-- (domain/requiredReturns.ts) is stage-banded ranges from the published
-- literature — Plummer, Scherlis & Sahlman, as reproduced in the standard texts
-- and echoed by the AICPA practice aid whose six-stage scale the platform
-- already uses.
--
-- Those built-ins are a default, not a fact of the platform. A firm holding a
-- subscription to an annual survey — the Pepperdine Private Capital Markets
-- Report and its peers — has figures on its own cut of the market, revised every
-- year, and should conclude on those rather than on a table compiled here. The
-- built-ins exist so a report can carry the corroboration without a
-- subscription, not to settle which figures are authoritative.
--
-- Deliberately not seeded from any one survey's edition. A vintage hardcoded
-- into a migration goes stale silently while continuing to carry that survey's
-- name in a document somebody relies on, which is worse than carrying ranges
-- that describe themselves as literature ranges.
--
-- Shape: [{"stage": 1, "category": "Seed / start-up", "low": 0.5, "high": 0.7}],
-- validated by routes/params.ts at save time and by domain/requiredReturns.ts
-- `requiredReturnBands` at render time. Stage is the AICPA 1–6 scale, and low
-- and high are fractions with low <= high.
--
-- jsonb rather than a child table, for the same reason `dlom_study_table` is:
-- it is a short list read and written whole with the rest of the params, never
-- queried across engagements or joined to.
ALTER TABLE valuation_params
  ADD COLUMN IF NOT EXISTS required_return_table jsonb;

ALTER TABLE valuation_params
  DROP CONSTRAINT IF EXISTS valuation_params_required_return_table_is_array;

ALTER TABLE valuation_params
  ADD CONSTRAINT valuation_params_required_return_table_is_array
    CHECK (required_return_table IS NULL OR jsonb_typeof(required_return_table) = 'array');

COMMENT ON COLUMN valuation_params.required_return_table IS
  'Firm''s own required-return ladder: [{stage, category, low, high}]. NULL means the built-in literature ranges — see migration 0130.';
