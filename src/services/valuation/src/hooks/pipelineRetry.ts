import type pg from 'pg';
import { FLAGS, flagEnabled } from '@n409/shared';
import { claimRetryablePipelineRuns, setPipelineRunStatus } from '../repos/pipelineRuns.js';
import { findValuationById } from '../repos/valuations.js';
import { resumePipelineRun, type AutoPipelineDeps } from '../pipeline/autoPipeline.js';

/**
 * Re-runs auto-pipeline orchestrations that failed against a dependency which
 * has since recovered.
 *
 * This is the "later retry" the failure path has always implied and nothing
 * ever performed — see migration 0161. `executeRun` records a failed run with a
 * classification and, when the failure was transient, a `next_attempt_at`; this
 * sweep is what reads that column.
 *
 * The three parts are deliberately in three places, matching the outbox:
 *
 *   - the *ladder* is `domain/pipelineRetry.ts`, pure and table-tested;
 *   - the *claim* is `claimRetryablePipelineRuns`, which is what makes two
 *     instances split the backlog rather than duplicate it;
 *   - this is only the driver, and it is deliberately thin.
 *
 * Note what it does not do: it does not await the runs. `resumePipelineRun`
 * hands each one to the same concurrency limiter the upload path uses, so a
 * backlog of forty runs released by a recovered AI service executes four at a
 * time rather than forty — the limiter is the only thing standing between "the
 * outage ended" and "we re-created the load that ended it".
 */
export async function retryFailedPipelineRuns(deps: {
  pool: pg.Pool;
  autoPipeline: AutoPipelineDeps;
  limit?: number;
}): Promise<{ claimed: number; resumed: number }> {
  // See the note in hooks/emailRetry.ts. Claiming is what spends a run's
  // attempt and moves it to an active status, so refusing to claim leaves the
  // whole backlog recoverable — which matters more here than in the other two
  // ladders, because an active run holds the one-per-valuation index.
  if (!flagEnabled(FLAGS.retryLadders)) return { claimed: 0, resumed: 0 };

  const actor = { actorType: 'system', actorId: 'retry-sweep', source: 'auto-pipeline' } as const;
  const claimed = await claimRetryablePipelineRuns(deps.pool, { limit: deps.limit, actor });

  let resumed = 0;
  for (const run of claimed) {
    const valuation = await findValuationById(deps.pool, run.valuation_id);
    if (!valuation) {
      // The valuation was deleted between the failure and the retry. The run
      // row is cascade-deleted with it, so there is nothing left to settle —
      // and nothing to log about either, since this is the ordinary outcome of
      // deleting a valuation that had a failed run.
      continue;
    }
    if (valuation.archived_at !== null) {
      // THE HOLE THIS CLOSES. `POST /valuations/:id/pipeline/runs` refuses a
      // retired engagement and the upload that would start one is refused
      // before the file lands — but a run that failed *before* the firm
      // withdrew the work sat in the ladder with a `next_attempt_at`, and this
      // sweep would resume it afterwards. Resuming means auto-applying an AI
      // extraction and recording a calculation against an engagement every
      // button in the product has stopped accepting changes to. A guard on the
      // route is not a guard on the timer that performs the same write.
      //
      // Settled for the same reason as the opt-out below: the claim has
      // already moved this run to an active status, and an active run holds
      // the one-per-valuation index. `permanent`, because retirement is a
      // decision rather than an outage — and if it is reversed, the restore
      // gives back an engagement that takes a fresh run, not this stale one.
      await setPipelineRunStatus(deps.pool, run, 'failed', {
        error: 'the engagement was retired before the retry ran',
        actor,
        failure: { kind: 'permanent', reason: 'valuation.retired', retryable: false },
      });
      deps.autoPipeline.log.info(
        { runId: run.id, valuationId: valuation.id },
        'auto-pipeline retry skipped — the engagement has been retired since it failed',
      );
      continue;
    }
    if (!valuation.auto_pipeline) {
      // Somebody turned the orchestration off for this valuation while the run
      // was waiting. Honour that: re-running now would be the switch being
      // ignored, which is worse than the work not being done.
      //
      // Settled here rather than left on 'queued'. The claim has already moved
      // it to an active status, and an active run holds the one-per-valuation
      // index — so abandoning it silently would block every new trigger for
      // this valuation until the stale reaper came round, which is up to
      // AUTO_PIPELINE_STALE_MINUTES of a valuation that cannot be re-run.
      // Recorded `permanent` so the ladder does not schedule it again: the
      // opt-out is a decision, not an outage.
      await setPipelineRunStatus(deps.pool, run, 'failed', {
        error: 'auto-pipeline was disabled for this valuation before the retry ran',
        actor,
        failure: { kind: 'permanent', reason: 'pipeline.opted-out', retryable: false },
      });
      deps.autoPipeline.log.info(
        { runId: run.id, valuationId: valuation.id },
        'auto-pipeline retry skipped — the valuation has opted out since it failed',
      );
      continue;
    }
    resumePipelineRun(deps.autoPipeline, run, valuation);
    resumed += 1;
  }
  return { claimed: claimed.length, resumed };
}
