-- Stage of enterprise development (AICPA practice aid, six-stage scale).
--
-- The practice aid frames the whole valuation around where a company sits on
-- this scale: it is what justifies weighting the market approach over the
-- income approach, reaching for a backsolve rather than a DCF, and concluding a
-- marketability discount at the top of the supportable range rather than the
-- bottom. A reviewing auditor looks for it stated explicitly, and a 409A that
-- never names it leaves the reader to infer the premise every other choice in
-- the report rests on.
--
-- Stored rather than derived because it is a judgement the analyst signs.
-- `domain/developmentStage.ts` proposes one from the revenue status and the
-- projections, and deliberately does not apply it: the line between stage 4 and
-- stage 5 is whether this company's cash flow is *sustainably* positive, which
-- is a question about the business rather than about whether a forecast row
-- happens to be above zero.
--
-- Nullable, because it is: an engagement that has not reached the methodology
-- discussion has no concluded stage, and a default of 1 would be the platform
-- asserting one on the analyst's behalf.
ALTER TABLE valuation_params
  ADD COLUMN IF NOT EXISTS development_stage smallint
    CHECK (development_stage IS NULL OR development_stage BETWEEN 1 AND 6);

COMMENT ON COLUMN valuation_params.development_stage IS
  'AICPA stage of enterprise development, 1-6 (see domain/developmentStage.ts). NULL until the analyst concludes one; never inferred automatically.';
