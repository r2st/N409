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
import type { ValuationRow } from '../repos/valuations.js';
import type { DocumentRow } from '../repos/documents.js';
import type { EventActor } from '../events/record.js';
import { Semaphore } from './semaphore.js';
import { describeTransportFailure } from '@n409/shared';

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
  void autoPipelineLimiter
    .run(() => executeRun(deps, run, args.valuation, args.triggeredBy))
    .catch((err) => {
      // executeRun already converts step failures into a 'failed' run; this only
      // catches a failure to record that status (e.g. the pool going away).
      deps.log.error({ err, runId: run.id }, 'auto-pipeline run crashed');
    });
  return run;
}

/**
 * A run only keeps going while its row is still active. It can be settled out
 * from under the worker — reaped as stale, or cascade-deleted with its
 * valuation — while the worker waits for a concurrency slot or sits on an
 * upstream call. Carrying on then spends two upstream calls on an orchestration
 * nobody is watching and ends by writing 'ready' over a closed audit trail.
 */
async function advance(
  deps: AutoPipelineDeps,
  run: PipelineRunRow,
  status: PipelineRunStatus,
): Promise<PipelineRunRow | null> {
  const next = await setPipelineRunStatus(deps.pool, run, status);
  if (next !== null && ACTIVE_RUN_STATUSES.has(next.status)) return next;
  deps.log.info(
    {
      runId: run.id,
      valuationId: run.valuation_id,
      attempted: status,
      status: next?.status ?? 'deleted',
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
  return describeTransportFailure(err);
}

async function executeRun(
  deps: AutoPipelineDeps,
  run: PipelineRunRow,
  valuation: ValuationRow,
  triggeredBy: string,
): Promise<void> {
  const actor = actorFor(triggeredBy);
  try {
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
    const paramsRow = await findParams(deps.pool, valuation.id);
    if (!paramsRow) throw new Error('Valuation has no params row');
    const inputs = await buildCalculationInputs(deps.pool, valuation.id, paramsRow, {});
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
  const triggeredBy = run.triggered_by ?? 'retry-sweep';
  void autoPipelineLimiter
    .run(() => executeRun(deps, run, valuation, triggeredBy))
    .catch((err) => {
      deps.log.error({ err, runId: run.id }, 'auto-pipeline retry crashed');
    });
}
