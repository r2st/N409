import type pg from 'pg';
import { newUlid, type FailureClass } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import { invalidateValuationAfter } from './valuations.js';
import { isUniqueViolation } from '../db/pgError.js';
import { PIPELINE_MAX_ATTEMPTS, pipelineRetryDelayMinutes } from '../domain/pipelineRetry.js';

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
  /** Execution attempts made, including the first (migration 0161). */
  attempts: number;
  /** When the retry sweep may re-queue this failed run; null = never. */
  next_attempt_at: Date | null;
  /** How the failure was classified; null when the run never failed. */
  failure_kind: 'transient' | 'permanent' | null;
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
  opts: { error?: string; actor?: EventActor; failure?: FailureClass } = {},
): Promise<PipelineRunRow | null> {
  // The retry schedule, stamped by the same statement that records the failure
  // — never a second UPDATE. A process that died between the two would leave a
  // run failed with no schedule, which is silently the old behaviour: owed
  // work that nothing will ever come back for.
  //
  // Only a transient failure earns a schedule (see domain/pipelineRetry.ts).
  // The ceiling is checked against the `attempts` column rather than the value
  // on the row this worker is holding, which may be several minutes stale.
  const transient = status === 'failed' && opts.failure?.kind === 'transient';
  const delayMinutes = transient ? pipelineRetryDelayMinutes(run.attempts) : null;

  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<PipelineRunRow>(
      `UPDATE pipeline_runs
          SET status = $1,
              error = $2,
              failure_kind = $4,
              next_attempt_at = CASE
                WHEN $5::numeric IS NOT NULL AND attempts < $6
                  -- Equal jitter: uniform over [0.5, 1.0] of the step, so one
                  -- outage's worth of runs do not all come back at once.
                  THEN now() + (($5::numeric * (0.5 + random() * 0.5)) || ' minutes')::interval
                ELSE NULL
              END,
              updated_at = now()
        WHERE id = $3 AND status NOT IN ('ready', 'failed')
       RETURNING *`,
      [
        status,
        opts.error ?? null,
        run.id,
        status === 'failed' ? (opts.failure?.kind ?? null) : null,
        delayMinutes,
        PIPELINE_MAX_ATTEMPTS,
      ],
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

/**
 * Take failed runs whose retry is due and put them back on 'queued'.
 *
 * Claimed, not merely selected: the row moves to an active status inside the
 * same statement that reads it, so two sweepers — or two instances, which is
 * the deployed shape — split the backlog instead of both re-running all of it.
 * `FOR UPDATE SKIP LOCKED` is what makes that true concurrently rather than
 * only in the happy case.
 *
 * Row by row, tolerating the active-run conflict, because of migration 0094:
 * at most one run per valuation may be active, and a valuation whose failed run
 * is due for retry may perfectly well have had a *newer* run started by hand in
 * the meantime. That newer run supersedes this one — the work is already being
 * done — so the conflict is the correct outcome and not an error. A set-based
 * UPDATE would take the whole batch down with it.
 *
 * `error` is cleared on the way out. A re-queued run that kept the previous
 * attempt's message would show a failure reason on a run that is currently
 * running, which is what the UI polls.
 */
export async function claimRetryablePipelineRuns(
  pool: pg.Pool,
  opts: { limit?: number; actor: EventActor },
): Promise<PipelineRunRow[]> {
  return withTransaction(pool, async (client) => {
    const { rows: due } = await client.query<PipelineRunRow>(
      `SELECT * FROM pipeline_runs
        WHERE status = 'failed'
          AND next_attempt_at IS NOT NULL
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [opts.limit ?? 20],
    );

    const claimed: PipelineRunRow[] = [];
    for (const run of due) {
      const { rows } = await client.query<PipelineRunRow>(
        `UPDATE pipeline_runs r
            SET status = 'queued',
                attempts = attempts + 1,
                error = NULL,
                next_attempt_at = NULL,
                updated_at = now()
          WHERE r.id = $1
            AND NOT EXISTS (
              SELECT 1 FROM pipeline_runs a
               WHERE a.valuation_id = r.valuation_id
                 AND a.status IN ('queued', 'extracting', 'calculating')
            )
         RETURNING *`,
        [run.id],
      );
      const requeued = rows[0];
      if (!requeued) {
        // A newer run is already active for this valuation. Stand down
        // permanently rather than leaving the schedule set: otherwise this row
        // is re-examined by every sweep forever, and the log fills with a
        // retry that is never taken.
        await client.query(
          `UPDATE pipeline_runs
              SET next_attempt_at = NULL,
                  error = COALESCE(error, '') || ' (retry abandoned: a newer run is active)',
                  updated_at = now()
            WHERE id = $1`,
          [run.id],
        );
        continue;
      }
      await recordEvent(client, {
        valuationId: requeued.valuation_id,
        type: 'auto_pipeline_started',
        actor: opts.actor,
        payload: {
          run_id: requeued.id,
          trigger: requeued.trigger,
          document_id: requeued.document_id,
          retry: true,
          attempt: requeued.attempts,
        },
      });
      claimed.push(requeued);
    }
    return claimed;
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
