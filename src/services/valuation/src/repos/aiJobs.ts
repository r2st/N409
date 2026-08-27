import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { PIPELINE_EVENT_TYPES, type AiPipeline } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';

export interface AiJobRow {
  id: string;
  valuation_id: string;
  pipeline: AiPipeline;
  status: 'running' | 'succeeded' | 'failed';
  model: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  latency_ms: number | null;
  /** Registry prompt version the run used (P1 #8 provenance); null when the
   * pipeline has no registry row or the run predates versioning. */
  prompt_version: number | null;
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export async function createAiJob(
  pool: pg.Pool,
  args: {
    valuationId: string;
    pipeline: AiPipeline;
    input: Record<string, unknown>;
    createdBy: string;
    promptVersion?: number | null;
  },
): Promise<AiJobRow> {
  const { rows } = await pool.query<AiJobRow>(
    `INSERT INTO ai_jobs (id, valuation_id, pipeline, input, created_by, prompt_version)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      newUlid(),
      args.valuationId,
      args.pipeline,
      JSON.stringify(args.input),
      args.createdBy,
      args.promptVersion ?? null,
    ],
  );
  return rows[0]!;
}

/** Marks the job finished and writes the ai_job_completed audit event. */
export async function completeAiJob(
  pool: pg.Pool,
  job: AiJobRow,
  outcome: {
    status: 'succeeded' | 'failed';
    model?: string | null;
    result?: Record<string, unknown> | null;
    error?: string | null;
    latencyMs: number;
  },
  actor: EventActor,
): Promise<AiJobRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<AiJobRow>(
      `UPDATE ai_jobs
       SET status = $2, model = $3, result = $4, error = $5, latency_ms = $6, completed_at = now()
       WHERE id = $1 RETURNING *`,
      [
        job.id,
        outcome.status,
        outcome.model ?? null,
        outcome.result ? JSON.stringify(outcome.result) : null,
        outcome.error ?? null,
        outcome.latencyMs,
      ],
    );
    await recordEvent(client, {
      valuationId: job.valuation_id,
      type: PIPELINE_EVENT_TYPES.aiJobCompleted,
      actor,
      payload: {
        job_id: job.id,
        pipeline: job.pipeline,
        status: outcome.status,
        model: outcome.model ?? null,
        latency_ms: outcome.latencyMs,
      },
    });
    return rows[0]!;
  });
}

/**
 * How long an `ai_jobs` row may sit at `running` before a live worker cannot be
 * the explanation.
 *
 * `runAiPipeline` gives the call a whole-request budget of
 * `AI_PIPELINE_TIMEOUT_MS` (180s, retries included — `postJson` spends one
 * budget across the ladder), and settles the row on both exits. So the only
 * ways past that budget are a process that stopped existing between the two
 * writes, or a settlement write that itself failed. Fifteen minutes is five
 * times the budget: comfortably clear of a slow-but-live run under any
 * scheduling delay, and short enough that the queue-stall alert this feeds
 * still fires on the same day.
 *
 * Not an environment variable, deliberately. It is not a policy choice — it is
 * derived from a constant three files away, and a knob would let the two drift
 * apart with nothing to notice. Whoever moves `AI_PIPELINE_TIMEOUT_MS` moves
 * this with it.
 */
export const AI_JOB_STALE_MS = 15 * 60_000;

/** The system actor the reaper writes its completion events under. */
export const AI_JOB_REAPER_ACTOR: EventActor = {
  actorType: 'system',
  actorId: 'reaper',
  source: 'ai-job-reaper',
};

/**
 * Fail the AI jobs that no worker can still be running.
 *
 * `pipeline_runs` has had a reaper since the auto-pipeline shipped; `ai_jobs`
 * never did, and it is the queue that most needed one. A row is inserted at
 * `running` *before* the AI-service call, and every reader treats that as work
 * in flight: the unified job feed anchors an `ai_job`'s `due_at` at its
 * `created_at`, `oldestActiveJobs` counts anything active and due, and
 * `evaluateJobAlerts` compares that age against the queue's `stall_minutes`.
 * A row orphaned by a restart mid-pipeline — which is every deploy that lands
 * while an extraction is running — therefore ages without bound, holds the
 * `ai_job` queue's stall alert open forever, and reads on the AI tab as a run
 * that is still going. Nothing in the system could ever settle it.
 *
 * Locked and skipped like the pipeline reaper, so two instances split the
 * backlog rather than both writing (and double-eventing) the same rows. The
 * event is the ordinary completion event with `reaped: true` on it: a reader
 * of the audit trail should see that the run ended and see who ended it.
 */
export async function reapStaleAiJobs(
  pool: pg.Pool,
  opts: { olderThanMs?: number; actor?: EventActor; limit?: number } = {},
): Promise<AiJobRow[]> {
  const seconds = Math.max(1, Math.floor((opts.olderThanMs ?? AI_JOB_STALE_MS) / 1000));
  const reason = `job exceeded ${seconds}s while running (reaped)`;
  const actor = opts.actor ?? AI_JOB_REAPER_ACTOR;
  return withTransaction(pool, async (client) => {
    const { rows: stale } = await client.query<AiJobRow>(
      `SELECT * FROM ai_jobs
        WHERE status = 'running'
          AND created_at < now() - ($1 || ' seconds')::interval
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [String(seconds), opts.limit ?? 100],
    );
    const reaped: AiJobRow[] = [];
    for (const job of stale) {
      const { rows } = await client.query<AiJobRow>(
        `UPDATE ai_jobs
            SET status = 'failed', error = $1, completed_at = now()
          WHERE id = $2 RETURNING *`,
        [reason, job.id],
      );
      await recordEvent(client, {
        valuationId: job.valuation_id,
        type: PIPELINE_EVENT_TYPES.aiJobCompleted,
        actor,
        payload: {
          job_id: job.id,
          pipeline: job.pipeline,
          status: 'failed',
          model: null,
          // Null rather than a computed age: `latency_ms` means how long the
          // run took, and nobody knows that. What is known is that it stopped
          // being watched, which `reaped` says.
          latency_ms: null,
          reaped: true,
        },
      });
      reaped.push(rows[0]!);
    }
    return reaped;
  });
}

/**
 * Ceiling on one page of a valuation's agent-run history.
 *
 * Fifty is one busy afternoon: every narrative draft, comp screen and research
 * pass appends a row, and a failed run appends one too. The AI tab reads this
 * list to say what has been run and what it cost, so past the cap it reports a
 * spend and a run count for a subset of the runs while looking complete.
 */
export const AI_JOB_PAGE_LIMIT = 50;

export async function listAiJobs(
  pool: pg.Pool,
  valuationId: string,
  opts: { limit?: number } = {},
): Promise<{ jobs: AiJobRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? AI_JOB_PAGE_LIMIT, 1), AI_JOB_PAGE_LIMIT);
  const { rows } = await pool.query<AiJobRow>(
    'SELECT * FROM ai_jobs WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [valuationId, limit + 1],
  );
  return { jobs: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Most recent successful run of a pipeline — used to seed calculation inputs. */
export async function latestSucceededJob(
  pool: pg.Pool,
  valuationId: string,
  pipeline: AiPipeline,
): Promise<AiJobRow | null> {
  const { rows } = await pool.query<AiJobRow>(
    `SELECT * FROM ai_jobs
     WHERE valuation_id = $1 AND pipeline = $2 AND status = 'succeeded'
     ORDER BY created_at DESC LIMIT 1`,
    [valuationId, pipeline],
  );
  return rows[0] ?? null;
}
