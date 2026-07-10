import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';

export const SCENARIO_LABELS = ['bull', 'base', 'bear', 'custom'] as const;
export type ScenarioLabel = (typeof SCENARIO_LABELS)[number];

export interface ScenarioRow {
  id: string;
  valuation_id: string;
  name: string;
  label: ScenarioLabel;
  inputs: Record<string, unknown>;
  baseline_calculation_id: string | null;
  equity_value: string | null;
  fmv_per_share: string | null;
  results: Record<string, unknown> | null;
  created_by: string;
  created_at: Date;
}

export async function createScenario(
  pool: pg.Pool,
  args: {
    valuationId: string;
    name: string;
    label: ScenarioLabel;
    inputs: Record<string, unknown>;
    baselineCalculationId: string | null;
    equityValue: number | null;
    fmvPerShare: number | null;
    results: Record<string, unknown> | null;
    createdBy: string;
  },
  actor: EventActor,
): Promise<ScenarioRow> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<ScenarioRow>(
      `INSERT INTO valuation_scenarios
         (id, valuation_id, name, label, inputs, baseline_calculation_id,
          equity_value, fmv_per_share, results, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        newUlid(),
        args.valuationId,
        args.name,
        args.label,
        JSON.stringify(args.inputs),
        args.baselineCalculationId,
        args.equityValue,
        args.fmvPerShare,
        args.results ? JSON.stringify(args.results) : null,
        args.createdBy,
      ],
    );
    await recordEvent(client, {
      valuationId: args.valuationId,
      type: 'scenario_saved',
      actor,
      payload: {
        scenario_id: rows[0]!.id,
        name: args.name,
        label: args.label,
        fmv_per_share: args.fmvPerShare,
      },
    });
    return rows[0]!;
  });
}

export async function listScenarios(pool: pg.Pool, valuationId: string): Promise<ScenarioRow[]> {
  const { rows } = await pool.query<ScenarioRow>(
    'SELECT * FROM valuation_scenarios WHERE valuation_id = $1 ORDER BY created_at DESC',
    [valuationId],
  );
  return rows;
}

export async function countScenarios(pool: pg.Pool, valuationId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM valuation_scenarios WHERE valuation_id = $1',
    [valuationId],
  );
  return Number(rows[0]!.count);
}

export async function findScenarioById(pool: pg.Pool, id: string): Promise<ScenarioRow | null> {
  const { rows } = await pool.query<ScenarioRow>(
    'SELECT * FROM valuation_scenarios WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function deleteScenario(
  pool: pg.Pool,
  scenario: ScenarioRow,
  actor: EventActor,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('DELETE FROM valuation_scenarios WHERE id = $1', [scenario.id]);
    await recordEvent(client, {
      valuationId: scenario.valuation_id,
      type: 'scenario_deleted',
      actor,
      payload: { scenario_id: scenario.id, name: scenario.name, label: scenario.label },
    });
  });
}
