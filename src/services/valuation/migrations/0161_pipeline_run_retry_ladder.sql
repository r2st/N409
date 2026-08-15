-- An auto-pipeline run that failed because the AI service was down stayed
-- failed, and nothing ever came back for it.
--
-- `executeRun` catches every step failure and writes status 'failed' with the
-- message. That is the correct thing to record, and it is also the end of the
-- story: no sweep reads a failed run, and the only way to get the work done is
-- for somebody to notice the valuation never populated and press the manual
-- trigger. The reaper (`reapStalePipelineRuns`) does not help — it settles runs
-- that are stuck *active*, which is the opposite case.
--
-- So an OpenRouter outage at 02:00 is every upload between 02:00 and whenever
-- it ends arriving as a valuation with no extraction, no parameters and no
-- draft calculation, and no record that anything is owed. The run row is the
-- one thing that survived, and it already carries everything needed to do the
-- work again: the valuation, the document, the trigger and who caused it.
--
-- This is the same ladder the outbox got in 0159 and the webhook deliveries got
-- in 0139, for the same reason and deliberately with the same figures — three
-- subsystems answering the same question about the same kind of upstream should
-- not be three different things to reason about at 03:00.
--
-- One semantic differs from 0159 and it matters. In the outbox, a NULL
-- `next_attempt_at` means "claimable now"; here it means "not scheduled", and a
-- failed run with NULL is one nothing will retry. The inversion is deliberate:
-- an outbox row is *always* worth another try until its ceiling, whereas a
-- pipeline run that failed because the valuation has no params row will fail
-- identically forever, and re-running it is two upstream calls spent to write
-- the same error. Only a transient failure is scheduled, and `failure_kind`
-- records which judgement was made so the decision is auditable rather than
-- implicit in whether a timestamp is set.

ALTER TABLE pipeline_runs
  ADD COLUMN attempts        int NOT NULL DEFAULT 1,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN failure_kind    text CHECK (failure_kind IN ('transient', 'permanent'));

COMMENT ON COLUMN pipeline_runs.attempts IS
  'Execution attempts made, including the first. A fresh run is 1.';
COMMENT ON COLUMN pipeline_runs.next_attempt_at IS
  'Earliest time the retry sweep may re-queue this failed run. NULL means no '
  'retry is scheduled — the failure was permanent, or the ladder is spent.';
COMMENT ON COLUMN pipeline_runs.failure_kind IS
  'How the failure that set status=''failed'' was classified (shared/failure.ts). '
  'NULL for runs that never failed, and for those that failed before 0161.';

-- The sweep's WHERE, exactly. Partial so it indexes only the runs that are
-- actually owed something — on a healthy estate that is zero rows, and the
-- index costs nothing to maintain because a run passes through it at most once.
CREATE INDEX pipeline_runs_retry_idx
  ON pipeline_runs (next_attempt_at)
  WHERE status = 'failed' AND next_attempt_at IS NOT NULL;

-- Rows that already failed keep next_attempt_at NULL, so this migration
-- schedules nothing retroactively. Re-driving a backlog of historical failures
-- on the first boot after a deploy would be a self-inflicted thundering herd
-- against the very services this is meant to protect, and the older ones are
-- long since superseded by manual runs anyway. The ladder starts applying at
-- the next failure.
