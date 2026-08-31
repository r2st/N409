import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { listActiveEngagements } from '../../src/repos/engagements.js';

const dbUp = await isDbAvailable();

/**
 * An engagement assignment is checked once, when it is made, and every fact it
 * rests on is changed on a different screen afterwards.
 *
 * `assertAssignableAnalyst` refuses a client, refuses a suspended account and
 * refuses an unknown id — and the reason it gives is the overdue sweep, which
 * emails whoever is assigned, by name, with a client's company and that
 * client's internal SLA state, on a timer. Nothing asked the question a second
 * time. So an analyst whose account an administrator closed the next week —
 * the console's deactivation, or a SCIM `active: false` — kept receiving that
 * mail daily, at an address the platform had just cut off from everything
 * else, about an engagement they can no longer open. The same held for an
 * account suspended with `ignored` and for one moved off the operations team.
 *
 * Two halves to the fix, and this file covers both: the sweep no longer writes
 * to an analyst it may not write to, and it says which engagements it therefore
 * left un-chased rather than reporting a clean run over them.
 */
describe.skipIf(!dbUp)('overdue sweep re-checks the assigned analyst', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let liveAnalyst: Awaited<ReturnType<typeof seedUser>>;
  let closedAnalyst: Awaited<ReturnType<typeof seedUser>>;
  let suspendedAnalyst: Awaited<ReturnType<typeof seedUser>>;
  let demotedAnalyst: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  let closedId: string;
  let suspendedId: string;
  let demotedId: string;
  let unassignedId: string;

  /** An engagement backdated into `kickoff` long enough to be overdue. */
  async function seedOverdueEngagement(name: string, analystId: string | null): Promise<string> {
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
    if (analystId) {
      const assigned = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/engagement/assign`,
        headers: authHeader(ops.token),
        payload: { analyst_id: analystId },
      });
      // The assignment must be accepted while the account is still good: the
      // whole point is that it goes bad afterwards. A test that assigned a
      // already-closed analyst would pass on the route's own refusal and never
      // reach the sweep.
      if (assigned.statusCode !== 200) throw new Error(`assign failed: ${assigned.body}`);
    }
    await pool.query(
      `UPDATE engagements SET stage_entered_at = now() - interval '400 days' WHERE valuation_id = $1`,
      [id],
    );
    return id;
  }

  async function addRole(userId: string, key: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2
       ON CONFLICT DO NOTHING`,
      [userId, key],
    );
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    liveAnalyst = await seedUser(ctx, { roles: ['data'] });
    closedAnalyst = await seedUser(ctx, { roles: ['data'] });
    suspendedAnalyst = await seedUser(ctx, { roles: ['data'] });
    demotedAnalyst = await seedUser(ctx, { roles: ['data'] });

    liveId = await seedOverdueEngagement('Chase Live Inc', liveAnalyst.id);
    closedId = await seedOverdueEngagement('Chase Closed Inc', closedAnalyst.id);
    suspendedId = await seedOverdueEngagement('Chase Suspended Inc', suspendedAnalyst.id);
    demotedId = await seedOverdueEngagement('Chase Demoted Inc', demotedAnalyst.id);
    unassignedId = await seedOverdueEngagement('Chase Nobody Inc', null);

    // The three ways an assignment goes bad after it was made.
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [closedAnalyst.id]);
    await addRole(suspendedAnalyst.id, 'ignored');
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [demotedAnalyst.id]);
  });
  afterAll(async () => ctx?.teardown());

  it('still shows every engagement on the board, with the analyst named', async () => {
    // The board is where a stalled assignment gets noticed, so nulling the
    // email out of the join would have been the wrong fix: it would read as
    // "Unassigned" and hide the thing that needs doing.
    const { engagements } = await listActiveEngagements(pool);
    const byId = new Map(engagements.map((e) => [e.valuation_id, e]));
    expect(byId.get(closedId)?.analyst_email).toBe(closedAnalyst.email);
    expect(byId.get(liveId)?.analyst_email).toBe(liveAnalyst.email);
  });

  it('marks the stalled assignments inactive on the board and leaves the good one alone', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/engagements',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const byId = new Map(
      (res.json().engagements as { valuation_id: string; analyst_active: boolean }[]).map((e) => [
        e.valuation_id,
        e,
      ]),
    );
    expect(byId.get(liveId)?.analyst_active).toBe(true);
    expect(byId.get(closedId)?.analyst_active).toBe(false);
    expect(byId.get(suspendedId)?.analyst_active).toBe(false);
    expect(byId.get(demotedId)?.analyst_active).toBe(false);
    expect(byId.get(unassignedId)?.analyst_active).toBe(false);
  });

  it('chases only the analyst it may still write to', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The live one is the control: all five are overdue, so a sweep that had
    // not re-checked would have reminded four.
    expect(body.reminded).toContain(liveId);
    expect(body.reminded).not.toContain(closedId);
    expect(body.reminded).not.toContain(suspendedId);
    expect(body.reminded).not.toContain(demotedId);
  });

  it('queues no mail to a closed, suspended or demoted analyst', async () => {
    for (const [label, id] of [
      ['closed', closedId],
      ['suspended', suspendedId],
      ['demoted', demotedId],
    ] as const) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM email_outbox
          WHERE valuation_id = $1 AND template_key = 'engagement_overdue'`,
        [id],
      );
      expect(rows[0]!.n, label).toBe(0);
    }
  });

  it('reports the un-chased engagements rather than passing over them in silence', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/engagements/remind-overdue',
      headers: authHeader(ops.token),
    });
    const body = res.json();
    expect(body.unreachable).toContain(closedId);
    expect(body.unreachable).toContain(suspendedId);
    expect(body.unreachable).toContain(demotedId);
    expect(body.unreachable_count).toBe(body.unreachable.length);
    // An engagement with no analyst at all is not an unreachable assignment —
    // it is an unassigned engagement, which the board already says.
    expect(body.unreachable).not.toContain(unassignedId);
    expect(body.unreachable).not.toContain(liveId);
  });
});
