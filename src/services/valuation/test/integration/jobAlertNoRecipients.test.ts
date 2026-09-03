import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { newUlid } from '@n409/shared';
import { resetOpenJobAlerts, runJobAlertScan } from '../../src/hooks/jobAlerts.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * An announcement with nobody to announce to (R401, methodology M11).
 *
 * `createNotifications` accepts an empty list and writes nothing, and
 * `deliverJobAlertAnnouncement` stamps the row on the way out — so a scan that
 * found no recipient marked every announcement delivered, returned `sent`, and
 * counted `opened`. `announcements_failed` stayed at zero, which is what
 * `JobAlertAnnouncementsFailing` reads, and that rule's own note says what the
 * number is for: "an operator who has not been told a queue is stalled, which
 * is the one failure the job monitor exists to prevent".
 *
 * Nobody being there to tell is that, exactly — and permanently, because the
 * row was stamped and no later scan owed the announcement again.
 *
 * `listUserIdsWithRoles` drops closed *and* suspended accounts, so this is not
 * a hypothetical empty database: a deployment whose last administrator is
 * suspended has an alerting subsystem reporting itself healthy.
 */
describe.skipIf(!dbUp)('a job queue alert with no alerting role to reach', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let lines: Array<Record<string, unknown>>;

  const stuckEmail = async (minutes: number) => {
    await pool.query(
      `INSERT INTO email_outbox
         (id, valuation_id, to_email, template_key, subject, body, status, created_at)
       VALUES ($1, $2, 'stuck@test.example.com', 'draft_ready', 'Draft ready', 'body', 'queued',
               now() - make_interval(mins => $3::int))`,
      [newUlid(), valuationId, minutes],
    );
  };

  const notices = async () =>
    Number(
      (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE type = 'job_alert'`)).rows[0].n,
    );

  beforeAll(async () => {
    ctx = await setupTestApp({ LOG_LEVEL: 'info' });
    app = ctx.app;
    pool = ctx.pool;
    lines = [];
    (ctx.app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Unreachable QueueCo' },
    });
    valuationId = created.json().valuation.id;
    await stuckEmail(600);
  }, 120_000);
  afterAll(async () => ctx?.teardown());

  it('counts the announcement as failed and says so, instead of reporting it sent', async () => {
    resetOpenJobAlerts();
    // The estate loses its last alerting role. `listUserIdsWithRoles` drops
    // closed accounts, so this is what a departed administrator looks like to
    // the announcer — the seeded `admin` above is the only holder.
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [ops.id]);

    const first = await runJobAlertScan({ pool, log: app.log });
    // Non-vacuity: the scan really did open an alert, so the numbers below are
    // about an announcement that was owed rather than about an idle pass.
    expect(first.opened.length).toBeGreaterThan(0);
    expect(first.notified).toMatchObject({ opened: 0, failed: first.opened.length });
    expect(await notices()).toBe(0);

    const said = lines.find((l) => String(l.msg).includes('nobody to announce to'));
    expect(said).toBeDefined();
    // `alert: true` is what `log_alert_lines_total` counts and
    // `PermanentFailuresLogged` reads — the journal is not the alerting channel.
    expect(said!.alert).toBe(true);
    expect(said!.owed).toBe(first.opened.length);

    // Still owed: the row was never stamped, so the announcement arrives once
    // somebody holds the role again. This is the one announcement on the
    // platform that is retried, and losing it would be the worse half.
    await pool.query('UPDATE users SET deleted_at = NULL WHERE id = $1', [ops.id]);
    const second = await runJobAlertScan({ pool, log: app.log });
    expect(second.notified).toMatchObject({ opened: first.opened.length, failed: 0 });
    expect(await notices()).toBeGreaterThan(0);
  });
});
