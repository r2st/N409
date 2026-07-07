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

export async function listAiJobs(pool: pg.Pool, valuationId: string): Promise<AiJobRow[]> {
  const { rows } = await pool.query<AiJobRow>(
    'SELECT * FROM ai_jobs WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT 50',
    [valuationId],
  );
  return rows;
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
