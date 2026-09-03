import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import {
  CLONED_PARAM_COLUMNS,
  UNCLONED_PARAM_COLUMNS,
  cloneValuation,
  findValuationById,
} from '../../src/repos/valuations.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The roll-forward's column list, against the column list the table actually
 * has.
 *
 * `cloneValuation` used to carry an inline list of `valuation_params` columns
 * written when the table had twenty-four of them. Nineteen migrations later it
 * still carried the same twenty-two, so a roll-forward silently dropped the
 * allocation method, the whole DLOC apparatus, the WACC build-up, the
 * development stage, the required-return table and both of the DLOM study
 * forms — while claiming, in the line above it, to "copy methodology params".
 *
 * The defect is not that somebody chose the wrong columns; it is that nothing
 * connected the choice to the table. So this derives the real column set from
 * `information_schema` and demands that every column be either carried or
 * named in {@link UNCLONED_PARAM_COLUMNS} with a reason. The next migration
 * that adds a methodology column fails here until somebody says which it is.
 */
describe.skipIf(!dbUp)('clone / valuation_params column coverage', () => {
  let ctx: TestApp;
  let pool: pg.Pool;

  beforeAll(async () => {
    ctx = await setupTestApp();
    pool = ctx.pool;
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('accounts for every valuation_params column, once', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'valuation_params'`,
    );
    const actual = new Set(rows.map((r) => r.column_name));
    expect(actual.size).toBeGreaterThan(20);

    const carried = new Set<string>(CLONED_PARAM_COLUMNS);
    const excluded = new Set(Object.keys(UNCLONED_PARAM_COLUMNS));

    // No column named twice, and none named that does not exist — a rename
    // leaves a stale entry behind, which is the same silence pointed the other
    // way.
    expect(CLONED_PARAM_COLUMNS).toHaveLength(carried.size);
    expect([...carried].filter((c) => excluded.has(c))).toEqual([]);
    expect([...carried, ...excluded].filter((c) => !actual.has(c))).toEqual([]);

    const unaccounted = [...actual].filter((c) => !carried.has(c) && !excluded.has(c)).sort();
    expect(unaccounted).toEqual([]);
  });

  /**
   * And the list is actually applied: a source row with every carried column
   * set to a distinguishable value comes back on the copy.
   *
   * Written against the constant rather than against a hand-listed set of
   * columns, so it cannot drift from the statement the way the statement
   * drifted from the table.
   */
  it('carries every column it names onto the copy', async () => {
    const owner = await seedUser(ctx, {
      email: `clone.params.${newUlid()}@example.com`,
      roles: ['valuation_user'],
    });
    const sourceId = newUlid();
    await pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, currency)
       VALUES ($1, '409a', 'ParamCarry Co', $2, 'USD')`,
      [sourceId, owner.id],
    );
    await pool.query(
      `INSERT INTO valuation_params
         (valuation_id, allocation_method, development_stage, dlom_methods, dloc_method,
          control_premium, dloc_studies, dloc_statistic, required_return_table, wacc_inputs,
          auto_wacc, dlom_pre_ipo_studies, dlom_studies, dlom_statistic, weight_opm)
       VALUES ($1, 'pwerm', 4, '[{"method":"finnerty","weight":1}]'::jsonb, 'studies',
               0.15, ARRAY['mergerstat'], 'median', '[{"stage":"expansion","rate":0.35}]'::jsonb,
               '{"risk_free":0.04}'::jsonb, true, ARRAY['emory'], ARRAY['stout'], 'mean', 0.6)`,
      [sourceId],
    );

    const source = await findValuationById(pool, sourceId);
    expect(source).not.toBeNull();
    const clone = await cloneValuation(
      pool,
      source!,
      { rollForward: true, userId: owner.id },
      { actorId: owner.id, actorType: 'human' },
    );

    const columns = CLONED_PARAM_COLUMNS.join(', ');
    const [before, after] = await Promise.all([
      pool.query(`SELECT ${columns} FROM valuation_params WHERE valuation_id = $1`, [sourceId]),
      pool.query(`SELECT ${columns} FROM valuation_params WHERE valuation_id = $1`, [clone.id]),
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    // The set above is chosen so the assertion is not vacuous: if the copy
    // dropped a column the two rows would still both be NULL there.
    expect((before.rows[0] as Record<string, unknown>).allocation_method).toBe('pwerm');
    expect((after.rows[0] as Record<string, unknown>).dloc_method).toBe('studies');
    expect((after.rows[0] as Record<string, unknown>).development_stage).toBe(4);

    // The two flags the copy sets for itself, rather than carrying.
    const { rows: flags } = await pool.query<{ rolling_forward: boolean; version: number }>(
      'SELECT rolling_forward, version FROM valuation_params WHERE valuation_id = $1',
      [clone.id],
    );
    expect(flags[0]!.rolling_forward).toBe(true);
  });
});
