import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  createCalculation,
  latestSucceededCalculation,
  latestSucceededCalculationsByValuationIds,
} from '../../src/repos/calculations.js';
import { findParams, findParamsByValuationIds } from '../../src/repos/params.js';
import { findCapTable, findCapTablesByValuationIds } from '../../src/repos/capTables.js';
import { findResolutionByValuation, findResolutionsByValuationIds } from '../../src/repos/boardApprovals.js';
import {
  eachEnabledMonitor,
  findMonitor,
  notifiedSignaturesFor,
  recordAlert,
} from '../../src/repos/monitors.js';

const dbUp = await isDbAvailable();

/**
 * The monitoring dashboard and the scan both walk every enabled monitor, and
 * each one used to cost four snapshot queries of its own — 4N round trips on a
 * page with no upper bound on N. These pin the batched form: the query count
 * must not move when more monitors are added, and the batch repo helpers must
 * agree with the per-valuation ones they replaced.
 */
describe.skipIf(!dbUp)('monitoring — snapshot batching', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  const monitored: string[] = [];

  /** Create a published valuation with a concluded FMV and enable monitoring. */
  async function seedMonitoredValuation(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    const id = created.json().valuation.id as string;
    await createCalculation(
      pool,
      {
        valuationId: id,
        engineVersion: 't',
        status: 'succeeded',
        inputs: {},
        results: {},
        equityValue: 1,
        fmvPerShare: 2,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    await pool.query("UPDATE valuations SET state = 'published', assigned_reviewer_id = $2 WHERE id = $1", [
      id,
      ops.id,
    ]);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/params`,
      headers: authHeader(ops.token),
      payload: { last_year_revenue_cents: 100_000_000 },
    });
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/monitor`,
      headers: authHeader(ops.token),
    });
    if (enabled.statusCode !== 201) throw new Error(`enable failed: ${enabled.body}`);
    monitored.push(id);
    return id;
  }

  /** Queries issued while running `fn` — the pool is the app's only DB handle. */
  async function countQueries(fn: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(pool, 'query');
    try {
      await fn();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  const dashboard = () =>
    app.inject({ method: 'GET', url: '/api/v1/monitors', headers: authHeader(ops.token) });

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    for (const name of ['BatchCo A', 'BatchCo B']) await seedMonitoredValuation(name);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('does not issue more queries as more monitors are added', async () => {
    const withTwo = await countQueries(dashboard);
    expect(monitored).toHaveLength(2);

    for (const name of ['BatchCo C', 'BatchCo D', 'BatchCo E']) await seedMonitoredValuation(name);
    const withFive = await countQueries(dashboard);

    // The whole point: 2 → 5 monitors adds no queries. Under the per-monitor
    // form this was +12 (four snapshot reads for each of the three new ones).
    expect(withFive).toBe(withTwo);
  });

  it('still returns every monitor with its status', async () => {
    const res = await dashboard();
    expect(res.statusCode).toBe(200);
    const ids = (res.json().monitors as Array<{ valuation_id: string; status: string }>).map(
      (m) => m.valuation_id,
    );
    for (const id of monitored) expect(ids).toContain(id);
    for (const m of res.json().monitors) expect(m.status).toBe('green');
  });

  it('scans every monitor without per-monitor snapshot queries', async () => {
    const scan = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/monitors/scan',
        headers: authHeader(ops.token),
      });
    const res = await scan();
    expect(res.statusCode).toBe(200);
    expect(res.json().scanned).toBe(monitored.length);
    // Nothing has moved since the baselines were taken, so no alerts fire and
    // the run is pure snapshot work — a clean count to compare against.
    expect(res.json().alerts_sent).toBe(0);

    const before = await countQueries(scan);
    await seedMonitoredValuation('BatchCo F');
    const after = await countQueries(scan);
    // An extra monitor now costs nothing at all. The four snapshot reads went
    // first (this delta was 5, then 1); what closed the last one was batching
    // the `markChecked` stamp, which was an UPDATE per monitor issued whether
    // or not anything fired — so the common case, a quiet scan, was paying a
    // round trip per monitor to record that nothing happened.
    expect(after - before).toBe(0);
  });

  /**
   * The scan pages rather than truncating, so it must still reach every
   * monitor — and the dedupe read that decides whether an alert is new has to
   * be batched per page, not asked per monitor.
   */
  it('reaches every monitor across page boundaries, and stamps them all', async () => {
    await pool.query('UPDATE valuation_monitors SET last_checked_at = NULL');
    const seen: string[] = [];
    for await (const page of eachEnabledMonitor(pool, { pageSize: 2 })) {
      expect(page.length).toBeLessThanOrEqual(2);
      for (const m of page) seen.push(m.valuation_id);
    }
    for (const id of monitored) expect(seen).toContain(id);
    expect(new Set(seen).size).toBe(seen.length);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(res.json().scanned).toBe(monitored.length);
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM valuation_monitors WHERE enabled AND last_checked_at IS NULL',
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  /**
   * The dedupe read is one query per page, and it is asked about the
   * signatures the page's triggers produced rather than about the monitors —
   * so what it drags through the wire is bounded by this scan and not by how
   * long these monitors have been running. The discriminator is the third
   * signature below: it exists on the monitor and is *not* asked about, so a
   * query that had gone back to `monitor_id = ANY(...)` would return it and
   * fail here.
   */
  it('answers the alert dedupe set for the candidates asked, not the monitor', async () => {
    const monitor = (await findMonitor(pool, monitored[0]!))!;
    for (const signature of ['sig-a', 'sig-b', 'sig-old']) {
      await recordAlert(pool, {
        monitorId: monitor.id,
        valuationId: monitor.valuation_id,
        triggerType: 'fmv_drift',
        level: 'warn',
        signature,
      });
    }

    const answered = await notifiedSignaturesFor(pool, [
      { monitorId: monitor.id, signature: 'sig-a' },
      { monitorId: monitor.id, signature: 'sig-b' },
      { monitorId: monitor.id, signature: 'never-fired' },
    ]);
    expect([...(answered.get(monitor.id) ?? new Set())].sort()).toEqual(['sig-a', 'sig-b']);

    // A candidate nobody has alerted on leaves its monitor out of the map
    // rather than mapping it to undefined-shaped junk, which is what lets the
    // caller read `?? new Set()`.
    const none = await notifiedSignaturesFor(pool, [
      { monitorId: monitor.id, signature: 'never-fired' },
    ]);
    expect(none.has(monitor.id)).toBe(false);
    expect(await notifiedSignaturesFor(pool, [])).toEqual(new Map());
  });

  describe('batch repo helpers agree with the per-valuation form', () => {
    it('latestSucceededCalculationsByValuationIds', async () => {
      const batch = await latestSucceededCalculationsByValuationIds(pool, monitored);
      expect(batch.size).toBe(monitored.length);
      for (const id of monitored) {
        expect(batch.get(id)?.id).toBe((await latestSucceededCalculation(pool, id))?.id);
      }
    });

    it('findParamsByValuationIds', async () => {
      const batch = await findParamsByValuationIds(pool, monitored);
      for (const id of monitored) {
        expect(batch.get(id)?.last_year_revenue_cents).toBe(
          (await findParams(pool, id))?.last_year_revenue_cents,
        );
      }
    });

    it('findCapTablesByValuationIds returns nothing for valuations without one', async () => {
      const batch = await findCapTablesByValuationIds(pool, monitored);
      for (const id of monitored) {
        expect(batch.get(id) ?? null).toEqual(await findCapTable(pool, id));
      }
    });

    it('findResolutionsByValuationIds', async () => {
      const batch = await findResolutionsByValuationIds(pool, monitored);
      for (const id of monitored) {
        expect(batch.get(id) ?? null).toEqual(await findResolutionByValuation(pool, id));
      }
    });

    it('every helper short-circuits on an empty id list', async () => {
      for (const helper of [
        latestSucceededCalculationsByValuationIds,
        findParamsByValuationIds,
        findCapTablesByValuationIds,
        findResolutionsByValuationIds,
      ]) {
        const spy = vi.spyOn(pool, 'query');
        try {
          expect((await helper(pool, [])).size).toBe(0);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      }
    });

    it('deduplicates repeated ids rather than returning a row per mention', async () => {
      const id = monitored[0]!;
      const batch = await findParamsByValuationIds(pool, [id, id, id]);
      expect(batch.size).toBe(1);
      expect(batch.get(id)).not.toBeUndefined();
    });
  });
});
