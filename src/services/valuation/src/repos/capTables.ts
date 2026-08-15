import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import {
  CAP_TABLE_EVENT_TYPES,
  validateCapTable,
  type CapTableEntry,
  type CapTableValidation,
  type ColumnMapping,
} from '../domain/capTable.js';

export interface CapTableRow {
  id: string;
  valuation_id: string;
  source_format: string;
  entries: CapTableEntry[];
  validation: CapTableValidation;
  column_mapping: ColumnMapping;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  /** Bumped by every writer; carried over HTTP as an ETag (migration 0162). */
  version: number;
}

/**
 * The 409 a stale cap-table write is refused with.
 *
 * Worded like `repos/valuations.ts`'s equivalent and for the same reason: the
 * client needs to tell "somebody else saved" from "my own retry raced itself"
 * without a second round trip, so the version it collided with is named.
 *
 * `current` is optional because the row can be absent at the moment of the
 * write — either it was never there (the caller sent `If-Match` for a table
 * that does not exist yet) or it went away between the read and the write.
 */
function staleWrite(current: number | undefined, expected: number): never {
  throw problems.conflict(
    `This cap table was changed by someone else (expected version ${expected}, ` +
      `now ${current ?? 'unknown'}). Reload and reapply your changes.`,
  );
}

/**
 * Re-derive the stored `validation` from the entries beside it.
 *
 * The column is a cache and nothing more: every writer — the import route, the
 * preview, the provider sync — stores exactly `validateCapTable(entries)`, and
 * the function is pure over the entries. Nothing else is folded in, so a read
 * can reproduce it exactly.
 *
 * It is a cache that goes stale, and had. `fully_diluted_shares` counted every
 * preferred share 1:1 until eded249 taught it `conversion_ratio`; the rows
 * written before that still hold the old denominator, and no import rewrites
 * one — a cap table is only revalidated when somebody re-imports it, which for
 * a published engagement is never. So a valuation whose Series A converts 2:1
 * showed a fully-diluted count below the one the engine divides by, on the
 * cap-table tab, in the `cap_table` monitoring baseline, and in the workbook's
 * Summary sheet, which sat in the same file as a Cap table sheet that had been
 * recomputing the figure correctly since it was written. `validateCapTable`
 * has also grown checks since — `no_shares` (bb6b5e3) among them — and a row
 * predating one is stored as clean against a rule it was never tested on.
 *
 * Recomputing here rather than backfilling the column: a migration fixes the
 * rows that exist once, and leaves the next rule change to go stale the same
 * way. The cost is a pass over at most a few hundred entries, which is less
 * than the JSON parse that produced them.
 */
function withFreshValidation(row: CapTableRow): CapTableRow {
  return { ...row, validation: validateCapTable(row.entries) };
}

export async function findCapTable(pool: pg.Pool, valuationId: string): Promise<CapTableRow | null> {
  const { rows } = await pool.query<CapTableRow>('SELECT * FROM cap_tables WHERE valuation_id = $1', [
    valuationId,
  ]);
  return rows[0] ? withFreshValidation(rows[0]) : null;
}

/**
 * Batch form of {@link findCapTable}, keyed by valuation id. Exists so callers
 * that already hold a list of valuations (the monitoring dashboard and scan)
 * can fetch every cap table in one round trip instead of one per valuation.
 */
export async function findCapTablesByValuationIds(
  pool: pg.Pool,
  valuationIds: string[],
): Promise<Map<string, CapTableRow>> {
  if (valuationIds.length === 0) return new Map();
  const { rows } = await pool.query<CapTableRow>('SELECT * FROM cap_tables WHERE valuation_id = ANY($1)', [
    [...new Set(valuationIds)],
  ]);
  return new Map(rows.map((row) => [row.valuation_id, withFreshValidation(row)]));
}

export interface SaveCapTableOptions {
  /**
   * The `version` the caller's copy of the table was read at. When given, the
   * write is conditional on the row still being at that version and a stale
   * write is refused (409) rather than silently overwriting a concurrent import
   * (migration 0162).
   *
   * Omitted by callers that are not applying a document somebody read first —
   * the provider sync computes its rows from the pull rather than from the
   * stored table, so there is no stale read of *this* row to guard. It still
   * bumps the version, which is what makes the analyst's guarded write notice
   * that a sync landed underneath it.
   */
  expectedVersion?: number;
}

/** Insert-or-replace the valuation's cap table with a fresh import. */
export async function saveCapTable(
  pool: pg.Pool,
  input: {
    valuationId: string;
    sourceFormat: string;
    entries: CapTableEntry[];
    validation: CapTableValidation;
    columnMapping: ColumnMapping;
    createdBy: string;
  },
  actor: EventActor,
  options: SaveCapTableOptions = {},
): Promise<CapTableRow> {
  const { expectedVersion } = options;
  return withTransaction(pool, async (client) => {
    if (expectedVersion !== undefined) {
      // `FOR UPDATE` is what makes this a check rather than a race of its own:
      // the second of two concurrent guarded writers blocks here until the
      // first commits, then reads the version the first bumped and is refused.
      // Without the lock both would read the same version, both would pass, and
      // the upsert below would hand the table to whoever committed last —
      // exactly the failure 0162 exists to close.
      //
      // A missing row is a conflict too. The caller is asserting "I read this
      // table at version N"; if there is no table, that assertion is false
      // however it came to be false, and inserting one would be the silent
      // overwrite in reverse.
      const { rows: live } = await client.query<{ version: number }>(
        'SELECT version FROM cap_tables WHERE valuation_id = $1 FOR UPDATE',
        [input.valuationId],
      );
      if (live[0]?.version !== expectedVersion) staleWrite(live[0]?.version, expectedVersion);
    }

    const { rows } = await client.query<CapTableRow>(
      `INSERT INTO cap_tables (id, valuation_id, source_format, entries, validation, column_mapping, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (valuation_id) DO UPDATE SET
         source_format  = EXCLUDED.source_format,
         entries        = EXCLUDED.entries,
         validation     = EXCLUDED.validation,
         column_mapping = EXCLUDED.column_mapping,
         updated_at     = now(),
         -- Not EXCLUDED.version: that is the new row's default (1), which would
         -- reset the counter on every import and make a stale ETag look current
         -- again. Every write moves it forward, whether or not this caller
         -- asked to be guarded.
         version        = cap_tables.version + 1
       RETURNING *`,
      [
        newUlid(),
        input.valuationId,
        input.sourceFormat,
        JSON.stringify(input.entries),
        JSON.stringify(input.validation),
        JSON.stringify(input.columnMapping),
        input.createdBy,
      ],
    );
    await recordEvent(client, {
      valuationId: input.valuationId,
      type: CAP_TABLE_EVENT_TYPES.imported,
      actor,
      payload: {
        source_format: input.sourceFormat,
        class_count: input.entries.length,
        valid: input.validation.valid,
      },
    });
    return rows[0]!;
  });
}
