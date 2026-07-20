import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';
import {
  CAP_TABLE_EVENT_TYPES,
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

export async function findCapTable(pool: pg.Pool, valuationId: string): Promise<CapTableRow | null> {
  const { rows } = await pool.query<CapTableRow>('SELECT * FROM cap_tables WHERE valuation_id = $1', [
    valuationId,
  ]);
  return rows[0] ?? null;
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
