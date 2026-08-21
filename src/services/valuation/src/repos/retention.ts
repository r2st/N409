import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { RetentionPolicy } from '../domain/retention.js';
import { invalidateValuation } from './valuations.js';

// ── Policies ─────────────────────────────────────────────────────────────────

export interface RetentionPolicyRow extends RetentionPolicy {
  updated_by: string | null;
  updated_at: Date;
}

export async function listPolicies(pool: pg.Pool): Promise<RetentionPolicyRow[]> {
  const { rows } = await pool.query<RetentionPolicyRow>(
    'SELECT * FROM retention_policies ORDER BY data_type',
  );
  return rows;
}

export async function upsertPolicy(
  pool: pg.Pool,
  input: {
    dataType: string;
    archiveAfterDays: number | null;
    retentionDays: number | null;
    enabled: boolean;
    updatedBy: string;
  },
): Promise<RetentionPolicyRow> {
  const { rows } = await pool.query<RetentionPolicyRow>(
    `INSERT INTO retention_policies (data_type, archive_after_days, retention_days, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (data_type) DO UPDATE SET
       archive_after_days = EXCLUDED.archive_after_days,
       retention_days = EXCLUDED.retention_days,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [input.dataType, input.archiveAfterDays, input.retentionDays, input.enabled, input.updatedBy],
  );
  return rows[0]!;
}

// ── Legal holds ──────────────────────────────────────────────────────────────

export interface LegalHoldRow {
  id: string;
  scope: 'global' | 'valuation' | 'user';
  reference_id: string | null;
  reason: string;
  active: boolean;
  placed_by: string | null;
  placed_at: Date;
  released_by: string | null;
  released_at: Date | null;
}

/** Ceiling on one page of the legal-hold ledger. */
export const HOLD_PAGE_LIMIT = 200;

/**
 * The legal-hold ledger, newest first — a page of it.
 *
 * Holds are never deleted, only released, so this table only grows. Capping it
 * is safe in a way capping a work queue is not: nothing *enforces* a hold from
 * this list. The purge checks `legal_holds` in SQL (see `purgeCandidates`
 * below), so a hold past the cut still blocks deletion even though it is not on
 * the page. Active holds are ordered ahead of released ones so the cap cannot
 * push a live hold off the end behind a year of released ones.
 */
export async function listHolds(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ holds: LegalHoldRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? HOLD_PAGE_LIMIT, 1), HOLD_PAGE_LIMIT);
  const { rows } = await pool.query<LegalHoldRow>(
    'SELECT * FROM legal_holds ORDER BY active DESC, placed_at DESC LIMIT $1',
    [limit + 1],
  );
  return { holds: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function placeHold(
  pool: pg.Pool,
  input: {
    scope: 'global' | 'valuation' | 'user';
    referenceId: string | null;
    reason: string;
    placedBy: string;
  },
): Promise<LegalHoldRow> {
  const { rows } = await pool.query<LegalHoldRow>(
    `INSERT INTO legal_holds (id, scope, reference_id, reason, placed_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [newUlid(), input.scope, input.referenceId, input.reason, input.placedBy],
  );
  return rows[0]!;
}

export async function releaseHold(pool: pg.Pool, id: string, releasedBy: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE legal_holds SET active = false, released_at = now(), released_by = $2
      WHERE id = $1 AND active = true`,
    [id, releasedBy],
  );
  return (rowCount ?? 0) > 0;
}

// ── Retention actions (audit log) ────────────────────────────────────────────

export interface RetentionActionRow {
  id: string;
  data_type: string;
  action: 'archived' | 'skipped_hold' | 'purge_eligible' | 'restored';
  reference_id: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
}

export interface RetentionActionInput {
  dataType: string;
  action: 'archived' | 'skipped_hold' | 'purge_eligible' | 'restored';
  referenceId: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Append to the decision log, however many decisions the pass made.
 *
 * Batched rather than one insert per decision: the sweep logs a row for every
 * candidate it looks at, and `findArchivableValuations` hands it up to 500 of
 * them. One INSERT per decision meant the log — which is pure audit bookkeeping
 * and nothing waits on it — cost more round trips than the archival it was
 * describing.
 *
 * A no-op on an empty batch: a loop that writes nothing is fine, a statement
 * with an empty VALUES list is a syntax error.
 */
export async function recordActions(
  client: pg.Pool | pg.PoolClient,
  inputs: readonly RetentionActionInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  const params: unknown[] = [];
  const tuples = inputs.map((input) => {
    params.push(
      newUlid(),
      input.dataType,
      input.action,
      input.referenceId,
      JSON.stringify(input.detail ?? {}),
    );
    const n = params.length;
    return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  await client.query(
    `INSERT INTO retention_actions (id, data_type, action, reference_id, detail)
     VALUES ${tuples.join(', ')}`,
    params,
  );
}

/**
 * Whether any active legal hold freezes this one valuation.
 *
 * The same three-way test `findArchivableValuations` computes for a whole
 * batch, asked of a single row — and asked in SQL rather than by pulling
 * `listHolds` and running `isFrozen` over it, because that listing is paged.
 * A deployment past `HOLD_PAGE_LIMIT` holds would answer "not frozen" for a
 * valuation whose hold sits on page two, which is the quiet direction to be
 * wrong in: it is the answer that lets an action proceed.
 */
export async function isValuationFrozen(
  pool: pg.Pool,
  target: { valuationId: string; userId: string },
): Promise<boolean> {
  const { rows } = await pool.query<{ frozen: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM legal_holds h
        WHERE h.active
          AND (h.scope = 'global'
            OR (h.scope = 'valuation' AND h.reference_id = $1)
            OR (h.scope = 'user' AND h.reference_id = $2))
     ) AS frozen`,
    [target.valuationId, target.userId],
  );
  return rows[0]?.frozen ?? false;
}

