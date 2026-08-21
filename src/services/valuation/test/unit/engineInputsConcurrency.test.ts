import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { ApiProblem } from '@n409/shared';
import { applyEngineInputs, patchParams, type ValuationParamsRow } from '../../src/repos/params.js';

/**
 * The financial model two analysts saved at once (migration 0158).
 *
 * `PATCH /valuations/:id/engine-inputs` persists with `engine_inputs || $2`, a
 * *shallow* merge — a top-level block in the incoming document replaces the
 * stored one whole. The panel that drives it posts every block it holds on
 * every save, touched or not. So an analyst who edits a market multiple against
 * a document loaded a minute ago also posts their stale copy of the income
 * block, and it lands on top of whatever another analyst changed there. Both
 * saves return 200 and neither audit event records a loss.
 *
 * These are the repo-level pins for the fix. The route/HTTP half lives in
 * test/integration/engineInputsConcurrency.test.ts.
 */

const ROW = {
  valuation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  rolling_forward: false,
  allocation_method: 'opm',
  version: 4,
  engine_inputs: {},
  updated_at: new Date(0),
} as unknown as ValuationParamsRow;

const ACTOR = { actorType: 'human', actorId: 'U1', source: 'api' } as const;

/**
 * A pool whose UPDATE returns `updatedRows` and whose follow-up version read
 * returns `liveVersion`, recording every statement on the way.
 */
function fakePool(opts: {
  updatedRows: ValuationParamsRow[];
  liveVersion?: number;
  locked?: ValuationParamsRow;
}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*UPDATE valuation_params/.test(sql)) {
      return { rows: opts.updatedRows, rowCount: opts.updatedRows.length };
    }
    if (/SELECT version FROM valuation_params/.test(sql)) {
      const rows = opts.liveVersion === undefined ? [] : [{ version: opts.liveVersion }];
      return { rows, rowCount: rows.length };
    }
    if (/SELECT \* FROM valuation_params/.test(sql)) {
      const rows = opts.locked ? [opts.locked] : [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query } as unknown as pg.Pool;
  return { pool, calls };
}

const updateCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => /^\s*UPDATE valuation_params/.test(c.sql))!;

describe('applyEngineInputs optimistic locking', () => {
  it('bumps the version on every write, checked or not', async () => {
    const { pool, calls } = fakePool({ updatedRows: [{ ...ROW, version: 5 }] });
    await applyEngineInputs(pool, ROW.valuation_id, { income: { discount_rate: 0.2 } }, ACTOR);
    expect(updateCall(calls).sql).toContain('version = version + 1');
  });

  /**
   * The extraction auto-apply has no form behind it — it writes values it just
   * derived — so it keeps the unconditional write it always had.
   */
  it('leaves the UPDATE unconditional when no version is expected', async () => {
    const { pool, calls } = fakePool({ updatedRows: [{ ...ROW, version: 5 }] });
    await applyEngineInputs(pool, ROW.valuation_id, { income: { discount_rate: 0.2 } }, ACTOR);
    const call = updateCall(calls);
    expect(call.sql).not.toContain('AND version =');
    expect(call.params).toHaveLength(2);
  });

  it('conditions the UPDATE on the expected version when one is given', async () => {
    const { pool, calls } = fakePool({ updatedRows: [{ ...ROW, version: 5 }] });
    await applyEngineInputs(pool, ROW.valuation_id, { income: { discount_rate: 0.2 } }, ACTOR, {
      expectedVersion: 4,
    });
    const call = updateCall(calls);
    expect(call.sql).toContain('AND version = $3');
    expect(call.params).toContain(4);
  });

  /** The whole point: a save built on a document somebody else has moved on from. */
  it('refuses a write that loses the race, naming both versions', async () => {
    const { pool } = fakePool({ updatedRows: [], liveVersion: 9 });
    const err = await applyEngineInputs(pool, ROW.valuation_id, { income: { discount_rate: 0.2 } }, ACTOR, {
      expectedVersion: 4,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiProblem);
    expect((err as ApiProblem).status).toBe(409);
    expect((err as ApiProblem).detail).toContain('4');
    expect((err as ApiProblem).detail).toContain('9');
  });

  /**
   * Without a version condition the WHERE is a primary key the route just
   * loaded, so no rows means the row is gone — a purge landing mid-request.
   * Reporting that as a conflict would tell the caller to reload a valuation
   * that is not there.
   */
  it('reports a vanished row as 404, not as a conflict', async () => {
    const { pool } = fakePool({ updatedRows: [] });
    const err = await applyEngineInputs(pool, ROW.valuation_id, { income: {} }, ACTOR).catch(
      (e: unknown) => e,
    );
    expect((err as ApiProblem).status).toBe(404);
  });

  it('records the params_updated event only on a write that landed', async () => {
    const { pool, calls } = fakePool({ updatedRows: [], liveVersion: 9 });
    await applyEngineInputs(pool, ROW.valuation_id, { income: {} }, ACTOR, {
      expectedVersion: 4,
    }).catch(() => undefined);
    expect(calls.some((c) => /INSERT INTO valuation_events/i.test(c.sql))).toBe(false);
  });
});

/**
 * The guard is only as good as the version it compares against. `patchParams`
 * writes the same row through a different route, and a write that left the
 * version alone would be invisible to an engine-inputs editor — it would hold
 * version 4, the row would still say 4, and its stale blocks would land.
 */
describe('patchParams keeps the shared version honest', () => {
  it('bumps the version, so the other writer of this row can see it moved', async () => {
    const locked = { ...ROW, allocation_method: 'opm' } as ValuationParamsRow;
    const { pool, calls } = fakePool({ updatedRows: [{ ...ROW, version: 5 }], locked });
    await patchParams(pool, ROW, { allocation_method: 'pwerm' }, ACTOR);
    expect(updateCall(calls).sql).toContain('version = version + 1');
  });

  /** A no-op patch must not burn a version and conflict with a real editor. */
  it('writes nothing when the patch changes nothing', async () => {
    const locked = { ...ROW, allocation_method: 'opm' } as ValuationParamsRow;
    const { pool, calls } = fakePool({ updatedRows: [], locked });
    await patchParams(pool, ROW, { allocation_method: 'opm' }, ACTOR);
    expect(calls.find((c) => /^\s*UPDATE valuation_params/.test(c.sql))).toBeUndefined();
  });
});
