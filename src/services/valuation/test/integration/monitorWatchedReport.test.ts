import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { listEnabledMonitors, unwatchedReason } from '../../src/repos/monitors.js';
import { clearValuationCache, findValuationById } from '../../src/repos/valuations.js';
import { STATE_GROUPS } from '../../src/domain/operations.js';

const dbUp = await isDbAvailable();

/**
 * A watch that nothing walks, reported as a live one (R401, methodology M11).
 *
 * `monitoringArchived` and R400's `monitoringClosed` took retired and closed
 * engagements out of the scan and out of the ops dashboard, both through
 * `ENABLED_MONITOR_SELECT`. What neither reached is `findMonitor`, which is
 * what `GET /api/v1/valuations/:id/monitor` answers off: it reads the monitor
 * row and asks the engagement nothing.
 *
 * So the one surface somebody consults to find out whether an engagement is
 * being watched was the one still claiming it is — enabled, with a live status
 * badge and a `checked` stamp that quietly stops advancing. The triggers on it
 * are real; the claim that anything will act on them is not.
 */
describe.skipIf(!dbUp)('the monitor detail endpoint says whether anything is watching', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  let closedId: string;
  let retiredId: string;

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

  const monitorView = async (id: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    liveId = await seedMonitoredValuation('Still Watched Inc');
    // Both stopped *after* the watch was set up, which is what production does
    // and what the enable door cannot prevent.
    closedId = await seedMonitoredValuation('Called Off Inc');
    await pool.query("UPDATE valuations SET state = 'cancelled'::valuation_state WHERE id = $1", [closedId]);
    retiredId = await seedMonitoredValuation('Withdrawn Inc');
    await pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retiredId]);
    // `findValuationById` is cached and the two writes above are raw UPDATEs,
    // which is not how production stops an engagement — `patchValuation` and
    // `applyValuationState` drop the entry as they commit. Without this the
    // route reads the row as it was before the close and every assertion below
    // passes or fails on a stale answer rather than on the predicate.
    clearValuationCache();
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  it('says a live engagement is watched', async () => {
    const body = await monitorView(liveId);
    // Non-vacuity for the two below: the endpoint does answer with an enabled
    // monitor, so a `watched: false` there is the flag and not an empty body.
    expect(body.monitor?.enabled).toBe(true);
    expect(body.watched).toBe(true);
    expect(body).not.toHaveProperty('unwatched_reason');
  });

  it('says a called-off engagement is not, and why', async () => {
    const body = await monitorView(closedId);
    expect(body.watched).toBe(false);
    expect(body.unwatched_reason).toBe('closed');
    // The watch is reported dormant, not turned off: the row is untouched and
    // the triggers are still evaluated, because that is what resumes.
    expect(body.monitor?.enabled).toBe(true);
    expect(body.current).toBeDefined();
  });

  it('says the same about a retired one', async () => {
    const body = await monitorView(retiredId);
    expect(body.watched).toBe(false);
    expect(body.unwatched_reason).toBe('retired');
    expect(body.monitor?.enabled).toBe(true);
  });

  it('answers exactly what the scan filter answers, over every state', async () => {
    // The two readers ask at different times about different things — the scan
    // asks the database for a set, the endpoint asks about a row it holds — so
    // the only thing keeping them from drifting is this.
    const listed = new Set((await listEnabledMonitors(pool, { limit: 500 })).monitors.map((m) => m.valuation_id));
    // Non-vacuity: the list has to actually contain something.
    expect(listed.has(liveId)).toBe(true);

    for (const id of [liveId, closedId, retiredId]) {
      const valuation = (await findValuationById(pool, id))!;
      expect([id, unwatchedReason(valuation) === null]).toEqual([id, listed.has(id)]);
    }

    // And over every closed state, not only the one seeded above: the scan's
    // list is built from `STATE_GROUPS.closed` and the predicate must be too.
    for (const state of STATE_GROUPS.closed) {
      expect(unwatchedReason({ archived_at: null, state })).toBe('closed');
    }
    expect(unwatchedReason({ archived_at: null, state: 'drafted' })).toBeNull();
    // Retirement is asked first, so a file that is both says the thing that
    // happened to it last.
    expect(unwatchedReason({ archived_at: new Date(), state: 'cancelled' })).toBe('retired');
  });
});
