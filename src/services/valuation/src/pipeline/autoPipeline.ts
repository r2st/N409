import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { EXTRACTABLE_EXTENSIONS, runAiPipeline } from '../routes/ai.js';
import { classifyInternalError, InternalServiceError, toProblem } from '../clients/internal.js';
import { buildCalculationInputs, runCalculation } from '../routes/calculations.js';
import { findParams } from '../repos/params.js';
import {
  ACTIVE_RUN_STATUSES,
  activePipelineRun,
  createPipelineRun,
  setPipelineRunStatus,
  type PipelineRunRow,
  type PipelineRunStatus,
} from '../repos/pipelineRuns.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import type { DocumentRow } from '../repos/documents.js';
import { logFailure } from '@n409/shared';
import type { EventActor } from '../events/record.js';
import { Semaphore } from './semaphore.js';
import { describeTransportFailure, transportFailureEchoesMessage } from '@n409/shared';

/**
 * Bounds how many auto-pipeline orchestrations execute at once in a single
 * process (B-3 §auto-pipeline). Each run does two blocking upstream calls, so
 * unbounded fan-out under a burst of uploads is a self-inflicted DoS. Runs
 * beyond the cap keep their `queued` row and start when a slot frees.
 * Override with AUTO_PIPELINE_MAX_CONCURRENT.
 */
function envMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AUTO_PIPELINE_MAX_CONCURRENT);
  return Number.isInteger(raw) && raw >= 1 ? raw : 4;
}

const autoPipelineLimiter = new Semaphore(envMaxConcurrent());

/** Live concurrency snapshot — surfaced as a gauge / asserted in tests. */
export function autoPipelineConcurrency(): { active: number; pending: number } {
  return { active: autoPipelineLimiter.activeCount, pending: autoPipelineLimiter.pendingCount };
}

/**
 * The runs this process has queued and not yet started (round 268, M5).
 *
 * `pipeline_runs.updated_at` moves when a run changes status, and a run waiting
 * for a semaphore slot changes nothing: it sits at 'queued', stamped at the
 * moment it was created or claimed, for as long as the queue ahead of it takes.
 * The reaper reads exactly that column, so past
 * `AUTO_PIPELINE_STALE_MINUTES` — thirty by default — it fails a run this
 * process is holding, healthily, and is about to run.
 *
 * That is reachable by arithmetic rather than by mishap. Four slots at a minute
 * or two each drain under three runs a minute; the retry sweep claims twenty
 * every five. So recovering from an AI outage fills the queue faster than it
 * empties, and the tail of the backlog is reaped for a wedge that is not
 * happening — with `auto_pipeline_failed` on the audit spine saying the run
 * "exceeded 1800s in an active state", a rung of its ladder spent, and (since
 * R264) a re-queue that puts it at the back of the same queue to be reaped
 * again.
 *
 * A run that has not been given a slot has not made a single upstream call, so
 * it cannot be the case the reaper exists for. A run that *is* executing is
 * still reaped: wedged on a stuck upstream call is precisely that case, and the
 * `attempts` pin is what makes taking the row away from it safe. And a run
 * orphaned by a restart is in no live process's set at all, which is why this
 * can be read from memory without weakening the guarantee that matters.
 */
const awaitingSlot = new Set<string>();

/** Run ids queued in this process and not yet started. See {@link awaitingSlot}. */
export function pipelineRunsAwaitingSlot(): string[] {
  return [...awaitingSlot];
}

/**
 * Hand a run to the limiter, and hold it in {@link awaitingSlot} until it has a
 * slot. One door for both callers, so a third one cannot forget the bookkeeping
 * and reintroduce the reap.
 */
