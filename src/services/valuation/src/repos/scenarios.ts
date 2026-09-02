import type pg from 'pg';
import { newUlid, problems } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { recordEvent, type EventActor } from '../events/record.js';

/**
 * Lock class for the saved-scenario ceiling. Distinct from every other key in
 * this service — `PUBLISH_GATE_LOCK`, `OVERWRITE_CELL_LOCK`,
 * `TEMPLATE_NAME_LOCK` — because `pg_advisory_xact_lock(key1, key2)` shares one
 * namespace across the database and two subsystems on the same pair would block
 * each other for no reason.
 */
const SCENARIO_CAP_LOCK = 0x736e_6172; // 'snar'

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
    /**
     * The per-valuation ceiling, re-asked under a lock this transaction holds.
     *
     * {@link listScenarios} has no LIMIT, so `MAX_SCENARIOS` is the only thing
     * bounding it, and the route enforced it with a `countScenarios` on the
     * pool — *before* a 30-second engine compute. That is not the usual
     * one-statement window: every save the operator fires while the first is
     * still computing reads the same count, and all of them insert. Twelve
     * becomes twelve plus however many were in flight, on a list nothing pages.
     *
     * Optional, so the number stays the route's to choose; supplied, the count
     * is taken inside the transaction that writes, behind an advisory lock on
     * the valuation. A row lock will not do — the rows being counted are the
     * ones not yet inserted, so there is nothing to lock in the direction that
     * matters, which is the same argument `repos/publishLock.ts` makes.
     */
    maxScenarios?: number;
  },
  actor: EventActor,
): Promise<ScenarioRow> {
  return withTransaction(pool, async (client) => {
    if (args.maxScenarios !== undefined) {
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        SCENARIO_CAP_LOCK,
        args.valuationId,
      ]);
      const { rows: tally } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM valuation_scenarios WHERE valuation_id = $1',
        [args.valuationId],
      );
      if (Number(tally[0]?.count ?? 0) >= args.maxScenarios) {
        // The route's sentence, because it is the route's refusal — an operator
        // who loses this race is told the same thing they would have been told
        // a moment earlier.
        throw problems.unprocessable(
          `A valuation holds at most ${args.maxScenarios} saved scenarios — delete one first`,
        );
      }
    }
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
  const { rows } = await pool.query<ScenarioRow>('SELECT * FROM valuation_scenarios WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Drop a saved scenario, and say so on the spine once.
 *
 * The route reaches this through `findScenarioById`, so it can only ever be
 * called on a row that existed — but that read is on a different connection one
 * statement earlier, and two DELETEs off one read is a double-clicked button.
 * `deleteRound` and `deleteDocument` both ask the question and this did not, so
 * a second press put a second `scenario_deleted` on an append-only trail for one
 * deletion: the activity log shows a scenario removed twice, and the row it
 * names is gone either way, so nothing downstream can reconcile the count.
 *
 * Losing the race writes nothing, which is `deleteDocument`'s reading: the
 * caller asked for a state the row is already in, and its own outcome — a 204
 * over a scenario that is not there — is unchanged.
 */
export async function deleteScenario(pool: pg.Pool, scenario: ScenarioRow, actor: EventActor): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query('DELETE FROM valuation_scenarios WHERE id = $1', [scenario.id]);
    if ((rowCount ?? 0) === 0) return;
    await recordEvent(client, {
      valuationId: scenario.valuation_id,
      type: 'scenario_deleted',
      actor,
      payload: { scenario_id: scenario.id, name: scenario.name, label: scenario.label },
    });
  });
}
