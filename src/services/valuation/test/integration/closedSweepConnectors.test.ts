import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  findDueConnections as findDueCapTableConnections,
  upsertConnection as upsertCapTableConnection,
} from '../../src/repos/capTableConnections.js';
import {
  findDueConnections as findDueHrisConnections,
  upsertConnection as upsertHrisConnection,
} from '../../src/repos/hrisConnections.js';
import { STATE_GROUPS } from '../../src/domain/operations.js';

const dbUp = await isDbAvailable();

/**
 * The connector sweeps and an engagement that was called off.
 *
 * `retiredSweepWrites.test.ts` stopped both syncs on a *retired* engagement:
 * "calling Carta at all is telling a third party we are still working a file
 * the firm has withdrawn". Retirement is the rarer half — the retention
 * sweep's word for a file archived years later. `cancelled`, `timeout` and
 * `ignored` are the three terminal states of `WORKFLOW_TRANSITIONS` and are
 * how work actually stops, the week the client goes quiet.
 *
 * Nothing cascades from them onto the connection: closing a valuation moves
 * `state` and leaves `next_sync_at` rolling forward on its own cadence, so the
 * schedule went on calling the provider and applying the client's cap table to
 * a dead engagement — with no end condition, because nothing was going to
 * disable the connection either.
 *
 * Skipped rather than disabled, like retirement: `canRestart` puts a cancelled
 * engagement back to `started`, and the schedule should pick up where it was.
 */
describe.skipIf(!dbUp)('the connector sweeps and a closed engagement', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  const evActor = () => ({ actorType: 'human' as const, actorId: ops.id, source: 'test' });
  const tokens = { accessToken: 'tok', refreshToken: null, expiresAt: null };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  async function newValuation(company: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  const due = async (valuationId: string, table: 'cap_table_connections' | 'hris_connections') => {
    await ctx.pool.query(
      `UPDATE ${table} SET sync_frequency = 'daily', next_sync_at = now() - interval '1 hour'
        WHERE valuation_id = $1`,
      [valuationId],
    );
  };

  const close = (id: string, state: string) =>
    ctx.pool.query('UPDATE valuations SET state = $2::valuation_state WHERE id = $1', [id, state]);

  it('takes a closed engagement out of the cap-table sync, in every closed state', async () => {
    const live = await newValuation('ClosedSweep CapTable Live');
    const closed: Record<string, string> = {};
    for (const state of STATE_GROUPS.closed) closed[state] = await newValuation(`ClosedSweep CapTable ${state}`);

    for (const id of [live, ...Object.values(closed)]) {
      await upsertCapTableConnection(
        ctx.pool,
        { valuationId: id, provider: 'carta', tokens, connectedBy: ops.id },
        evActor(),
      );
      await due(id, 'cap_table_connections');
    }

    // Every one of them is due before the close, so the assertions below are
    // about the state and not about the schedule.
    const before = (await findDueCapTableConnections(ctx.pool, 100)).map((c) => c.valuation_id);
    for (const id of [live, ...Object.values(closed)]) expect(before).toContain(id);

    for (const [state, id] of Object.entries(closed)) await close(id, state);

    const after = (await findDueCapTableConnections(ctx.pool, 100)).map((c) => c.valuation_id);
    // The live twin is the vacuity guard: a query that had simply stopped
    // returning anything would satisfy the assertions below on its own.
    expect(after).toContain(live);
    for (const [state, id] of Object.entries(closed)) expect(after, state).not.toContain(id);
  });

  it('takes a closed engagement out of the HRIS sync too', async () => {
    const live = await newValuation('ClosedSweep Hris Live');
    const dead = await newValuation('ClosedSweep Hris Cancelled');
    for (const id of [live, dead]) {
      await upsertHrisConnection(
        ctx.pool,
        { valuationId: id, provider: 'rippling', tokens, connectedBy: ops.id },
        evActor(),
      );
      await due(id, 'hris_connections');
    }

    const before = (await findDueHrisConnections(ctx.pool, 100)).map((c) => c.valuation_id);
    expect(before).toContain(dead);

    await close(dead, 'cancelled');

    const after = (await findDueHrisConnections(ctx.pool, 100)).map((c) => c.valuation_id);
    expect(after).toContain(live);
    expect(after).not.toContain(dead);
  });

  it('picks the connection back up when the engagement is restarted', async () => {
    // Skipped rather than disabled, because closing is reversible. If the
    // sweep had settled the connection instead, a restart would give back an
    // engagement whose integration had quietly been turned off.
    const id = await newValuation('ClosedSweep CapTable Restarted');
    await upsertCapTableConnection(
      ctx.pool,
      { valuationId: id, provider: 'pulley', tokens, connectedBy: ops.id },
      evActor(),
    );
    await due(id, 'cap_table_connections');
    await close(id, 'ignored');
    expect((await findDueCapTableConnections(ctx.pool, 100)).map((c) => c.valuation_id)).not.toContain(id);

    await ctx.pool.query("UPDATE valuations SET state = 'started' WHERE id = $1", [id]);
    expect((await findDueCapTableConnections(ctx.pool, 100)).map((c) => c.valuation_id)).toContain(id);
  });
});
