import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import {
  jobAlertRuleStates,
  openJobAlerts,
  resetOpenJobAlerts,
  runJobAlertScan,
} from '../../src/hooks/jobAlerts.js';
import { JOB_SOURCES } from '../../src/domain/jobQueue.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The job monitor's alerting half (design §17.1 item 13).
 *
 * The behaviour worth defending is the one an operator experiences: an alert
 * arrives once, stays visible while it is true, says so when it clears, and
 * does not send 288 identical messages over a day of the same outage.
 */
describe.skipIf(!dbUp)('job queue alerts', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  /** An outbox row stuck in `queued` since `minutes` ago. */
  const stuckEmail = async (minutes: number) => {
    const id = newUlid();
    await pool.query(
      `INSERT INTO email_outbox
         (id, valuation_id, to_email, template_key, subject, body, status, created_at)
       VALUES ($1, $2, 'stuck@test.example.com', 'draft_ready', 'Draft ready', 'body', 'queued',
               now() - make_interval(mins => $3::int))`,
      [id, valuationId, minutes],
    );
    return id;
  };

  const alerts = (query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/v1/admin/jobs/alerts${query}`,
      headers: authHeader(ops.token),
    });

  const scan = () => runJobAlertScan({ pool });

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'QueueCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM job_alerts');
    await pool.query('DELETE FROM email_outbox');
    await pool.query('DELETE FROM notifications');
  });

  it('ships a threshold for every queue', async () => {
    // Read from JOB_SOURCES rather than from a copy of it written here.
    //
    // `job_alert_rules.source` is free text with no foreign key, `evaluateJobAlerts`
    // skips a queue with no rule *silently*, and 0120's seed is a literal list.
    // So a sixth queue joining the union would ship monitored by nothing — and a
    // guard holding its own copy of the five would have gone on passing, which is
    // the vacuous shape this codebase has been bitten by before. Comparing
    // against the vocabulary itself is what makes this line able to fail.
    const res = await alerts();
    expect(res.statusCode).toBe(200);
    const rules = res.json().rules as Array<{ source: string; enabled: boolean }>;
    expect(rules.map((r) => r.source).sort()).toEqual([...JOB_SOURCES].sort());
    expect(rules.every((r) => r.enabled)).toBe(true);
  });

  it('is operations-only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs/alerts',
      headers: authHeader(client.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('stays quiet on a queue that is merely busy', async () => {
    // Twenty messages, none of them old. The default email threshold is 120
    // minutes, and depth is not what it measures.
    for (let i = 0; i < 20; i++) await stuckEmail(3);
    const result = await scan();
    expect(result.opened).toEqual([]);
    expect((await alerts('?open=true')).json().open).toBe(0);
  });

  it('opens one alert on a queue that has stopped', async () => {
    await stuckEmail(60 * 8);
    const result = await scan();
    expect(result.opened).toHaveLength(1);
    expect(result.opened[0]).toMatchObject({ source: 'email', kind: 'stalled' });
    expect(result.opened[0]!.detail).toContain('waiting 8h');
  });

  it('measures the age against the database clock, not the process clock', async () => {
    // `created_at` is written by Postgres, so the age is only an age if the
    // clock it is subtracted from is Postgres' too. Subtracting a JS `new
    // Date()` adds the drift between two hosts to every figure — which shows
    // up first as an alert that reads "7h 59m" for a job inserted at exactly
    // eight hours, and matters because the same skewed number is what the
    // `> stall_minutes` comparison decides on.
    await stuckEmail(60 * 8);
    const result = await scan();
    expect(result.opened).toHaveLength(1);
    // Time only moves forward between the insert and the scan, so the measured
    // age can exceed 480 minutes and can never fall below it. A process clock
    // running even milliseconds behind the database's puts it below.
    expect(result.opened[0]!.observed).toBeGreaterThanOrEqual(480);
    expect(result.opened[0]!.observed).toBeLessThan(481);
  });

  it('notifies the people who can act on it, once', async () => {
    await stuckEmail(60 * 8);
    await scan();
    const { rows: first } = await pool.query(`SELECT * FROM notifications WHERE type = 'job_alert'`);
    expect(first).toHaveLength(1);
    expect(first[0]!.user_id).toBe(ops.id);
    expect(first[0]!.title).toMatch(/Outbound message queue looks stalled/);
    // A client cannot restart a worker, so a client is not told.
    expect(first.every((n: { user_id: string }) => n.user_id !== client.id)).toBe(true);

    // Four more scans against the same unchanged outage.
    for (let i = 0; i < 4; i++) await scan();
    const { rows: after } = await pool.query(`SELECT * FROM notifications WHERE type = 'job_alert'`);
    // Still one. A five-minute sweep over a day-long outage would otherwise
    // send 288 identical messages, which is how a channel gets muted.
    expect(after).toHaveLength(1);
  });

  it('keeps one open alert per queue and kind, and refreshes what it says', async () => {
    await stuckEmail(60 * 8);
    await scan();
    // The outage deepens: the same alert, a worse figure.
    await pool.query(`UPDATE email_outbox SET created_at = now() - interval '20 hours'`);
    const second = await scan();
    expect(second.opened).toEqual([]);
    expect(second.ongoing).toHaveLength(1);
    expect(second.ongoing[0]!.detail).toContain('waiting 20h');

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM job_alerts`);
    expect(rows[0]!.n).toBe(1);
  });

  it('resolves when the queue drains, and says so', async () => {
    await stuckEmail(60 * 8);
    await scan();
    await pool.query(`UPDATE email_outbox SET status = 'sent'`);

    const result = await scan();
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.resolved_at).not.toBeNull();
    // Recovery is notified too: an alert that never says it is over leaves an
    // operator checking a page, which is the habit it was meant to replace.
    const { rows } = await pool.query(`SELECT * FROM notifications WHERE type = 'job_alert_resolved'`);
    expect(rows).toHaveLength(1);

    // The row survives resolution — "this queue was stalled on the 8th" is a
    // question somebody asks a week later.
    const listed = (await alerts()).json().alerts as Array<{ resolved_at: string | null }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.resolved_at).not.toBeNull();
    expect((await alerts('?open=true')).json().alerts).toHaveLength(0);
  });

  it('closes an alert when its rule is turned off rather than freezing it open', async () => {
    await stuckEmail(60 * 8);
    await scan();
    expect((await alerts('?open=true')).json().open).toBe(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/jobs/alert-rules/email',
      headers: authHeader(ops.token),
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().rule.enabled).toBe(false);

    await scan();
    expect((await alerts('?open=true')).json().open).toBe(0);

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/jobs/alert-rules/email',
      headers: authHeader(ops.token),
      payload: { enabled: true },
    });
  });

  it('re-evaluates on demand for an operator who has just fixed something', async () => {
    await stuckEmail(60 * 8);
    await scan();
    await pool.query(`UPDATE email_outbox SET status = 'sent'`);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/jobs/alerts/scan',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolved).toHaveLength(1);
  });

  it('rejects a threshold nothing could ever cross', async () => {
    // A rule that never fires reads exactly like a healthy queue, which is the
    // failure mode the whole feature exists to remove.
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/jobs/alert-rules/email',
      headers: authHeader(ops.token),
      payload: { stall_minutes: 999_999 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('404s on a queue that does not exist', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/jobs/alert-rules/not_a_queue',
      headers: authHeader(ops.token),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it('records the open and the close on the admin event spine', async () => {
    // `admin_events` is append-only by trigger (0047), so the tests above have
    // left rows behind; this reads only what this one wrote.
    const { rows: mark } = await pool.query<{ now: Date }>('SELECT now() AS now');
    await stuckEmail(60 * 8);
    await scan();
    await pool.query(`UPDATE email_outbox SET status = 'sent'`);
    await scan();

    const { rows } = await pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM admin_events
        WHERE type IN ('job_alert_opened', 'job_alert_resolved')
          AND occurred_at >= $1
        ORDER BY occurred_at ASC`,
      [mark[0]!.now],
    );
    expect(rows.map((r) => r.type)).toEqual(['job_alert_opened', 'job_alert_resolved']);
    expect(rows[0]!.payload).toMatchObject({ source: 'email', kind: 'stalled' });
    expect(rows[1]!.payload).toHaveProperty('open_minutes');
  });
});

