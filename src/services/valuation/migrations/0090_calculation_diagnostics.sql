-- Structured engine diagnostics on every calculation run.
--
-- The engine's pre-flight validator (`POST /engine/v1/validate`) reports every
-- problem with a payload at once, each carrying a stable code and a dotted
-- field path. Two things need to outlive the HTTP response:
--
--   * a FAILED run's blocking errors — `error` is a one-line summary, which is
--     no use for pointing an analyst at the six fields they have to fix; and
--   * a SUCCEEDED run's review warnings — a 60% DLOM or a single comparable
--     multiple computes fine but is exactly what a reviewer must sign off on.
--
-- Both are the same shape ({code, field, message, severity, hint}) and differ
-- only by `severity`, so one column carries both. Empty array, never null, so
-- readers never branch on absence.
ALTER TABLE calculations
  ADD COLUMN diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb;
