import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { eachEnabledMonitor, listEnabledMonitors } from '../../src/repos/monitors.js';
import { STATE_GROUPS } from '../../src/domain/operations.js';

const dbUp = await isDbAvailable();

/**
 * Monitoring outlived the close, too.
 *
 * `monitoringArchived.test.ts` took retired engagements out of the dashboard
 * and the scan, because "when a trigger fires, the scan emails the assigned
 * reviewer a message ending 'Consider a fresh valuation' — about work the firm
 * has already withdrawn".
 *
 * Archiving is the retention sweep's word for a file withdrawn years later.
 * `cancelled` is a legal move out of every monitorable state but `published` —
 * `completed`, `paid`, `review`, `reviewed`, `drafted`, `draft_changes`,
 * `draft_accepted` — so the ordinary story is: ops enable the watch on a
 * drafted engagement, the client goes quiet, ops cancel it. Closing moves
 * `state` and nothing else; nothing disables a monitor. The scan kept
 * evaluating it and kept mailing, on every tick, with no end condition.
 */
describe.skipIf(!dbUp)('monitoring drops closed engagements', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  const closedIds: Record<string, string> = {};

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
    // `drafted`, not `published`: it is a monitorable state that `cancelled` is
    // a legal move out of, which is the path this file is about.
    await pool.query("UPDATE valuations SET state = 'drafted', assigned_reviewer_id = $2 WHERE id = $1", [
      id,
      ops.id,
    ]);
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/monitor`,
      headers: authHeader(ops.token),
    });
    if (enabled.statusCode !== 201) throw new Error(`enable failed: ${enabled.body}`);
    return id;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    liveId = await seedMonitoredValuation('Watched Open Inc');
    for (const state of STATE_GROUPS.closed) {
      const id = await seedMonitoredValuation(`Watched ${state} Inc`);
      // Closed after the watch is set up, which is what production does and
      // what made the leak reachable.
      await pool.query('UPDATE valuations SET state = $2::valuation_state WHERE id = $1', [id, state]);
      closedIds[state] = id;
    }
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  it('leaves the closed engagements enabled — the monitor row is untouched', async () => {
    for (const [state, id] of Object.entries(closedIds)) {
      const { rows } = await pool.query<{ enabled: boolean }>(
        'SELECT enabled FROM valuation_monitors WHERE valuation_id = $1',
        [id],
      );
      // If closing disabled monitors the filter under test would be untestable
      // through this path and the rest of this file would pass vacuously.
      expect(rows[0]!.enabled, state).toBe(true);
    }
  });

  it('keeps them off the monitoring dashboard', async () => {
    const ids = (await listEnabledMonitors(pool)).monitors.map((m) => m.valuation_id);
    expect(ids).toContain(liveId);
    for (const [state, id] of Object.entries(closedIds)) expect(ids, state).not.toContain(id);
  });

  it('never hands them to the scan', async () => {
    const seen: string[] = [];
    // pageSize 1 forces the keyset cursor to walk, so the filter is exercised
    // on every page rather than only on the first.
    for await (const page of eachEnabledMonitor(pool, { pageSize: 1 })) {
      seen.push(...page.map((m) => m.valuation_id));
    }
    expect(seen).toContain(liveId);
    for (const [state, id] of Object.entries(closedIds)) expect(seen, state).not.toContain(id);
  });

  it('scans only the open one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    // The count is the assertion: a scan that still walked the closed rows
    // would report four.
    expect(res.json().scanned).toBe(1);
  });

  it('resumes watching when the engagement is restarted', async () => {
    const id = closedIds.cancelled!;
    await pool.query("UPDATE valuations SET state = 'started' WHERE id = $1", [id]);
    try {
      // Filtering the read rather than disabling the monitor is what makes this
      // reversible: `canRestart` puts a cancelled engagement back to `started`,
      // and it comes back with the watch it was set up with.
      const ids = (await listEnabledMonitors(pool)).monitors.map((m) => m.valuation_id);
      expect(ids).toContain(id);
    } finally {
      await pool.query("UPDATE valuations SET state = 'cancelled' WHERE id = $1", [id]);
    }
  });

  /**
   * And the door is shut at the other end. `MONITORABLE_STATES` does not carry
   * a closed state, but the `hasCalc` escape hatch beside it lets any state
   * through once a calculation has succeeded — so a cancelled engagement could
   * be given a monitor the scan would then refuse to walk: a control sitting
   * enabled on the dashboard that never runs.
   */
  it('refuses to enable a monitor on a closed engagement', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Never Watched Inc' },
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
    await pool.query("UPDATE valuations SET state = 'cancelled' WHERE id = $1", [id]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/closed/i);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM valuation_monitors WHERE valuation_id = $1',
      [id],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