function queueRun(
  deps: AutoPipelineDeps,
  run: PipelineRunRow,
  valuation: ValuationRow,
  triggeredBy: string,
  crashMessage: string,
): void {
  awaitingSlot.add(run.id);
  void autoPipelineLimiter
    .run(() => {
      // Inside the limiter's callback, which is the moment a slot was granted.
      awaitingSlot.delete(run.id);
      return executeRun(deps, run, valuation, triggeredBy);
    })
    .catch((err) => {
      /*
       * The outermost catch of the platform's core async worker, brought under
       * the alerting contract (R428, methodology M11).
       *
       * It was a hand-picked `error` with no classification and no
       * `alert: true`, which `shared/failure.ts` makes into two separate
       * problems. The level is over-severe for the ordinary case — a pool blip
       * while `executeRun` settles the row is transient and the reaper is
       * coming — and the field that decides whether a ticket fires was absent
       * for the case that only a person fixes. Since R376 `alert: true` is
       * counted at the logger as `log_alert_lines_total`, so this is the
       * difference between `PermanentFailuresLogged` firing and a line nobody
       * reads. R273's rule for a catch like this: inside a retry loop, use
       * `logFailure`; where nothing revisits the work, `logUnretried`; a
       * hand-picked level is neither.
       *
       * `logFailure`, because something does come back. Reaching here means
       * `executeRun`'s own catch could not record the failure, so the row is
       * left in an active status holding its valuation's one-active-run index
       * — and `reapStalePipelineRuns` settles exactly that shape, stamping
       * `failure_kind = 'transient'` and a `next_attempt_at` the retry sweep
       * reads. That is a real retry, so a transient error grading down to
       * `warn` is honest.
       *
       * `failure_reason` is the other half: the classified token (`pg.40P01`)
       * is what says whether this was one deploy's pool teardown or a
       * statement that will fail identically every time, and the error's own
       * sentence never made it into a field anything can group by.
       */
      logFailure(deps.log, err, { runId: run.id, valuationId: run.valuation_id }, crashMessage);
    })
    // Belt and braces: a rejection *from the acquire* would never reach the
    // callback, and a run left in this set is a run the reaper can never take.
    .finally(() => awaitingSlot.delete(run.id));
}

/**
 * Auto-pipeline orchestrator (final-status §4.4 #3): when a document lands,
 * run extraction → parameter auto-apply → draft calculation unattended so ops
 * opens an already-populated valuation. Each step reuses the exact same code
 * path as its interactive route (runAiPipeline / runCalculation), so the jobs,
 * calculations, and audit events it produces are indistinguishable from a
 * human-clicked run — the pipeline_runs row is only the orchestration status.
 */
export interface AutoPipelineDeps {
  pool: pg.Pool;
  aiUrl: string;
  engineUrl: string;
  documentsDir: string;
  /** Global switch (AUTO_PIPELINE env); per-valuation opt-out is valuations.auto_pipeline. */
  enabled: boolean;
  log: FastifyBaseLogger;
}

function actorFor(triggeredBy: string): EventActor {
  return { actorType: 'system', actorId: triggeredBy, source: 'auto-pipeline' };
}

/** Same gate as the interactive extract route: only text-extractable uploads trigger. */
export function isExtractable(doc: Pick<DocumentRow, 'filename'>): boolean {
  return EXTRACTABLE_EXTENSIONS.has(path.extname(doc.filename).toLowerCase());
}

/**
 * Upload hook: starts a run if the global switch and the valuation's opt-in
 * both hold and the upload can actually feed extraction. Returns the run row
 * (status 'queued') or null when nothing was started — the upload response
 * carries it so the client can start polling immediately.
 */
export async function maybeStartAutoPipeline(
  deps: AutoPipelineDeps,
  args: { valuation: ValuationRow; document: DocumentRow; triggeredBy: string },
): Promise<PipelineRunRow | null> {
  if (!deps.enabled || !args.valuation.auto_pipeline) return null;
  if (!isExtractable(args.document)) return null;
  if (await activePipelineRun(deps.pool, args.valuation.id)) return null;
  return startPipelineRun(deps, {
    valuation: args.valuation,
    documentId: args.document.id,
    trigger: 'upload',
    triggeredBy: args.triggeredBy,
  });
}

