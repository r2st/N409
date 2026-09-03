import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { clearValuationCache } from '../../src/repos/valuations.js';
import { STATE_GROUPS, stoppedEngagementReason } from '../../src/domain/operations.js';

const dbUp = await isDbAvailable();

/**
 * A connector card describing a schedule that will not run (R401, M11).
 *
 * R400 dropped retired and closed engagements out of `findDueConnections`, and
 * did it there rather than by disabling the connection, because a close is
 * reversible: restore the engagement and the schedule picks up where it was.
 *
 * The consequence is that the row keeps saying `connected`, keeps its cadence
 * and keeps a `next_sync_at` that stops advancing — and the status endpoints
 * handed all three to a card reading 'Connected · syncs daily'. Nothing else on
 * the page contradicts it: the workspace's retired banner is gated on
 * `archived_at`, so a called-off engagement carries no banner at all.
 */
describe.skipIf(!dbUp)('the connector status endpoints say whether the schedule runs', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  let closedId: string;
  let retiredId: string;

  const create = async (name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: name },
    });
    return res.json().valuation.id as string;
  };

  const view = async (id: string, path: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/${path}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });

    liveId = await create('Syncing Inc');
    closedId = await create('Called Off Sync Inc');
    await pool.query("UPDATE valuations SET state = 'cancelled'::valuation_state WHERE id = $1", [closedId]);
    retiredId = await create('Withdrawn Sync Inc');
    await pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [retiredId]);
    // The two writes above are raw UPDATEs; production goes through
    // `patchValuation`, which drops the cached row as it commits.
    clearValuationCache();
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  for (const path of ['cap-table/sync', 'hris']) {
    it(`reports a live engagement as scheduled on ${path}`, async () => {
      const body = await view(liveId, path);
      // Non-vacuity: the endpoint really does answer with its provider list, so
      // a `scheduled: false` below is the flag and not an empty body.
      expect(Array.isArray(body.providers)).toBe(true);
      expect(body.providers.length).toBeGreaterThan(0);
      expect(body.scheduled).toBe(true);
      expect(body).not.toHaveProperty('unscheduled_reason');
    });

    it(`reports a called-off engagement as unscheduled on ${path}`, async () => {
      const body = await view(closedId, path);
      expect(body.scheduled).toBe(false);
      expect(body.unscheduled_reason).toBe('closed');
      // The providers stay: the connections keep their settings and resume.
      expect(body.providers.length).toBeGreaterThan(0);
    });

    it(`reports a retired engagement as unscheduled on ${path}`, async () => {
      const body = await view(retiredId, path);
      expect(body.scheduled).toBe(false);
      expect(body.unscheduled_reason).toBe('retired');
    });
  }

  it('answers the same question the sync sweep asks', () => {
    // One predicate for the sweep's WHERE clause and for every status surface —
    // see `stoppedEngagementReason`. Held here so the connector doors, the
    // monitor detail endpoint and the pay panel cannot come to disagree.
    for (const state of STATE_GROUPS.closed) {
      expect(stoppedEngagementReason({ archived_at: null, state })).toBe('closed');
    }
    expect(stoppedEngagementReason({ archived_at: null, state: 'drafted' })).toBeNull();
    expect(stoppedEngagementReason({ archived_at: new Date(), state: 'cancelled' })).toBe('retired');
  });
});
