import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Who `POST /valuations/:id/engagement/assign` will hand an engagement to.
 *
 * The four other doors that name somebody to act — the reviewer on
 * `/workflow/reassign`, on the bulk action and on `PATCH /valuations/:id`, and
 * a review task's assignee — all go through `assertAssignable`, which refuses a
 * **deactivated** account as well as a suspended one. The analyst door did not:
 * it caught suspension only as a side effect of `isOps` (because `ignored`
 * subtracts every grant) and `deleted_at` subtracts nothing from a role set, so
 * a closed account was accepted.
 *
 * Which is the one axis this guard exists for. `analystChaseBlock` names
 * `closed` first among the reasons the overdue sweep may not write to an
 * assignee, so the engagement came out assigned on the board, un-chased by the
 * sweep, and with its SLA quietly unenforced. `engagementAnalystLifecycle`
 * already assumed in writing that this could not happen.
 *
 * The refusals are asserted together so the ordering stays: a closed account
 * keeps its roles, so asked after `isOps` it would have been refused nothing.
 */
describe.skipIf(!dbUp)('engagement analyst assignment refuses inactive accounts', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let liveAnalyst: Awaited<ReturnType<typeof seedUser>>;
  let closedAnalyst: Awaited<ReturnType<typeof seedUser>>;
  let suspendedAnalyst: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  async function assign(analystId: string | null): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/engagement/assign`,
      headers: authHeader(ops.token),
      payload: { analyst_id: analystId },
    });
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
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Assign Guard Inc' },
    });
    valuationId = created.json().valuation.id as string;
    // First view is what creates the engagement row at `kickoff`.
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/engagement`,
      headers: authHeader(ops.token),
    });
    if (view.statusCode !== 200) throw new Error(`engagement view failed: ${view.body}`);

    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [closedAnalyst.id]);
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'ignored'
       ON CONFLICT DO NOTHING`,
      [suspendedAnalyst.id],
    );
  });
  afterAll(async () => ctx?.teardown());

  it('accepts a live operations account', async () => {
    const res = await assign(liveAnalyst.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().engagement.assigned_analyst_id).toBe(liveAnalyst.id);
  });

  it('refuses a deactivated account, and says the account is the problem', async () => {
    const res = await assign(closedAnalyst.id);
    expect(res.statusCode).toBe(422);
    // Not "there is no user with that id": the id was right.
    expect(res.json().detail).toMatch(/deactivated/i);
  });

  it('refuses a suspended account', async () => {
    const res = await assign(suspendedAnalyst.id);
    expect(res.statusCode).toBe(422);
  });

  it('still refuses a client and an unknown id', async () => {
    expect((await assign(client.id)).statusCode).toBe(422);
    expect((await assign('01J0000000000000000000AAAA')).statusCode).toBe(422);
  });

  it('leaves the assignment where the accepted call put it', async () => {
    const { rows } = await pool.query<{ assigned_analyst_id: string | null }>(
      'SELECT assigned_analyst_id FROM engagements WHERE valuation_id = $1',
      [valuationId],
    );
    expect(rows[0]?.assigned_analyst_id).toBe(liveAnalyst.id);
  });
});