/**
 * The half of alerting that is not "did the alert fire" but "did anyone hear it".
 *
 * 0120 reconciled the ledger in one transaction and then notified off the
 * result, outside it. Anything that threw in that loop lost the rest of the
 * batch and — because the ledger already recorded those alerts as open — lost
 * them permanently: the next scan saw `ongoing`, which is deliberately silent.
 * A row said an operator had been told and no operator had been.
 *
 * The failure injected below is the one that actually happens. A queue stalls
 * because the database is struggling, so the announcement writes are executing
 * against exactly the database that just made the queue stall; a dropped
 * connection there is the ordinary case, not the exotic one.
 */
describe.skipIf(!dbUp)('job queue alert delivery', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  /**
   * A pool that fails chosen statements, on both the pool and the clients
   * `withTransaction` checks out.
   *
   * The client is wrapped in a Proxy rather than patched: a checked-out client
   * goes back to the real pool on release, and a patched `query` would follow
   * it there and fail unrelated work later in the run.
   */
  const flakyPool = (fail: (sql: string) => boolean): pg.Pool => {
    const sqlOf = (arg: unknown) =>
      typeof arg === 'string' ? arg : ((arg as { text?: string } | null)?.text ?? '');
    const guard = (arg: unknown) => {
      if (fail(sqlOf(arg))) throw new Error('connection terminated unexpectedly');
    };
    return {
      query: (...args: unknown[]) => {
        guard(args[0]);
        return (pool.query as (...a: unknown[]) => unknown)(...args);
      },
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, prop) {
            if (prop === 'query') {
              return (...args: unknown[]) => {
                guard(args[0]);
                return (target.query as (...a: unknown[]) => unknown)(...args);
              };
            }
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
  };

  /** Fails every notification insert — the last write in an announcement. */
  const notifyIsDown = () => flakyPool((sql) => sql.includes('INSERT INTO notifications'));

  const stuckEmail = async (minutes: number) => {
    await pool.query(
      `INSERT INTO email_outbox
         (id, valuation_id, to_email, template_key, subject, body, status, created_at)
       VALUES ($1, $2, 'stuck@test.example.com', 'draft_ready', 'Draft ready', 'body', 'queued',
               now() - make_interval(mins => $3::int))`,
      [newUlid(), valuationId, minutes],
    );
  };

  /** `failure_count` for email is 10, so this is what makes the queue "failing". */
  const failedEmails = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO email_outbox
           (id, valuation_id, to_email, template_key, subject, body, status, created_at)
         VALUES ($1, $2, 'dead@test.example.com', 'draft_ready', 'Draft ready', 'body', 'failed', now())`,
        [newUlid(), valuationId],
      );
    }
  };

  const scan = (p: pg.Pool = pool) => runJobAlertScan({ pool: p });

  /**
   * A scan run the way the boot interval runs it.
   *
   * `nonOverlapping` hands a rejecting tick to `onError` and carries on, so a
   * scan that throws is logged and forgotten in production — the schedule
   * survives and the operator hears nothing. Swallowing it here the same way
   * keeps these tests pointed at the consequence (was the alert ever
   * announced?) rather than at whether the throw escapes, which is the part a
   * caller already tolerates.
   */
  const sweep = async (p: pg.Pool = pool) => {
    try {
      return await scan(p);
    } catch {
      return null;
    }
  };
  const notifications = async (type: string) => {
    const { rows } = await pool.query(`SELECT * FROM notifications WHERE type = $1`, [type]);
    return rows;
  };
  const ledger = async () => {
    const { rows } = await pool.query<{ resolved_at: Date | null }>(
      `SELECT * FROM job_alerts ORDER BY opened_at ASC`,
    );
    return rows;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'DeliveryCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM job_alerts');
    await pool.query('DELETE FROM email_outbox');
    await pool.query('DELETE FROM notifications');
  });

  it('announces an alert whose first announcement failed, on the next scan', async () => {
    await stuckEmail(60 * 8);

    await sweep(notifyIsDown());
    // The alert is in the ledger: reconciling committed before the announcement
    // was ever attempted. And nobody has been told.
    expect(await ledger()).toHaveLength(1);
    expect(await notifications('job_alert')).toHaveLength(0);

    // This is where the alert used to be lost for good. The row is open, so
    // every later scan reconciles it as `ongoing`, and `ongoing` is silent by
    // design — the ledger said an operator had been told, and none had.
    const second = await sweep();
    expect(second?.opened).toEqual([]);
    expect(second?.ongoing).toHaveLength(1);

    // Asserted before the tally so that a regression reports the thing that
    // matters — an empty notification list for a queue that has been stopped
    // for eight hours — rather than a missing counter.
    const sent = await notifications('job_alert');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.user_id).toBe(ops.id);
    expect(sent[0]!.title).toMatch(/Outbound message queue looks stalled/);
    expect(second?.notified).toMatchObject({ opened: 1, failed: 0 });
  });

  it('does not let one failed announcement suppress the others in the batch', async () => {
    // Two alerts on one queue: stalled, and failing.
    await stuckEmail(60 * 8);
    await failedEmails(10);

    const first = await sweep(notifyIsDown());
    expect(await ledger()).toHaveLength(2);
    expect(await notifications('job_alert')).toHaveLength(0);

    // Both are still owed, so both arrive. Losing the second alert because the
    // first could not be sent is the failure being ruled out.
    const second = await sweep();
    const sent = await notifications('job_alert');
    expect(sent.map((n: { title: string }) => n.title).sort()).toEqual([
      'Outbound message queue is failing',
      'Outbound message queue looks stalled',
    ]);
    // And both were attempted on the failing sweep rather than the batch dying
    // on the first: the old loop threw out of the whole scan on alert one and
    // never reached alert two, so the number that separates the two designs
    // is 2, not 1.
    expect(first?.notified).toMatchObject({ opened: 0, failed: 2 });
    expect(second?.notified).toMatchObject({ opened: 2, failed: 0 });
  });

  it('rolls back the admin event when the announcement it belongs to fails', async () => {
    // The stamp, the admin event and the notification are one transaction, so a
    // half-written announcement cannot leave an audit row claiming an operator
    // was told. Without that, the retry double-records the open on the spine.
    const { rows: mark } = await pool.query<{ now: Date }>('SELECT now() AS now');
    await stuckEmail(60 * 8);

    await sweep(notifyIsDown());
    const since = async () => {
      const { rows } = await pool.query(
        `SELECT type FROM admin_events
          WHERE type IN ('job_alert_opened', 'job_alert_resolved') AND occurred_at >= $1`,
        [mark[0]!.now],
      );
      return rows;
    };
    expect(await since()).toHaveLength(0);

    await sweep();
    expect(await since()).toHaveLength(1);
  });

  it('announces a recovery that was owed, and only once', async () => {
    await stuckEmail(60 * 8);
    await scan();
    expect(await notifications('job_alert')).toHaveLength(1);

    await pool.query(`UPDATE email_outbox SET status = 'sent'`);
    const cleared = await sweep(notifyIsDown());
    expect((await ledger())[0]!.resolved_at).not.toBeNull();
    expect(await notifications('job_alert_resolved')).toHaveLength(0);

    // A resolved alert leaves the open set for good, so nothing in a later
    // reconcile's result would ever mention it again — the recovery is owed by
    // the ledger or it is owed by nobody.
    await sweep();
    expect(await notifications('job_alert_resolved')).toHaveLength(1);
    expect(cleared?.notified).toMatchObject({ resolved: 0, failed: 1 });

    // And the retry does not become a second announcement on later sweeps.
    await sweep();
    await sweep();
    expect(await notifications('job_alert_resolved')).toHaveLength(1);
    expect(await notifications('job_alert')).toHaveLength(1);
  });

  it('announces once when two sweeps run at the same time', async () => {
    // The sweep runs on every instance and from the ops route, so two of them
    // landing on the same owed announcement is ordinary. The delivery
    // transaction takes the row FOR UPDATE with the NULL check in the
    // predicate, so the loser matches nothing and sends nothing.
    await stuckEmail(60 * 8);
    await sweep(notifyIsDown());
    expect(await notifications('job_alert')).toHaveLength(0);

    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(await notifications('job_alert')).toHaveLength(1);
    // Exactly one of the two did the sending, and it says so.
    expect((a?.notified.opened ?? 0) + (b?.notified.opened ?? 0)).toBe(1);
  });

  it('leaves the open set where a scrape can read it, and says nothing before the first scan', async () => {
    /*
     * R321. This subsystem decides that a queue has stopped, and it told an
     * in-app notification list, the admin trail and the journal — three
     * channels, none of them the one an on-call rotation reads. The comment on
     * `auto_pipeline_runs_pending` delegates the DB-backed backlogs to this
     * sweep on the grounds that a count query per scrape is the wrong shape;
     * what it did not say is that the delegate reported nowhere a rule could
     * see. The snapshot is what `job_queue_alert_open` is built from.
     *
     * Null before any scan, and that is the load-bearing half: a process whose
     * job-alert sweep is switched off or has never run must not publish a row
     * of reassuring zeros. Whether the sweep is running at all is
     * `SweepStopped`'s question, and it has its own answer.
     */
    resetOpenJobAlerts();
    expect(openJobAlerts()).toBeNull();

    await stuckEmail(60 * 8);
    await scan();
    expect(openJobAlerts()).toEqual([{ source: 'email', kind: 'stalled' }]);

    // Still open on the next scan — `ongoing`, which notifies nobody a second
    // time and must not therefore drop out of the gauge.
    await scan();
    expect(openJobAlerts()).toEqual([{ source: 'email', kind: 'stalled' }]);

    await pool.query(`UPDATE email_outbox SET status = 'sent' WHERE status = 'queued'`);
    await scan();
    expect(openJobAlerts()).toEqual([]);
  });

  it('says which queues it was in a position to judge, not just what it found', async () => {
    /*
     * R329. The snapshot above is the monitor's verdict. This is whether it
     * reached one at all — and before this, a queue with no *enabled rule*
     * reported through `job_queue_alert_open` exactly as a healthy watched one
     * does. `evaluateJobAlerts` skips a disabled or missing rule entirely and
     * `reconcileJobAlerts` resolves whatever was open, so the queue produced no
     * findings, the gauge published a confident 0 per kind, and
     * `JobQueueAlertOpen` could never fire for it again.
     *
     * That is not a corner: the comment on `auto_pipeline_runs_pending` sends
     * every DB-backed backlog here on the grounds that a count query per scrape
     * is the wrong shape, so for the outbox and the webhook deliveries that
     * zero was the whole of the platform's monitoring.
     *
     * The two ways in are separated because they are different incidents.
     * `disabled` is a choice made in the admin console and nothing alerts on
     * it. `unconfigured` — a source in JOB_SOURCES with no row in
     * `job_alert_rules` — is nobody's choice at all.
     */
    resetOpenJobAlerts();
    expect(jobAlertRuleStates(), 'nothing has looked yet').toBeNull();

    await scan();
    expect(jobAlertRuleStates()).toEqual({
      pipeline_run: 'enabled',
      ai_job: 'enabled',
      calculation: 'enabled',
      email: 'enabled',
      webhook_delivery: 'enabled',
    });

    await pool.query(`UPDATE job_alert_rules SET enabled = false WHERE source = 'email'`);
    await pool.query(`DELETE FROM job_alert_rules WHERE source = 'webhook_delivery'`);
    try {
      await scan();
      expect(jobAlertRuleStates()).toMatchObject({
        email: 'disabled',
        webhook_delivery: 'unconfigured',
        ai_job: 'enabled',
      });
    } finally {
      // The seed from migration 0120; this table is not truncated between tests.
      await pool.query(`UPDATE job_alert_rules SET enabled = true WHERE source = 'email'`);
      await pool.query(
        `INSERT INTO job_alert_rules (source, stall_minutes, failure_count, failure_window_hours)
         VALUES ('webhook_delivery', 120, 10, 24) ON CONFLICT (source) DO NOTHING`,
      );
    }
  });

  it('records the states even when every rule is off, which is when it matters most', async () => {
    // The all-disabled path early-returns before the evaluation. Snapshotting
    // after that return would leave the one deployment where every queue is
    // unwatched reporting last week's states — or nothing at all.
    resetOpenJobAlerts();
    await pool.query(`UPDATE job_alert_rules SET enabled = false`);
    try {
      await scan();
      expect(Object.values(jobAlertRuleStates() ?? {})).toEqual([
        'disabled',
        'disabled',
        'disabled',
        'disabled',
        'disabled',
      ]);
    } finally {
      await pool.query(`UPDATE job_alert_rules SET enabled = true`);
    }
  });

  it('still announces recoveries when every rule is turned off', async () => {
    await stuckEmail(60 * 8);
    await scan();

    await pool.query(`UPDATE job_alert_rules SET enabled = false`);
    try {
      // Disabling every rule closes the open alerts. That early-returns before
      // the evaluation, and the recovery is owed to the same operator.
      const result = await sweep();
      expect(result?.resolved).toHaveLength(1);
      expect(await notifications('job_alert_resolved')).toHaveLength(1);
      expect(result?.notified).toMatchObject({ resolved: 1, failed: 0 });
    } finally {
      await pool.query(`UPDATE job_alert_rules SET enabled = true`);
    }
  });
});
