import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { eachActiveEngagement, listActiveEngagements } from '../../src/repos/engagements.js';
import { STATE_GROUPS } from '../../src/domain/operations.js';

const dbUp = await isDbAvailable();

/**
 * The other way the work stops.
 *
 * `engagementsArchived.test.ts` took retired engagements off the board and out
 * of the SLA sweep. Retirement is the rarer half — the retention sweep's word
 * for a file withdrawn years later. `cancelled`, `timeout` and `ignored` are
 * how work actually stops, the week the client goes quiet, and nothing
 * cascades from them onto the engagement: closing a valuation moves `state`
 * and nothing else, `engagements.current_stage` is written only by
 * `advanceStage`, and nobody is going to advance a file nobody is working.
 *
 * So the row stayed `<> 'complete'` forever, the board listed a called-off
 * engagement among the live ones, and the overdue sweep chased the assigned
 * analyst about it once per tick — writing an `engagement_overdue_reminder`
 * each time onto a spine whose 0001 trigger will not let it be taken back off.
 *
 * Driven off `STATE_GROUPS.closed`, like the predicate under test.
 */
describe.skipIf(!dbUp)('engagement board and SLA sweep drop closed engagements', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  const closedIds: Record<string, string> = {};

  async function seedOverdueEngagement(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    const id = created.json().valuation.id as string;
    // First view is what creates the engagement row at `kickoff`.
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/engagement`,
      headers: authHeader(ops.token),
    });
    if (view.statusCode !== 200) throw new Error(`engagement view failed: ${view.body}`);
    await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/engagement/assign`,
      headers: authHeader(ops.token),
      payload: { analyst_id: analyst.id },
    });
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '400 days' WHERE valuation_id = $1`,
      [id],
    );
    return id;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    analyst = await seedUser(ctx, { roles: ['data'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    liveId = await seedOverdueEngagement('Board Open Inc');
    for (const state of STATE_GROUPS.closed) {
      const id = await seedOverdueEngagement(`Board ${state} Inc`);
      await pool.query('UPDATE valuations SET state = $2::valuation_state WHERE id = $1', [id, state]);
      closedIds[state] = id;
    }
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  it('leaves the closed engagements mid-stage — the engagement row is untouched', async () => {
    for (const [state, id] of Object.entries(closedIds)) {
      const { rows } = await pool.query<{ current_stage: string }>(
        'SELECT current_stage FROM engagements WHERE valuation_id = $1',
        [id],
      );
      // If closing completed the engagement the filter under test would be
      // unreachable and the rest of this file would pass vacuously.
      expect(rows[0]!.current_stage, state).not.toBe('complete');
    }
  });

  it('keeps them off the pipeline board', async () => {
    const { engagements } = await listActiveEngagements(pool);
    const ids = engagements.map((e) => e.valuation_id);
    expect(ids).toContain(liveId);
    for (const [state, id] of Object.entries(closedIds)) expect(ids, state).not.toContain(id);
  });

  it('never hands them to the sweep', async () => {
    const seen: string[] = [];
    // pageSize 1 forces the keyset cursor to walk, so the filter is exercised
    // on every page rather than only on the first.
    for await (const row of eachActiveEngagement(pool, { pageSize: 1 })) seen.push(row.valuation_id);
    expect(seen).toContain(liveId);
    for (const [state, id] of Object.entries(closedIds)) expect(seen, state).not.toContain(id);
  });

  it('does not chase the analyst about them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The live one is the control: a sweep that still walked the closed rows
    // would remind four times rather than once.
    expect(body.reminded).toContain(liveId);
    for (const [state, id] of Object.entries(closedIds)) {
      expect(body.reminded, state).not.toContain(id);
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM email_outbox WHERE valuation_id = $1 AND template_key = 'engagement_overdue'",
        [id],
      );
      expect(rows[0]!.n, state).toBe(0);
    }
  });
});