/**
 * Creates the run row and kicks off the orchestration WITHOUT awaiting it —
 * the caller (an upload or manual-trigger request) must not block on two
 * upstream service calls.
 *
 * Returns null when the valuation already has an active run. The caller's
 * `activePipelineRun` pre-check catches that in the ordinary case; this returns
 * null for the triggers that raced past it, which the database rejects.
 */
export async function startPipelineRun(
  deps: AutoPipelineDeps,
  args: {
    valuation: ValuationRow;
    documentId?: string | null;
    trigger: 'upload' | 'manual';
    triggeredBy: string;
  },
): Promise<PipelineRunRow | null> {
  const run = await createPipelineRun(
    deps.pool,
    {
      valuationId: args.valuation.id,
      documentId: args.documentId ?? null,
      trigger: args.trigger,
      triggeredBy: args.triggeredBy,
    },
    actorFor(args.triggeredBy),
  );
  if (!run) return null;
  // Fire-and-forget, but gated by the concurrency limiter: the run row returns
  // immediately (status 'queued'); execution waits for a free slot so a burst
  // of uploads can't spawn unbounded concurrent orchestrations.
  //
  // The crash message covers only a failure to *record* a status: executeRun
  // already converts step failures into a 'failed' run.
  queueRun(deps, run, args.valuation, args.triggeredBy, 'auto-pipeline run crashed');
  return run;
}

/**
 * A run only keeps going while its row is still active *and still this worker's
 * attempt*. It can be settled out from under the worker — reaped as stale, or
 * cascade-deleted with its valuation — while the worker waits for a concurrency
 * slot or sits on an upstream call. Carrying on then spends two upstream calls
 * on an orchestration nobody is watching and ends by writing 'ready' over a
 * closed audit trail.
 *
 * The second half of the question is what "active" alone cannot answer. A
 * reaped run is re-queued in place by the retry ladder — same row, `attempts`
 * incremented, a new worker on it — so a wedged worker that returns after the
 * reap finds a row that is active again and reads that as permission to carry
 * on. Two orchestrations then run the same valuation, and the one that finishes
 * first writes the other's ending. `setPipelineRunStatus` refuses the write on
 * the `attempts` pin, but it hands back the *current* row either way, so this
 * has to compare generations rather than trust that a returned row means the
 * write landed.
 */
async function advance(
  deps: AutoPipelineDeps,
  run: PipelineRunRow,
  status: PipelineRunStatus,
): Promise<PipelineRunRow | null> {
  const next = await setPipelineRunStatus(deps.pool, run, status);
  const mine = next !== null && next.attempts === run.attempts;
  if (mine && ACTIVE_RUN_STATUSES.has(next.status)) return next;
  deps.log.info(
    {
      runId: run.id,
      valuationId: run.valuation_id,
      attempted: status,
      status: next?.status ?? 'deleted',
      attempt: run.attempts,
      // Names which of the two abandonments this is: the run ended, or it was
      // handed to a later attempt while this worker was away.
      live_attempt: next?.attempts ?? null,
    },
    'auto-pipeline run settled out from under its worker; abandoning',
  );
  return null;
}

/**
 * What `pipeline_runs.error` is set to when a run fails.
 *
 * That column is not an internal note. It rides out on
 * `GET /api/v1/valuations/{id}/pipeline` as part of the run object, so whatever
 * goes in it is a message to whoever asks — and it was `err.message`, which for
 * the errors that actually reach here is `InternalServiceError`'s
 * `${service}: ${detail}`. `detail` on an opaque upstream body is the raw body:
 * a FastAPI traceback with its file paths, or a proxy's HTML page. R181 built
 * the `opaque` flag precisely so those never reach a caller and taught
 * `toProblem` to honour it — and this path never went through `toProblem`, so
 * the same body it withholds from the response was stored in a field the
 * response hands over anyway.
 *
 * Routing it through `toProblem` fixes both halves at once and keeps them fixed
 * together: the stored sentence is now the same one the synchronous route would
 * have answered with, remedy included, and the withholding is the same
 * withholding rather than a second copy of the rule.
 *
 * A non-upstream failure — a missing params row, a bug — has no upstream body to
 * withhold and no house sentence worth substituting, so it keeps its own
 * message, with `describeTransportFailure` covering the case where that message
 * is `fetch failed`.
 */