export async function listActions(pool: pg.Pool, limit = 200): Promise<RetentionActionRow[]> {
  const { rows } = await pool.query<RetentionActionRow>(
    'SELECT * FROM retention_actions ORDER BY created_at DESC LIMIT $1',
    [limit],
  );
  return rows;
}

/**
 * Candidate valuations for archival: older than `cutoffDays`, not already
 * archived, with each candidate's active-hold flag pre-computed so the sweep
 * can skip frozen records without a per-row query.
 */
export async function findArchivableValuations(
  pool: pg.Pool,
  cutoffDays: number,
  limit = 500,
): Promise<Array<{ id: string; user_id: string; frozen: boolean }>> {
  const { rows } = await pool.query<{ id: string; user_id: string; frozen: boolean }>(
    `SELECT v.id, v.user_id,
            EXISTS (
              SELECT 1 FROM legal_holds h
               WHERE h.active
                 AND (h.scope = 'global'
                   OR (h.scope = 'valuation' AND h.reference_id = v.id)
                   OR (h.scope = 'user' AND h.reference_id = v.user_id))
            ) AS frozen
       FROM valuations v
      WHERE v.archived_at IS NULL
        AND v.created_at < now() - ($1 || ' days')::interval
      ORDER BY v.created_at ASC
      LIMIT $2`,
    [String(cutoffDays), limit],
  );
  return rows;
}

/**
 * Archive a whole batch in one statement, and report which rows it actually
 * took — `RETURNING id` and not the input list, because `archived_at IS NULL`
 * can already have stopped being true for a candidate between the SELECT that
 * found it and this UPDATE. The sweep counts and logs what came back, so a row
 * archived by a concurrent pass is not counted twice.
 *
 * The cache is invalidated per returned id for the same reason: entries are
 * keyed by valuation, and a row this call did not change has not gone stale.
 */
export async function markValuationsArchived(pool: pg.Pool, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE valuations SET archived_at = now()
      WHERE id = ANY($1) AND archived_at IS NULL
      RETURNING id`,
    [[...new Set(ids)]],
  );
  for (const row of rows) invalidateValuation(row.id);
  return rows.map((row) => row.id);
}
