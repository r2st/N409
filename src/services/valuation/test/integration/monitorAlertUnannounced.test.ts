import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

/**
 * A trigger that fired and could not be announced.
 *
 * `monitor_alerts` is the suppressor, not just a log: `notifiedSignaturesFor`
 * reads exactly that table and `recordAlert` is `ON CONFLICT DO NOTHING`, so
 * the row decides whether any later scan will look at the signature again. The
 * scan committed it first and then wrote the spine event and the outbox row as
 * separate statements — on a pool it has been paging through for minutes — so
 * either of them losing a deadlock left the alert recorded, the reviewer never
 * told, and no scan willing to fire it again.
 *
 * Silently: `alerts_sent` counts the sends that happened, and a trigger missing
 * from it looks exactly like a scan on which nothing fired. Which is the one
 * failure a revaluation monitor exists to prevent, and the reason the file's
 * own paging comment gives for not capping the scan — "a trigger that fires and
 * is never emailed is the failure the monitor exists to prevent".
 *
 * Driven by refusing the outbox insert, which is what a deadlock on the enqueue
 * looks like from here — and which is the only database write
 * `sendTransactionalEmail` makes before it starts containing its own failures,
 * so "nothing was queued" is a fact the scan can act on.
 */
describe.skipIf(!dbUp)('a monitor alert that could not be announced', () => {
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
      payload: { kind: '409a', company_name: 'Unannounced Co' },
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
    // Published two years ago, so the expiry trigger fires, and with a reviewer
    // assigned, so there is somebody for the scan to fail to tell.
    await pool.query(
      `UPDATE valuations SET state = 'published', published_at = now() - interval '2 years',
              assigned_reviewer_id = $2
        WHERE id = $1`,
      [valuationId, ops.id],
    );
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/monitor`,
      headers: authHeader(ops.token),
    });
    expect(enabled.statusCode, enabled.body).toBe(201);
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const scan = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/admin/monitors/scan',
      headers: authHeader(ops.token),
    });

  const alertRows = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM monitor_alerts WHERE valuation_id = $1`,
      [valuationId],
    );
    return rows[0]!.n;
  };

  const queued = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM email_outbox
        WHERE valuation_id = $1 AND template_key = 'monitoring_alert'`,
      [valuationId],
    );
    return rows[0]!.n;
  };

  it('takes back the record of an alert nobody was told about', async () => {
    await pool.query(
      `CREATE OR REPLACE FUNCTION test_refuse_monitor_alert() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
         END $$;
       CREATE TRIGGER test_refuse_monitor_alert BEFORE INSERT ON email_outbox
         FOR EACH ROW WHEN (NEW.template_key = 'monitoring_alert')
         EXECUTE FUNCTION test_refuse_monitor_alert()`,
    );
    let body: { alerts_sent: number; unsent: Array<{ valuation_id: string; failure_reason: string }> };
    try {
      const res = await scan();
      // Not a 500. One trigger's bad minute must not cost the rows behind it,
      // and the scan pages the whole enabled book.
      expect(res.statusCode, res.body).toBe(200);
      body = res.json();
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_refuse_monitor_alert ON email_outbox');
    }

    // Said out loud. `alerts_sent: 0` on its own is indistinguishable from a
    // scan on which nothing fired.
    expect(body.alerts_sent).toBe(0);
    expect(body.unsent).toEqual([
      { valuation_id: valuationId, trigger: 'expiry', failure_reason: 'pg.40P01' },
    ]);

    // Nothing was queued — that is the write that was refused — and the record
    // that would have suppressed every later scan has been taken back off.
    expect(await queued()).toBe(0);
    expect(await alertRows()).toBe(0);
  });

  it('re-fires the alert on the next scan, which is what taking it back is for', async () => {
    const res = await scan();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.alerts_sent).toBe(1);
    expect(body.unsent).toEqual([]);
    expect(await queued()).toBe(1);
    expect(await alertRows()).toBe(1);

    // And the dedupe still holds afterwards: taking a row back is for an alert
    // nobody heard, not a licence to re-send one they did.
    const again = await scan();
    expect(again.json().alerts_sent).toBe(0);
    expect(await queued()).toBe(1);
  });
});
