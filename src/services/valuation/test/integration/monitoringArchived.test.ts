import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { eachEnabledMonitor, listEnabledMonitors } from '../../src/repos/monitors.js';

const dbUp = await isDbAvailable();

/**
 * Monitoring outlived the soft delete.
 *
 * `archived_at` is how a valuation is retired — `retireValuations` stamps it,
 * the retention sweep stamps it — and `buildValuationWhere` keeps archived rows
 * out of the list, the counts, the buckets and the export. Archiving does not
 * disable a monitor, and the two queries that read enabled monitors joined
 * `valuations` without the filter, so the scan kept evaluating retired
 * engagements.
 *
 * That is worse than the dashboard row it also produced. When a trigger fires,
 * the scan emails the assigned reviewer a message ending "Consider a fresh
 * valuation" — about work the firm has already withdrawn. The screen was merely
 * wrong; the alert acted on it.
 *
 * The filter lives on the shared `ENABLED_MONITOR_SELECT` rather than in either
 * caller, so the dashboard and the scan cannot come to disagree about which
 * engagements are still being watched. Both are asserted here for that reason.
 */
describe.skipIf(!dbUp)('monitoring drops retired engagements', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  let retiredId: string;

  /** A published, monitored engagement — the shape the scan is built to walk. */
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
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/monitor`,
      headers: authHeader(ops.token),
    });
    if (enabled.statusCode !== 201) throw new Error(`enable failed: ${enabled.body}`);
    return id;
  }

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    liveId = await seedMonitoredValuation('Watched Live Inc');
    retiredId = await seedMonitoredValuation('Watched Retired Inc');

    // Retire one of them. The monitor row is deliberately left enabled: that is
    // what production does, and it is what made the leak reachable.
    await pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retiredId]);
  });
  afterAll(async () => ctx?.teardown());

  it('leaves the retired engagement enabled — the monitor row is untouched', async () => {
    const { rows } = await pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM valuation_monitors WHERE valuation_id = $1',
      [retiredId],
    );
    // If archiving disabled monitors, the filter under test would be untestable
    // through this path and the rest of this file would pass vacuously.
    expect(rows[0]!.enabled).toBe(true);
  });

  it('keeps the retired engagement off the monitoring dashboard', async () => {
    const { monitors } = await listEnabledMonitors(pool);
    const ids = monitors.map((m) => m.valuation_id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(retiredId);
  });

  it('never hands the retired engagement to the scan', async () => {
    const seen: string[] = [];
    for await (const page of eachEnabledMonitor(pool, { pageSize: 1 })) {
      seen.push(...page.map((m) => m.valuation_id));
    }
    // pageSize 1 forces the keyset cursor to walk, so the filter is exercised
    // on every page rather than only on the first.
    expect(seen).toContain(liveId);
    expect(seen).not.toContain(retiredId);
  });

  it('reports the retired engagement as unscanned through the scan endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    // One monitored engagement is left, so the count is the assertion: a scan
    // that still walked the retired one would report two.
    expect(res.json().scanned).toBe(1);
  });

  it('resumes watching when the engagement is un-archived', async () => {
    await pool.query('UPDATE valuations SET archived_at = NULL WHERE id = $1', [retiredId]);
    try {
      const { monitors } = await listEnabledMonitors(pool);
      // Filtering the read rather than disabling the monitor is what makes this
      // reversible — the engagement comes back with the watch it was set up
      // with, instead of having been silently turned off.
      expect(monitors.map((m) => m.valuation_id)).toContain(retiredId);
    } finally {
      await pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retiredId]);
    }
  });
});
