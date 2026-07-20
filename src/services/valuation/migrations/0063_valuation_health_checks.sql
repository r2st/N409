-- Valuation health checks (domain/healthChecks.ts): a categorized readiness
-- gate run before a report is finalized. Each row is one run against a
-- specific calculation, storing the graded checks (methodology / assumptions /
-- completeness / mathematical / temporal, each error|warning|info|ok), the
-- worst severity, and whether any error blocks finalization.
CREATE TABLE valuation_health_checks (
  id             ulid PRIMARY KEY,
  valuation_id   ulid NOT NULL REFERENCES valuations(id) ON DELETE CASCADE,
  calculation_id ulid NOT NULL REFERENCES calculations(id) ON DELETE CASCADE,
  -- Worst severity across all checks.
  severity       text NOT NULL CHECK (severity IN ('ok','info','warning','error')),
  -- True when at least one check is an error (blocks finalization).
  blocking       boolean NOT NULL DEFAULT false,
  -- Graded check results: [{key,category,label,severity,detail}].
  checks         jsonb NOT NULL DEFAULT '[]',
  -- Per-severity counts: {ok,info,warning,error}.
  counts         jsonb NOT NULL DEFAULT '{}',
  created_by     ulid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX valuation_health_checks_valuation_idx
  ON valuation_health_checks (valuation_id, created_at DESC);
CREATE INDEX valuation_health_checks_calculation_idx
  ON valuation_health_checks (calculation_id, created_at DESC);
