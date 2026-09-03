import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import {
  CLONED_VALUATION_COLUMNS,
  UNCLONED_VALUATION_COLUMNS,
  cloneValuation,
  findValuationById,
} from '../../src/repos/valuations.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The clone's column list on the aggregate root, against the column list the
 * table actually has.
 *
 * `cloneParamCoverage.test.ts` locks this down for the 1:1 params row.
 * `valuations` itself — the row the params hang off — still carried an inline
 * eleven-column list written before migration 0049, so the portfolio triple
 * (`organization_id`, `entity_type`, `parent_valuation_id`, 0079) and the
 * automatic-pipeline opt-out (`auto_pipeline`, 0049) were dropped. All four
 * have non-NULL defaults or are one of a set written as a unit, so the copy
 * did not read as incomplete: it read as a standalone, un-organized engagement
 * with the pipeline switched on.
 */
describe.skipIf(!dbUp)('clone / valuations column coverage', () => {
  let ctx: TestApp;
  let pool: pg.Pool;

  beforeAll(async () => {
    ctx = await setupTestApp();
    pool = ctx.pool;
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('accounts for every valuations column, once', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'valuations'`,
    );
    const actual = new Set(rows.map((r) => r.column_name));
    expect(actual.size).toBeGreaterThan(20);

    const carried = new Set<string>(CLONED_VALUATION_COLUMNS);
    const excluded = new Set(Object.keys(UNCLONED_VALUATION_COLUMNS));

    expect(CLONED_VALUATION_COLUMNS).toHaveLength(carried.size);
    expect([...carried].filter((c) => excluded.has(c))).toEqual([]);
    // A rename leaves a stale entry behind, which is the same silence pointed
    // the other way.
    expect([...carried, ...excluded].filter((c) => !actual.has(c)).sort()).toEqual([]);

    const unaccounted = [...actual].filter((c) => !carried.has(c) && !excluded.has(c)).sort();
    expect(unaccounted).toEqual([]);
  });

  /**
   * And the list is applied: a portfolio subsidiary with the pipeline switched
   * off comes back on the copy as the same thing.
   */
  it('carries portfolio membership and the pipeline opt-out onto the copy', async () => {
    const owner = await seedUser(ctx, {
      email: `clone.root.${newUlid()}@example.com`,
      roles: ['valuation_user'],
    });
    const orgId = newUlid();
    await pool.query(
      `INSERT INTO organizations (id, name, entity_type, owner_user_id) VALUES ($1, $2, 'fund', $3)`,
      [orgId, `Rollup ${orgId}`, owner.id],
    );
    const parentId = newUlid();
    await pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, currency, organization_id, entity_type)
       VALUES ($1, '409a', 'Holdco', $2, 'USD', $3, 'parent')`,
      [parentId, owner.id, orgId],
    );
    const sourceId = newUlid();
    await pool.query(
      `INSERT INTO valuations
         (id, kind, company_name, user_id, currency, organization_id, entity_type,
          parent_valuation_id, auto_pipeline)
       VALUES ($1, '409a', 'Subsidiary Co', $2, 'USD', $3, 'subsidiary', $4, false)`,
      [sourceId, owner.id, orgId, parentId],
    );

    const source = await findValuationById(pool, sourceId);
    expect(source).not.toBeNull();
    const clone = await cloneValuation(
      pool,
      source!,
      { rollForward: true, userId: owner.id },
      { actorId: owner.id, actorType: 'human' },
    );

    // Written against the constant, so it cannot drift from the statement the
    // way the statement drifted from the table.
    const columns = CLONED_VALUATION_COLUMNS.join(', ');
    const [before, after] = await Promise.all([
      pool.query(`SELECT ${columns} FROM valuations WHERE id = $1`, [sourceId]),
      pool.query(`SELECT ${columns} FROM valuations WHERE id = $1`, [clone.id]),
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]);

    // Not vacuous: these four are what a copy that dropped them would report
    // instead, and none of them is NULL.
    expect(clone.organization_id).toBe(orgId);
    expect(clone.entity_type).toBe('subsidiary');
    expect(clone.parent_valuation_id).toBe(parentId);
    expect(clone.auto_pipeline).toBe(false);

    // And the copy is still a new engagement at the start of the lifecycle.
    expect(clone.state).toBe('pending');
    expect(clone.version).toBe(1);
    expect(clone.external_id).toBeNull();
  });
});
