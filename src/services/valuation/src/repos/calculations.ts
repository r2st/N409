import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { PIPELINE_EVENT_TYPES } from '../domain/pipeline.js';
import { recordEvent, type EventActor } from '../events/record.js';

export interface CalculationRow {
  id: string;
  valuation_id: string;
  engine_version: string;
  status: 'succeeded' | 'failed';
  inputs: Record<string, unknown>;
  results: Record<string, unknown> | null;
  equity_value: string | null;
  fmv_per_share: string | null;
  error: string | null;
  /** Engine pre-flight findings: blocking errors on a failed run, review
   *  warnings on a successful one. Always an array. */
  diagnostics: CalculationDiagnostic[];
  created_by: string | null;
  created_at: Date;
}

export interface CalculationDiagnostic {
  code: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
  hint: string | null;
}

export async function createCalculation(
  pool: pg.Pool,
  args: {
    valuationId: string;
    engineVersion: string;
    status: 'succeeded' | 'failed';
    inputs: Record<string, unknown>;
    results?: Record<string, unknown> | null;
    equityValue?: number | null;
    fmvPerShare?: number | null;
    error?: string | null;
    diagnostics?: CalculationDiagnostic[];
    createdBy: string;
  },
  actor: EventActor,
): Promise<CalculationRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<CalculationRow>(
      `INSERT INTO calculations
         (id, valuation_id, engine_version, status, inputs, results, equity_value, fmv_per_share, error, diagnostics, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        newUlid(),
        args.valuationId,
        args.engineVersion,
        args.status,
        JSON.stringify(args.inputs),
        args.results ? JSON.stringify(args.results) : null,
        args.equityValue ?? null,
        args.fmvPerShare ?? null,
        args.error ?? null,
        JSON.stringify(args.diagnostics ?? []),
        args.createdBy,
      ],
    );
    await recordEvent(client, {
      valuationId: args.valuationId,
      type: PIPELINE_EVENT_TYPES.calculationCompleted,
      actor,
      payload: {
        calculation_id: rows[0]!.id,
        status: args.status,
        engine_version: args.engineVersion,
        fmv_per_share: args.fmvPerShare ?? null,
      },
    });
    return rows[0]!;
  });
}

/** Baseline for per-approach recalculation: the newest full successful run. */
export async function latestSucceededCalculation(
  pool: pg.Pool,
  valuationId: string,
): Promise<CalculationRow | null> {
  const { rows } = await pool.query<CalculationRow>(
    `SELECT * FROM calculations
     WHERE valuation_id = $1 AND status = 'succeeded'
     ORDER BY created_at DESC LIMIT 1`,
    [valuationId],
  );
  return rows[0] ?? null;
}

export async function listCalculations(pool: pg.Pool, valuationId: string): Promise<CalculationRow[]> {
  const { rows } = await pool.query<CalculationRow>(
    'SELECT * FROM calculations WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT 20',
    [valuationId],
  );
  return rows;
}
