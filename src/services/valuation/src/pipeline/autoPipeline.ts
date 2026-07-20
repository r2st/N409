import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { EXTRACTABLE_EXTENSIONS, runAiPipeline } from '../routes/ai.js';
import { buildCalculationInputs, runCalculation } from '../routes/calculations.js';
import { findParams } from '../repos/params.js';
import {
  activePipelineRun,
  createPipelineRun,
  setPipelineRunStatus,
  type PipelineRunRow,
} from '../repos/pipelineRuns.js';
import type { ValuationRow } from '../repos/valuations.js';
import type { DocumentRow } from '../repos/documents.js';
import type { EventActor } from '../events/record.js';
import { Semaphore } from './semaphore.js';

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
 * upstream service calls. Callers are responsible for the no-overlap check.
 */
export async function startPipelineRun(
  deps: AutoPipelineDeps,
  args: {
    valuation: ValuationRow;
    documentId?: string | null;
    trigger: 'upload' | 'manual';
    triggeredBy: string;
  },
): Promise<PipelineRunRow> {
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

async function executeRun(
  deps: AutoPipelineDeps,
  run: PipelineRunRow,
  valuation: ValuationRow,
  triggeredBy: string,
): Promise<void> {
  const actor = actorFor(triggeredBy);
  try {
    run = await setPipelineRunStatus(deps.pool, run, 'extracting');
    await runAiPipeline(
      { pool: deps.pool, aiUrl: deps.aiUrl, documentsDir: deps.documentsDir },
      { valuation, pipeline: 'extract', anonymize: false, autoApply: true, createdBy: triggeredBy, actor },
    );

    run = await setPipelineRunStatus(deps.pool, run, 'calculating');
    const paramsRow = await findParams(deps.pool, valuation.id);
    if (!paramsRow) throw new Error('Valuation has no params row');
    const inputs = await buildCalculationInputs(deps.pool, valuation.id, paramsRow, {});
    await runCalculation(
      { pool: deps.pool, engineUrl: deps.engineUrl },
      { valuation, paramsRow, inputs, createdBy: triggeredBy, actor },
    );

    await setPipelineRunStatus(deps.pool, run, 'ready', { actor });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn({ err, runId: run.id, valuationId: valuation.id }, 'auto-pipeline run failed');
    await setPipelineRunStatus(deps.pool, run, 'failed', { error: message, actor });
  }
}
