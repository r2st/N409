import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { EVENT_TYPES } from '../domain/valuation.js';
import { recordEvent, type EventActor } from '../events/record.js';
import type { WorkbookCellInput } from '../domain/workbook.js';

export interface WorkbookCellRow {
  valuation_id: string;
  sheet: string;
  row_key: string;
  column_key: string;
  value: string; // pg numeric arrives as text
  updated_by: string | null;
  updated_at: Date;
}

export async function listWorkbookCells(pool: pg.Pool, valuationId: string): Promise<WorkbookCellInput[]> {
  const { rows } = await pool.query<WorkbookCellRow>(
    'SELECT * FROM workbook_cells WHERE valuation_id = $1',
    [valuationId],
  );
  return rows.map((r) => ({
    sheet: r.sheet,
    row_key: r.row_key,
    column_key: r.column_key,
    value: Number(r.value),
  }));
}

export interface WorkbookPatchCell {
  sheet: string;
  row_key: string;
  column_key: string;
  /** null clears the cell */
  value: number | null;
}

/** Applies a batch of cell writes/clears atomically and records one event. */
export async function patchWorkbookCells(
  pool: pg.Pool,
  valuationId: string,
  cells: readonly WorkbookPatchCell[],
  actor: EventActor,
): Promise<void> {
  if (cells.length === 0) return;
  // Dedupe by cell ref, keeping the last occurrence — matches the old
  // sequential loop's last-write-wins behavior for a request that repeats a
  // ref (also required: a batched INSERT..ON CONFLICT errors if the same
  // conflict key appears twice in one statement).
  const lastByRef = new Map<string, WorkbookPatchCell>();
  for (const cell of cells) lastByRef.set(`${cell.sheet}|${cell.row_key}|${cell.column_key}`, cell);
  const deduped = [...lastByRef.values()];
  const clears = deduped.filter((c) => c.value === null);
  const writes = deduped.filter((c) => c.value !== null);
  await withTransaction(pool, async (client) => {
    // A route caps a single request at 500 cells (a bulk paste), which used
    // to mean up to 500 round trips here — one DELETE/INSERT per cell. Both
    // arms are batched into a single statement over unnest() arrays instead.
    if (clears.length > 0) {
      await client.query(
        `DELETE FROM workbook_cells
         WHERE valuation_id = $1
           AND (sheet, row_key, column_key) IN (
             SELECT * FROM unnest($2::text[], $3::text[], $4::text[])
           )`,
        [valuationId, clears.map((c) => c.sheet), clears.map((c) => c.row_key), clears.map((c) => c.column_key)],
      );
    }
    if (writes.length > 0) {
      await client.query(
        `INSERT INTO workbook_cells (valuation_id, sheet, row_key, column_key, value, updated_by)
         SELECT $1, sheet, row_key, column_key, value, $6
         FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[])
           AS t(sheet, row_key, column_key, value)
         ON CONFLICT (valuation_id, sheet, row_key, column_key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [
          valuationId,
          writes.map((c) => c.sheet),
          writes.map((c) => c.row_key),
          writes.map((c) => c.column_key),
          writes.map((c) => c.value),
          actor.actorId ?? null,
        ],
      );
    }
    await recordEvent(client, {
      valuationId,
      type: EVENT_TYPES.workbookUpdated,
      actor,
      payload: {
        cells: cells.map((c) => ({
          sheet: c.sheet,
          row: c.row_key,
          column: c.column_key,
          value: c.value,
        })),
      },
    });
  });
}
