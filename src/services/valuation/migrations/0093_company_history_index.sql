-- Three of the platform's "how has this company moved?" features — the
-- analytics time series (routes/analytics.ts), the FMV trend on the report
-- summary page (routes/reports.ts) and the bridge candidate list
-- (routes/bridge.ts) — all find a company's other valuations with the same
-- normalised-name predicate:
--
--   WHERE v.user_id = $1 AND lower(trim(v.company_name)) = lower(trim($2))
--
-- `valuations_company_idx (company_name text_pattern_ops)` cannot serve that:
-- the lower(trim(...)) wrapper makes the column reference an expression, so
-- Postgres falls back to a scan of every valuation the user owns and applies
-- the function per row. On a firm with a long book that is the whole table.
--
-- An expression index matching the predicate exactly turns all three into
-- index lookups. Leading with user_id keeps the same index useful for the
-- ownership filter alone.
CREATE INDEX valuations_owner_company_normalized_idx
  ON valuations (user_id, (lower(trim(company_name))));
