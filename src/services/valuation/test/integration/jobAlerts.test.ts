import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { runJobAlertScan } from '../../src/hooks/jobAlerts.js';
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
    const res = await alerts();
    expect(res.statusCode).toBe(200);
    const rules = res.json().rules as Array<{ source: string; enabled: boolean }>;
    expect(rules.map((r) => r.source).sort()).toEqual(
      ['ai_job', 'calculation', 'email', 'pipeline_run', 'webhook_delivery'].sort(),
    );
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
    expect(result.opened[0]!.detail).toContain('8h old');
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
    expect(second.ongoing[0]!.detail).toContain('20h old');

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
