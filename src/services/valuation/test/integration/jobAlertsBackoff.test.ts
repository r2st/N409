import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { runJobAlertScan } from '../../src/hooks/jobAlerts.js';
import { oldestActiveJobs } from '../../src/repos/jobs.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A queue backing off on purpose is not a queue that has stalled.
 *
 * Two of the five queues express a deliberate wait as an *active* status. A
 * webhook delivery sits at `pending` for the whole of its retry ladder (0103),
 * and 0139 widened that ladder to 1+5+30+120+360 minutes precisely so a
 * receiver that is down overnight would be survived rather than dropped.
 * `job_alert_rules` still carries the `stall_minutes` 0120 chose when the same
 * ladder reached 36 minutes: 120.
 *
 * Anchoring the stall age at `created_at` therefore turned the fix into the
 * alarm. A partner's receiver going down for three hours — the case 0139 exists
 * for — put every one of that partner's deliveries past the threshold, and an
 * operator was paged that *our* webhook queue was stalled while it was doing
 * exactly what it was designed to do. `partner_webhook_deliveries`' own stats
 * endpoint has counted `status = 'pending' AND next_attempt_at <= now()` as
 * `due` since 0103; the monitor that pages someone did not ask.
 *
 * So the measure is `due_at` — each queue's own claim predicate. A row that is
 * not yet claimable is not late, and the age of one that is runs from when it
 * became claimable rather than from when it was born.
 */
describe.skipIf(!dbUp)('job alerts and the retry ladder', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let webhookId: string;

  /**
   * A delivery created `createdMinutes` ago whose next attempt is
   * `dueInMinutes` from now — negative for one that is already overdue.
   */
  const delivery = async (createdMinutes: number, dueInMinutes: number) => {
    const id = newUlid();
    await pool.query(
      `INSERT INTO partner_webhook_deliveries
         (id, webhook_id, event_type, valuation_id, payload, status, attempts,
          created_at, next_attempt_at)
       VALUES ($1, $2, 'valuation.state_changed', $3, '{}'::jsonb, 'pending', 3,
               now() - make_interval(mins => $4::int),
               now() + make_interval(mins => $5::int))`,
      [id, webhookId, valuationId, createdMinutes, dueInMinutes],
    );
    return id;
  };

  /** An outbox row queued `createdMinutes` ago, optionally with a schedule. */
  const queuedEmail = async (createdMinutes: number, dueInMinutes: number | null) => {
    const id = newUlid();
    await pool.query(
      `INSERT INTO email_outbox
         (id, valuation_id, to_email, template_key, subject, body, status,
          created_at, next_attempt_at)
       VALUES ($1, $2, 'held@test.example.com', 'draft_ready', 'Draft ready', 'body', 'queued',
               now() - make_interval(mins => $3::int),
               CASE WHEN $4::int IS NULL THEN NULL
                    ELSE now() + make_interval(mins => $4::int) END)`,
      [id, valuationId, createdMinutes, dueInMinutes],
    );
    return id;
  };

  const scan = () => runJobAlertScan({ pool });

  const stats = async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs/stats',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      by_source: Array<{ source: string; active: number; oldest_active_at: string | null }>;
    };
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
      payload: { kind: '409a', company_name: 'BackoffCo' },
    });
    valuationId = created.json().valuation.id;

    const partnerId = await seedPartner(ctx, 'Backoff Firm');
    webhookId = newUlid();
    await pool.query(
      `INSERT INTO partner_webhooks (id, partner_id, url, secret)
       VALUES ($1, $2, 'https://receiver.test/hook', 's')`,
      [webhookId, partnerId],
    );
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM job_alerts');
    await pool.query('DELETE FROM partner_webhook_deliveries');
    await pool.query('DELETE FROM email_outbox');
    await pool.query('DELETE FROM notifications');
  });

  it('stays quiet while a delivery is waiting out its backoff', async () => {
    // Four hours into the ladder, six hours until the next attempt: the exact
    // shape of an overnight receiver outage that 0139 widened the ladder for.
    await delivery(4 * 60, 6 * 60);
    const result = await scan();
    expect(result.opened).toEqual([]);
  });

  it('still shows the waiting delivery as outstanding work', async () => {
    // Quiet is not the same as hidden. The count comes from `jobStats`, which
    // is unfiltered — an operator can see the backlog on the page and choose
    // to look; what they are not is woken up for it.
    await delivery(4 * 60, 6 * 60);
    const hook = (await stats()).by_source.find((s) => s.source === 'webhook_delivery')!;
    expect(hook.active).toBe(1);
    // Nothing is late, so there is no waiting time to report.
    expect(hook.oldest_active_at).toBeNull();
  });

  it('alerts when a delivery has been claimable and untouched past the threshold', async () => {
    // Same age, but its attempt came due three hours ago and no sweep took it.
    // That is the sweep being down, which is what the rule is for.
    await delivery(4 * 60, -3 * 60);
    const result = await scan();
    expect(result.opened).toHaveLength(1);
    expect(result.opened[0]).toMatchObject({ source: 'webhook_delivery', kind: 'stalled' });
    // Measured from when it became due, not from when it was created: three
    // hours, not four. The difference is the whole point — a figure taken from
    // `created_at` reports the ladder's own patience as lateness.
    expect(result.opened[0]!.observed).toBeGreaterThanOrEqual(180);
    expect(result.opened[0]!.observed).toBeLessThan(181);
  });

  it('does not let a waiting delivery mask an overdue one', async () => {
    // `min()` over the union would have picked the older row. It is the one
    // that is *late* that has to set the figure.
    await delivery(9 * 60, 6 * 60);
    await delivery(4 * 60, -3 * 60);
    const result = await scan();
    expect(result.opened).toHaveLength(1);
    expect(result.opened[0]!.observed).toBeLessThan(181);
  });

  it('holds an outbox row to its schedule, and treats no schedule as due now', async () => {
    // 0159 inverted the sense the pipeline ladder uses: NULL here means "no
    // wait", which is what a fresh row and a crash-stranded row both carry.
    await queuedEmail(8 * 60, 60);
    expect((await scan()).opened).toEqual([]);

    await pool.query('DELETE FROM job_alerts');
    await queuedEmail(8 * 60, null);
    const result = await scan();
    expect(result.opened).toHaveLength(1);
    expect(result.opened[0]).toMatchObject({ source: 'email', kind: 'stalled' });
    expect(result.opened[0]!.observed).toBeGreaterThanOrEqual(480);
  });

  it('reports the oldest due job per queue, not the oldest row', async () => {
    await delivery(9 * 60, 6 * 60);
    await delivery(4 * 60, -3 * 60);
    const rows = await oldestActiveJobs(pool);
    const hook = rows.find((r) => r.source === 'webhook_delivery')!;
    // One of the two is due; the other is not counted at all.
    expect(hook.active).toBe(1);
    const dueMinutesAgo = (Date.now() - hook.oldest_due_at.getTime()) / 60_000;
    expect(dueMinutesAgo).toBeGreaterThan(179);
    expect(dueMinutesAgo).toBeLessThan(181);
  });

  it('leaves a queue with nothing due out of the report entirely', async () => {
    // Not a zero row: `observeQueues` reads a missing entry as "no age", and a
    // queue whose every row is scheduled forward has no age to report.
    await delivery(9 * 60, 6 * 60);
    const rows = await oldestActiveJobs(pool);
    expect(rows.find((r) => r.source === 'webhook_delivery')).toBeUndefined();
  });
});
