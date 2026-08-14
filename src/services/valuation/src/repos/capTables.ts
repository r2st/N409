import type pg from 'pg';
import { newUlid } from '@n409/shared';
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
): Promise<CapTableRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<CapTableRow>(
      `INSERT INTO cap_tables (id, valuation_id, source_format, entries, validation, column_mapping, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (valuation_id) DO UPDATE SET
         source_format  = EXCLUDED.source_format,
         entries        = EXCLUDED.entries,
         validation     = EXCLUDED.validation,
         column_mapping = EXCLUDED.column_mapping,
         updated_at     = now()
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
