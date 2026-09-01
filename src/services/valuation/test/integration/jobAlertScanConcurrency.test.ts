import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { runJobAlertScan } from '../../src/hooks/jobAlerts.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/** `SWEEP_LOCKS.jobAlertScan` in `db/sweepLock.ts` — 'n4JA'. */
const SCAN_LOCK_KEY = 0x6e34_4a41;

/**
 * Two job-alert scans at once.
 *
 * `reconcileJobAlerts` has held a transaction-scoped advisory lock since it was
 * written, and the scan route cited it as the reason a double-press was safe.
 * It makes the *ledger* consistent. It does not make the pass's conclusions
 * consistent: `jobStats`, `oldestActiveJobs` and the clock are all read before
 * that lock is taken, so two overlapping passes reconcile pictures of the
 * queues taken at different moments, and the one that commits second is not
 * necessarily the one that looked last.
 *
 * The damaging interleaving is a queue recovering between the two reads. The
 * pass that looked afterwards resolves the alert and announces the recovery;
 * the pass that looked before then finds the stall still there, cannot see the
 * alert that was just closed, opens a new one and announces *that*. The
 * operator is told a healthy queue has stalled, and the `ongoing` silence —
 * what stops a day-long outage sending 288 messages — is bypassed, because to
 * the ledger the second alert is genuinely new.
 *
 * Overlapping is ordinary rather than exotic: `POST /admin/jobs/alerts/scan` is
 * a button an operator presses after restarting a worker, the five-minute tick
 * can land on a pass still reading five unioned tables, and `scheduleSweep`'s
 * non-overlap guard covers only the timer — the route goes nowhere near it.
 *
 * Driven by holding the sweep lock on a connection of the test's own, so "the
 * second scan arrived while the first was running" is an assertion rather than
 * two calls raced against each other and hoped to overlap. The queue is then
 * drained under that held lock, which is exactly the state the stale pass
 * reconciles against.
 */
describe.skipIf(!dbUp)('a second job-alert scan while one is running', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const stuckEmail = async (minutes: number) => {
    await pool.query(
      `INSERT INTO email_outbox
         (id, valuation_id, to_email, template_key, subject, body, status, created_at)
       VALUES ($1, $2, 'stuck@test.example.com', 'draft_ready', 'Draft ready', 'body', 'queued',
               now() - make_interval(mins => $3::int))`,
      [newUlid(), valuationId, minutes],
    );
  };

  const openAlertRows = async () => {
    const { rows } = await pool.query<{ id: string; source: string; resolved_at: Date | null }>(
      `SELECT id, source, resolved_at FROM job_alerts WHERE resolved_at IS NULL`,
    );
    return rows;
  };

  const jobAlertNotifications = async () => {
    const { rows } = await pool.query<{ type: string }>(
      `SELECT type FROM notifications WHERE type LIKE 'job_alert%' ORDER BY created_at`,
    );
    return rows.map((r) => r.type);
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Overlapping Scan Co' },
    });
    expect(created.statusCode, created.body).toBe(201);
    valuationId = created.json().valuation.id;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  beforeEach(async () => {
    await pool.query('DELETE FROM job_alerts');
    await pool.query('DELETE FROM email_outbox');
    await pool.query('DELETE FROM notifications');
  });

  it('declines the pass instead of reconciling a second, differently-aged picture', async () => {
    await stuckEmail(60 * 8);
    const first = await runJobAlertScan({ pool });
    expect(first.skipped).toBe(false);
    expect(first.opened).toHaveLength(1);
    const opened = await openAlertRows();
    expect(opened).toHaveLength(1);
    expect(await jobAlertNotifications()).toEqual(['job_alert']);

    const holder = await pool.connect();
    try {
      const { rows } = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
        SCAN_LOCK_KEY,
      ]);
      expect(rows[0]!.locked).toBe(true);

      // The queue recovers while that pass is out. A scan arriving now is the
      // one whose reconcile would race the holder's.
      await pool.query(`UPDATE email_outbox SET status = 'sent'`);

      const second = await runJobAlertScan({ pool });
      expect(second.skipped).toBe(true);
      expect(second.opened).toEqual([]);
      expect(second.resolved).toEqual([]);
      expect(second.evaluated).toBe(0);

      // The ledger is untouched: the same alert row, still open. Resolving it
      // here is what lets the holder's stale finding open a second one.
      expect(await openAlertRows()).toEqual(opened);
      // And nobody was told a thing by a pass that did nothing.
      expect(await jobAlertNotifications()).toEqual(['job_alert']);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [SCAN_LOCK_KEY]);
      holder.release();
    }
  });

  it('resolves and announces once the lock is free, so the refusal is not a permanent stop', async () => {
    // The other half of a `try` lock: the refusal has to be about contention
    // and nothing else, or the scan quietly stops for the life of the process.
    await stuckEmail(60 * 8);
    expect((await runJobAlertScan({ pool })).opened).toHaveLength(1);
    await pool.query(`UPDATE email_outbox SET status = 'sent'`);

    const after = await runJobAlertScan({ pool });
    expect(after.skipped).toBe(false);
    expect(after.resolved).toHaveLength(1);
    expect(await openAlertRows()).toEqual([]);
    expect(await jobAlertNotifications()).toEqual(['job_alert', 'job_alert_resolved']);
  });

  it('tells the operator that the button did nothing, rather than answering with zeros', async () => {
    // `opened: [], resolved: [], evaluated: 0` is also what a healthy platform
    // looks like. Without `skipped` the two are the same answer.
    await stuckEmail(60 * 8);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_try_advisory_lock($1)', [SCAN_LOCK_KEY]);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/jobs/alerts/scan',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().skipped).toBe(true);
      expect(await openAlertRows()).toEqual([]);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [SCAN_LOCK_KEY]);
      holder.release();
    }
  });
});