function runFailureMessage(err: unknown): string {
  if (err instanceof InternalServiceError) return toProblem(err).detail ?? err.message;
  if (!transportFailureEchoesMessage(err)) return describeTransportFailure(err);
  return 'The pipeline step failed unexpectedly';
}

async function executeRun(
  deps: AutoPipelineDeps,
  run: PipelineRunRow,
  valuation: ValuationRow,
  triggeredBy: string,
): Promise<void> {
  const actor = actorFor(triggeredBy);
  try {
    /*
     * The engagement as it stands now, not as it stood when the run was queued.
     *
     * Two waits sit between the decision to run and this line, and neither is
     * short. `startPipelineRun` returns the moment the row exists and hands
     * execution to a semaphore of four; the retry sweep releases a whole
     * recovered backlog into that same semaphore at once. A run can therefore
     * wait out every run ahead of it — each of which spends up to three minutes
     * on the AI service and more on the engine — before it does anything.
     *
     * `hooks/pipelineRetry.ts` already refuses to resume a run whose engagement
     * has been retired since it failed, and says why: auto-applying an AI
     * extraction and recording a calculation against a withdrawn engagement is
     * a write every button in the product has stopped accepting. But that check
     * runs at *claim* time and then puts the run in the queue, so the whole
     * wait is a window in which the thing it guards against can happen. The
     * upload path is the same shape one step earlier — the route's
     * `refuseIfRetired` fires before the file lands, and nothing looks again.
     *
     * Re-read here, immediately before the first upstream call, so the guard
     * holds where the write happens rather than where the decision was made.
     * The run also stops carrying a copy of the engagement that is as old as
     * the queue: the name, kind and currency that go to the AI service and into
     * the calculation are the ones on file now.
     */
    const live = await findValuationById(deps.pool, run.valuation_id);
    if (!live) {
      // Deleted while the run waited; its row went with it (cascade), so there
      // is nothing left to settle and `advance` would find nothing either.
      deps.log.info(
        { runId: run.id, valuationId: run.valuation_id },
        'auto-pipeline run abandoned — the valuation was deleted while it was queued',
      );
      return;
    }
    if (live.archived_at !== null) {
      // Settled rather than abandoned, for `hooks/pipelineRetry.ts`'s reason:
      // an active run holds the one-per-valuation index, so a run left in place
      // blocks every later trigger until the stale reaper comes round. And
      // `permanent`, because retirement is a decision rather than an outage —
      // a restore hands back an engagement that deserves a fresh run, not this
      // one.
      await setPipelineRunStatus(deps.pool, run, 'failed', {
        error: 'the engagement was retired before the run started',
        actor,
        failure: { kind: 'permanent', reason: 'valuation.retired', retryable: false },
      });
      deps.log.info(
        { runId: run.id, valuationId: live.id },
        'auto-pipeline run skipped — the engagement was retired while it was queued',
      );
      return;
    }
    valuation = live;

    const extracting = await advance(deps, run, 'extracting');
    if (!extracting) return;
    run = extracting;
    await runAiPipeline(
      { pool: deps.pool, aiUrl: deps.aiUrl, documentsDir: deps.documentsDir, log: deps.log },
      { valuation, pipeline: 'extract', anonymize: false, autoApply: true, createdBy: triggeredBy, actor },
    );

    const calculating = await advance(deps, run, 'calculating');
    if (!calculating) return;
    run = calculating;

    /*
     * The same question again, because the answer can have changed since the
     * last time it was asked.
     *
     * The re-read above holds the guard at the extraction, and `runAiPipeline`
     * asks it a third time immediately before applying engine inputs — because
     * the AI service is given up to three minutes and a decision about a file
     * is exactly the kind of thing that gets made inside three minutes. That
     * left the step after it, which is the heavier write of the two: a
     * calculation is a concluded fair market value, recorded with an audit
     * event, on an engagement the firm has withdrawn. `runCalculation` is the
     * shared function the interactive route calls after its own
     * `refuseIfRetired`, so it does not carry one itself, and this caller went
     * through no route at all.
     *
     * Settled `permanent` like the pre-start branch, for the same reason: an
     * active run holds the one-per-valuation index, and a restore deserves a
     * fresh run rather than the tail of this one. The extraction that already
     * ran keeps its job row, which is accurate — it happened.
     */
    const stillLive = await findValuationById(deps.pool, run.valuation_id);
    if (!stillLive) {
      deps.log.info(
        { runId: run.id, valuationId: run.valuation_id },
        'auto-pipeline run abandoned — the valuation was deleted while it was extracting',
      );
      return;
    }
    if (stillLive.archived_at !== null) {
      await setPipelineRunStatus(deps.pool, run, 'failed', {
        error: 'the engagement was retired while the run was extracting',
        actor,
        failure: { kind: 'permanent', reason: 'valuation.retired', retryable: false },
      });
      deps.log.info(
        { runId: run.id, valuationId: stillLive.id },
        'auto-pipeline run stopped — the engagement was retired while it was extracting',
      );
      return;
    }
    valuation = stillLive;

    const paramsRow = await findParams(deps.pool, valuation.id);
    if (!paramsRow) throw new Error('Valuation has no params row');
    const inputs = await buildCalculationInputs(deps.pool, valuation.id, paramsRow, {}, deps.log);
    await runCalculation(
      { pool: deps.pool, engineUrl: deps.engineUrl },
      { valuation, paramsRow, inputs, createdBy: triggeredBy, actor },
    );

    await setPipelineRunStatus(deps.pool, run, 'ready', { actor });
  } catch (err) {
    const message = runFailureMessage(err);
    // Classify before recording: `setPipelineRunStatus` stamps the retry
    // schedule from this, and a run recorded without it is a run nothing will
    // ever come back for (migration 0161).
    //
    // `classifyInternalError` rather than the bare shared classifier because
    // the failures that reach here are overwhelmingly `InternalServiceError`,
    // which carries the upstream status — and the whole distinction this makes
    // is between the AI service being down (retry) and it rejecting our payload
    // (do not). Anything else — a missing params row, a bug — falls through to
    // the shared table, whose default is permanent, so a run is only ever
    // rescheduled on a positive judgement that it should be.
    const failure = classifyInternalError(err);
    const level = failure.kind === 'transient' ? 'warn' : 'error';
    deps.log[level](
      {
        err,
        runId: run.id,
        valuationId: valuation.id,
        failure_kind: failure.kind,
        failure_reason: failure.reason,
        // A permanent failure is not going to fix itself and no retry is
        // coming; it is the one that wants a person.
        ...(failure.kind === 'permanent' ? { alert: true } : {}),
      },
      'auto-pipeline run failed',
    );
    await setPipelineRunStatus(deps.pool, run, 'failed', { error: message, actor, failure });
  }
}

/**
 * Re-execute a run the retry sweep has already claimed.
 *
 * Separate entry point from `startPipelineRun` because the row exists and is
 * already back on 'queued' — creating a second one would both lose the attempt
 * count and collide with the one-active-run index. Everything downstream is the
 * ordinary path: same limiter, same `executeRun`, so a retried orchestration is
 * indistinguishable from a first attempt except in the audit payload.
 */
export function resumePipelineRun(
  deps: AutoPipelineDeps,
  run: PipelineRunRow,
  valuation: ValuationRow,
): void {
  queueRun(deps, run, valuation, run.triggered_by ?? 'retry-sweep', 'auto-pipeline retry crashed');
}
