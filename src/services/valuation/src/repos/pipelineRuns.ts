import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { invalidateValuationAfter } from './valuations.js';
import { isUniqueViolation } from '../db/pgError.js';

/**
 * Auto-pipeline run tracking (final-status §4.4 #3). One row per orchestrated
 * extraction→calculation run; the status column is what the UI polls/streams
 * (queued → extracting → calculating → ready | failed).
 */

export const PIPELINE_RUN_STATUSES = ['queued', 'extracting', 'calculating', 'ready', 'failed'] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: ReadonlySet<PipelineRunStatus> = new Set([
  'queued',
  'extracting',
  'calculating',
]);

export interface PipelineRunRow {
  id: string;
  valuation_id: string;
  document_id: string | null;
  trigger: 'upload' | 'manual';
  status: PipelineRunStatus;
  error: string | null;
  triggered_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Partial unique index from migration 0094 — at most one run per valuation in
 * an active status. It is what makes "no overlapping orchestration" true across
 * processes; the `activePipelineRun` pre-check is only the friendly path.
 */
export const ACTIVE_RUN_UNIQUE_INDEX = 'pipeline_runs_one_active_per_valuation_idx';

function isActiveRunConflict(err: unknown): boolean {
  return isUniqueViolation(err, ACTIVE_RUN_UNIQUE_INDEX);
}

/**
 * Starts a run, or returns null when the valuation already has an active one.
 *
 * The INSERT and its 'auto_pipeline_started' event share a transaction, so a
 * trigger that loses the race leaves nothing behind — no orphan row, and no
 * start event for an orchestration that never ran.
 */
export async function createPipelineRun(
  pool: pg.Pool,
  args: {
    valuationId: string;
    documentId?: string | null;
    trigger: 'upload' | 'manual';
    triggeredBy: string;
  },
  actor: EventActor,
): Promise<PipelineRunRow | null> {
  try {
    return await withTransaction(pool, async (client) => {
      const { rows } = await client.query<PipelineRunRow>(
        `INSERT INTO pipeline_runs (id, valuation_id, document_id, trigger, triggered_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [newUlid(), args.valuationId, args.documentId ?? null, args.trigger, args.triggeredBy],
      );
      await recordEvent(client, {
        valuationId: args.valuationId,
        type: 'auto_pipeline_started',
        actor,
        payload: { run_id: rows[0]!.id, trigger: args.trigger, document_id: args.documentId ?? null },
      });
      return rows[0]!;
    });
  } catch (err) {
    if (isActiveRunConflict(err)) return null;
    throw err;
  }
}

/**
 * Advances a run, and returns the row as it now stands — or null once the row
 * is gone (its valuation was deleted mid-run).
 *
 * 'ready' and 'failed' are final. A run can be reaped while its worker is still
 * wedged on an upstream call, and that worker eventually returns and carries on
 * with its stale row; without the guard it walked the run back to 'calculating'
 * and then wrote a second terminal event over the reaper's. Worse, since
 * migration 0094 an active status is exclusive, so resurrecting a settled run
 * would collide with whatever run has started since. The caller sees the
 * unchanged terminal row back and can stop.
 */
export async function setPipelineRunStatus(
  pool: pg.Pool,
  run: PipelineRunRow,
  status: PipelineRunStatus,
  opts: { error?: string; actor?: EventActor } = {},
): Promise<PipelineRunRow | null> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<PipelineRunRow>(
      `UPDATE pipeline_runs SET status = $1, error = $2, updated_at = now()
       WHERE id = $3 AND status NOT IN ('ready', 'failed')
       RETURNING *`,
      [status, opts.error ?? null, run.id],
    );
    const updated = rows[0];
    if (!updated) {
      // Already settled (or deleted) — report the current row, change nothing.
      const { rows: current } = await client.query<PipelineRunRow>(
        'SELECT * FROM pipeline_runs WHERE id = $1',
        [run.id],
      );
      return current[0] ?? null;
    }
    // Terminal states land on the audit spine; intermediate hops are just UI.
    if ((status === 'ready' || status === 'failed') && opts.actor) {
      await recordEvent(client, {
        valuationId: run.valuation_id,
        type: status === 'ready' ? 'auto_pipeline_completed' : 'auto_pipeline_failed',
        actor: opts.actor,
        payload: { run_id: run.id, ...(opts.error ? { error: opts.error } : {}) },
      });
    }
    return updated;
  });
}

export async function latestPipelineRun(pool: pg.Pool, valuationId: string): Promise<PipelineRunRow | null> {
  const { rows } = await pool.query<PipelineRunRow>(
    `SELECT * FROM pipeline_runs WHERE valuation_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [valuationId],
  );
  return rows[0] ?? null;
}

/** Per-valuation opt-out toggle; no-ops (and skips the event) when unchanged. */
export async function setValuationAutoPipeline(
  pool: pg.Pool,
  valuation: { id: string; auto_pipeline: boolean },
  enabled: boolean,
  actor: EventActor,
): Promise<{ auto_pipeline: boolean }> {
  if (valuation.auto_pipeline === enabled) return { auto_pipeline: enabled };
  // After the commit, not after the UPDATE — see `invalidateValuationAfter`.
  return invalidateValuationAfter(valuation.id, () =>
    withTransaction(pool, async (client) => {
      await client.query('UPDATE valuations SET auto_pipeline = $1 WHERE id = $2', [enabled, valuation.id]);
      await recordEvent(client, {
        valuationId: valuation.id,
        type: 'auto_pipeline_toggled',
        actor,
        payload: { enabled },
      });
      return { auto_pipeline: enabled };
    }),
  );
}

/**
 * Fails auto-pipeline runs that have sat in an active status past `olderThanMs`
 * (B-3 §auto-pipeline). Two cases this recovers from:
 *   - a process restart mid-run leaves the row stuck 'extracting'/'calculating'
 *     with no worker to finish it (orphaned run);
 *   - a run wedged on an upstream call that never returns.
 * Runs the sweep once at boot and on an interval. Returns the reaped rows so the
 * caller can log/alert. Each reap lands a 'failed' event on the audit spine.
 */
export async function reapStalePipelineRuns(
  pool: pg.Pool,
  opts: { olderThanMs: number; actor: EventActor; limit?: number },
): Promise<PipelineRunRow[]> {
  const seconds = Math.max(1, Math.floor(opts.olderThanMs / 1000));
  const reason = `run exceeded ${seconds}s in an active state (reaped)`;
  return withTransaction(pool, async (client) => {
    // Lock the stale rows so two concurrent reapers (or instances) don't both
    // fail — and double-event — the same run.
    const { rows: stale } = await client.query<PipelineRunRow>(
      `SELECT * FROM pipeline_runs
       WHERE status IN ('queued', 'extracting', 'calculating')
         AND updated_at < now() - ($1 || ' seconds')::interval
       ORDER BY updated_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [String(seconds), opts.limit ?? 100],
    );
    const reaped: PipelineRunRow[] = [];
    for (const run of stale) {
      const { rows } = await client.query<PipelineRunRow>(
        `UPDATE pipeline_runs SET status = 'failed', error = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [reason, run.id],
      );
      await recordEvent(client, {
        valuationId: run.valuation_id,
        type: 'auto_pipeline_failed',
        actor: opts.actor,
        payload: { run_id: run.id, error: reason, reaped: true },
      });
      reaped.push(rows[0]!);
    }
    return reaped;
  });
}

/** An unfinished run blocks a new trigger (no overlapping orchestration). */
export async function activePipelineRun(pool: pg.Pool, valuationId: string): Promise<PipelineRunRow | null> {
  const { rows } = await pool.query<PipelineRunRow>(
    `SELECT * FROM pipeline_runs
     WHERE valuation_id = $1 AND status IN ('queued', 'extracting', 'calculating')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [valuationId],
  );
  return rows[0] ?? null;
}
