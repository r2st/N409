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
  await withTransaction(pool, async (client) => {
    for (const cell of cells) {
      if (cell.value === null) {
        await client.query(
          `DELETE FROM workbook_cells
           WHERE valuation_id = $1 AND sheet = $2 AND row_key = $3 AND column_key = $4`,
          [valuationId, cell.sheet, cell.row_key, cell.column_key],
        );
      } else {
        await client.query(
          `INSERT INTO workbook_cells (valuation_id, sheet, row_key, column_key, value, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (valuation_id, sheet, row_key, column_key)
           DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [valuationId, cell.sheet, cell.row_key, cell.column_key, cell.value, actor.actorId ?? null],
        );
      }
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
