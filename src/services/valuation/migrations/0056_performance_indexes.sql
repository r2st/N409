-- Performance indexes (IMPROVEMENTS_RESEARCH §6.9) matched to the hottest
-- real queries:
--   latestSucceededJob (repos/aiJobs.ts) filters valuation+pipeline+succeeded
--   on every calculation build — the generic (valuation_id, created_at) index
--   still has to skip failed/running rows and other pipelines.
CREATE INDEX ai_jobs_latest_succeeded_idx
  ON ai_jobs (valuation_id, pipeline, created_at DESC)
  WHERE status = 'succeeded';

--   latestSucceededCalculation (repos/calculations.ts) backs the scenario
--   sandbox, per-approach recalc and the QA gate.
CREATE INDEX calculations_latest_succeeded_idx
  ON calculations (valuation_id, created_at DESC)
  WHERE status = 'succeeded';

--   The ops valuation list defaults to ORDER BY created_at DESC with no
--   filter (repos/valuations.ts) — full sort without this.
CREATE INDEX valuations_created_idx ON valuations (created_at DESC);
