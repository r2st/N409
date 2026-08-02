-- The auto-pipeline has always documented "no overlapping orchestration" —
-- `maybeStartAutoPipeline` and the manual-trigger route both call
-- `activePipelineRun` before starting one. But that check is a SELECT that runs
-- before, and outside the transaction of, the INSERT that creates the run. Two
-- triggers that interleave between those statements both see "no active run"
-- and both start:
--
--   A: SELECT active -> none
--   B: SELECT active -> none          (A has not inserted yet)
--   A: INSERT run 1
--   B: INSERT run 2
--
-- and that is not a narrow window: an upload hook and an ops click, or two
-- uploads landing together, are the ordinary case. Both runs then extract with
-- auto-apply against the same params row and both write a calculation, so the
-- valuation ends up with whichever ordering the two races produced and an audit
-- trail showing two interleaved orchestrations. Nothing in a single process
-- fixes it either — N409 runs several units against one database.
--
-- A partial unique index makes the invariant the database's, so the losing
-- INSERT fails with 23505 no matter which process or replica issued it. The
-- pre-flight SELECT stays as the friendly path; this is the backstop.
--
-- Any rows the old race already created have to go first, or the index cannot
-- be built. Newest active run per valuation wins — it is the one the UI has
-- been polling — and the rest are closed as superseded.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY valuation_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM pipeline_runs
   WHERE status IN ('queued', 'extracting', 'calculating')
)
UPDATE pipeline_runs r
   SET status     = 'failed',
       error      = 'superseded by a concurrent run for the same valuation',
       updated_at = now()
  FROM ranked
 WHERE r.id = ranked.id
   AND ranked.rn > 1;

CREATE UNIQUE INDEX pipeline_runs_one_active_per_valuation_idx
  ON pipeline_runs (valuation_id)
  WHERE status IN ('queued', 'extracting', 'calculating');
