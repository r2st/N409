import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

/**
 * A trigger that fired and had nobody to be told (R353, methodology M11).
 *
 * `monitorAlertUnannounced.test.ts` beside this one covers the alert that could
 * not be *sent* — a deadlock on the outbox insert — and the scan handles it
 * carefully: the suppressor comes back off, the failure is named in `unsent`,
 * and the next scan owes the alert again.
 *
 * This is the case that threw nothing. The email goes to
 * `valuation.assigned_reviewer_id`, monitoring is enabled on a *completed*
 * engagement — which is precisely when a reviewer is likeliest to have been
 * unassigned, or to have left and had their account closed — and the alert row
 * is already committed by the time the recipient is looked at. So the signature
 * is marked handled, no later scan fires it again, `alerts_sent` counts a send
 * that did not happen to be one, and `unsent` is empty because nothing failed.
 *
 * A safe-harbor expiry reaching nobody, permanently, and the scan returning the
 * pair of numbers a healthy pass returns.
 */
describe.skipIf(!dbUp)('a monitor alert with no one to send it to', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Unrouted Co' },
    });
    valuationId = created.json().valuation.id as string;
    await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 't',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 1.2, approaches: {} },
        equityValue: 3_000_000,
        fmvPerShare: 1.2,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    // Published two years ago so the expiry trigger fires, and with no reviewer
    // assigned — which is the whole of this case.
    await pool.query(
      `UPDATE valuations SET state = 'published', published_at = now() - interval '2 years',
              assigned_reviewer_id = NULL
        WHERE id = $1`,
      [valuationId],
    );
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(enabled.statusCode, enabled.body).toBe(201);
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  it('says so rather than reporting the numbers of a scan on which nothing fired', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      alerts_sent: number;
      unsent: unknown[];
      unrouted_count: number;
      unrouted: Array<{ valuation_id: string; trigger: string }>;
    };

    // Nothing failed, so `unsent` is empty and `alerts_sent` is zero — which
    // between them are exactly what a scan that found nothing due reports.
    expect(body.alerts_sent).toBe(0);
    expect(body.unsent).toEqual([]);
    // The field that separates the two.
    expect(body.unrouted_count).toBe(1);
    expect(body.unrouted).toContainEqual({ valuation_id: valuationId, trigger: 'expiry' });

    // And the suppressor is deliberately left in place: re-firing every scan
    // would announce it to the same nobody. The remedy is assigning a reviewer,
    // which is what the list above is for.
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM monitor_alerts WHERE valuation_id = $1',
      [valuationId],
    );
    expect(rows[0]!.n).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });
    expect(second.json().unrouted_count).toBe(0);
  });
});
