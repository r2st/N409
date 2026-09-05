import type pg from 'pg';
import { FLAGS, flagEnabled, logUnretried } from '@n409/shared';
import {
  claimRetryablePipelineRuns,
  PIPELINE_RETRY_CLAIM_LIMIT,
  setPipelineRunStatus,
} from '../repos/pipelineRuns.js';
import { findValuationById } from '../repos/valuations.js';
import {
  autoPipelineConcurrency,
  resumePipelineRun,
  type AutoPipelineDeps,
} from '../pipeline/autoPipeline.js';

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
}): Promise<{ claimed: number; resumed: number; stranded: number }> {
  // See the note in hooks/emailRetry.ts. Claiming is what spends a run's
  // attempt and moves it to an active status, so refusing to claim leaves the
  // whole backlog recoverable — which matters more here than in the other two
  // ladders, because an active run holds the one-per-valuation index.
  if (!flagEnabled(FLAGS.retryLadders)) return { claimed: 0, resumed: 0, stranded: 0 };

  /*
   * The deployment-wide switch, honoured here as well (R440, methodology M3).
   *
   * `AUTO_PIPELINE=off` shuts both doors that *start* an orchestration: the
   * upload hook returns null on `deps.enabled` before it creates a row, and
   * `POST /valuations/:id/pipeline/runs` answers 422 naming the switch. This
   * sweep is the third door onto the same work and it did not look at it. A run
   * that failed transiently while the pipeline was on keeps its
   * `next_attempt_at`, so flipping the switch off and restarting had the boot
   * sweep claim that backlog and resume it — auto-applying an AI extraction and
   * recording a draft calculation, unattended, on a deployment where the
   * operator has just turned unattended orchestration off. It is also the shape
   * that switch is flipped in: an AI incident, an engine deploy, a cost
   * blow-out. The one thing it must stop is exactly what the sweep then does.
   *
   * The argument is the branch below's, one scope wider — "re-running now would
   * be the switch being ignored, which is worse than the work not being done".
   *
   * BEFORE THE CLAIM, and returning rather than settling, which is the
   * difference between this and that branch. The per-valuation opt-out is a
   * decision somebody made in the product about one engagement and it is not
   * un-made by a restart, so a claimed run is settled `permanent` and taken out
   * of the ladder. A deployment switch is a pause: the rows keep their schedule
   * and their remaining attempts, and turning it back on finds the backlog
   * intact. Same reasoning, and the same shape, as the retry-ladder flag above.
   */
  if (!deps.autoPipeline.enabled) return { claimed: 0, resumed: 0, stranded: 0 };

  const actor = { actorType: 'system', actorId: 'retry-sweep', source: 'auto-pipeline' } as const;

  /*
   * Claim no more than the queue can absorb (round 268, methodology M5).
   *
   * The two rates are not related to each other by anything. This sweep claims
   * twenty every five minutes; the limiter runs four at a time, each of which
   * spends up to three minutes on the AI service and more on the engine. So
   * recovering from an outage adds runs faster than it retires them, and the
   * backlog moves out of `failed` — where the ladder holds it, recoverable, and
   * a restart costs nothing — into `queued`, where it is an in-memory list this
   * process loses on the next deploy and where every row holds its valuation's
   * one-active-run index against any new trigger.
   *
   * Bounded against the *whole* queue rather than this sweep's share of it,
   * because there is one limiter: a burst of uploads is the same pressure and
   * the ladder should give way to it. Nothing is lost by not claiming — the
   * rows keep their schedule and the next tick takes them — which is the same
   * argument the retry-ladder flag above is made of.
   */
  const limit = deps.limit ?? PIPELINE_RETRY_CLAIM_LIMIT;
  const room = Math.max(0, limit - autoPipelineConcurrency().pending);
  if (room === 0) return { claimed: 0, resumed: 0, stranded: 0 };

  const claimed = await claimRetryablePipelineRuns(deps.pool, { limit: room, actor });

  let resumed = 0;
  /*
   * Claimed runs this pass neither resumed nor settled, because something threw
   * while it was deciding which.
   *
   * THE LOOP HAD NO PER-ROW CATCH, and it is the one ladder where that costs
   * more than the row. Claiming is not a read: `claimRetryablePipelineRuns`
   * moves each run to `queued` and clears `next_attempt_at` in the same
   * statement, so by the time this loop sees them they are already out of the
   * ladder's reach. A throw on the third of twenty — `findValuationById` on a
   * pool at its ceiling, `setPipelineRunStatus` losing a deadlock — abandoned
   * the other seventeen in an active status with nothing scheduled to touch
   * them again. This file already says what that costs, twice, about a single
   * row: "an active run holds the one-per-valuation index — so abandoning it
   * silently would block every new trigger for this valuation until the stale
   * reaper came round".
   *
   * Contained per row, so one bad row costs that row. Reported rather than
   * swallowed because the row is genuinely left behind — `logUnretried` for the
   * classified reason and the alert, and the count so the sweep's own log line
   * says how many rows are waiting on the reaper rather than on the limiter.
   */
  let stranded = 0;
  for (const run of claimed) {
    try {
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
    } catch (err) {
      // The row stays `queued` — there is nothing here that could safely settle
      // it, since whatever just failed is the thing that would have to write
      // the settle — so the stale reaper is what eventually frees the
      // valuation's index. Said out loud, because until it comes round that
      // valuation takes no new trigger and nothing else records why.
      logUnretried(
        deps.autoPipeline.log,
        err,
        { runId: run.id, valuationId: run.valuation_id },
        'auto-pipeline retry could not resume a claimed run; it is left active for the stale reaper',
      );
      stranded += 1;
    }
  }
  return { claimed: claimed.length, resumed, stranded };
}
