import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKLOG_WINDOW_HOURS,
  claimRetryableDeliveries,
  createWebhook,
  deliveryBacklogStats,
  recordDelivery,
  settleDelivery,
  type WebhookDeliveryRow,
} from '../../src/repos/partnerWebhooks.js';
import { deliverToWebhook, retryDueDeliveries } from '../../src/hooks/partnerWebhooks.js';
import { newWebhookSecret } from '../../src/domain/partnerWebhooks.js';
import { isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What happens to a delivery row when two sweepers hold it at once.
 *
 * The claim is a lease, and the lease was a flat five minutes while the sweep
 * that holds it POSTs its batch **one row at a time**: a hundred rows at up to
 * ten seconds each is twenty-five minutes of work under a five-minute lease, so
 * the tail of every large batch was claimable again while a live sweeper was
 * still going to deliver it. There are two ways to have a second sweeper —
 * `POST /admin/webhooks/retry` runs the same function outside the scheduler
 * that keeps the interval from overlapping itself, and a deployment may run
 * more than one instance — and the outcome was not a delay, it was a duplicate:
 * both sweepers POST the event, and then both write to the row.
 *
 * The second write is the part that outlived the request. `settleDelivery`
 * updated by id and nothing else, so the loser's outcome landed last and landed
 * over a row that had already been settled:
 *
 *   * a 'delivered' row flipped back to 'pending' — `delivered_at` still set —
 *     which the sweep then delivers to the partner a *third* time and which
 *     `GET /webhooks/{id}/deliveries` describes to the partner as still owed;
 *   * `next_attempt_at` stamped from the attempt count the loser read at claim
 *     time, which is behind the row's own, so the ladder walks backwards.
 *
 * Both halves are the delivery log stating something untrue, which is the one
 * thing it exists not to do. The fix is the sibling of what
 * `settleClaimedEmail` does in SQL: a settle applies only while the row still
 * carries the attempt count the caller claimed it with.
 *
 * The lease is now derived from the batch as well, so the takeover is rare
 * rather than routine — but rare is not never, which is why both are here.
 */
describe.skipIf(!dbUp)('two sweepers holding the same delivery', () => {
  let ctx: TestApp;
  let webhookId: string;

  /** A pending, due delivery with one attempt already counted, lease released. */
  const pendingDelivery = async (): Promise<WebhookDeliveryRow> => {
    const row = await recordDelivery(ctx.pool, {
      webhookId,
      eventType: 'valuation.report_ready',
      payload: { event: 'valuation.report_ready' },
    });
    await ctx.pool.query(
      `UPDATE partner_webhook_deliveries
          SET claimed_at = NULL, next_attempt_at = now() - interval '1 second'
        WHERE id = $1`,
      [row.id],
    );
    return row;
  };

  const readRow = async (id: string): Promise<WebhookDeliveryRow> => {
    const { rows } = await ctx.pool.query<WebhookDeliveryRow>(
      'SELECT * FROM partner_webhook_deliveries WHERE id = $1',
      [id],
    );
    return rows[0]!;
  };

  /** Expires the lease in place, which is what waiting it out would do. */
  const expireLease = async (id: string): Promise<void> => {
    await ctx.pool.query(
      `UPDATE partner_webhook_deliveries SET claimed_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true' });
    const partnerId = await seedPartner(ctx, 'Handoff Partners');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const hook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'https://hooks.example.test/handoff',
      secret: newWebhookSecret(),
      events: [],
      createdBy: admin.id,
    });
    webhookId = hook.id;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM partner_webhook_deliveries');
  });

  it('lets the sweeper that holds the row settle it', async () => {
    const row = await pendingDelivery();
    const [claimed] = await claimRetryableDeliveries(ctx.pool, { limit: 5 });
    expect(claimed?.id).toBe(row.id);
    expect(await settleDelivery(ctx.pool, row.id, { status: 'delivered' }, claimed!.attempts)).toBe(true);
    expect((await readRow(row.id)).status).toBe('delivered');
  });

  it('refuses the outcome of a sweeper whose row was taken over', async () => {
    const row = await pendingDelivery();
    const [first] = await claimRetryableDeliveries(ctx.pool, { limit: 5 });
    await expireLease(row.id);
    const [second] = await claimRetryableDeliveries(ctx.pool, { limit: 5 });

    // Both hold the same row, and the second's claim counted the attempt again.
    expect(second?.id).toBe(first!.id);
    expect(second!.attempts).toBe(first!.attempts + 1);

    expect(await settleDelivery(ctx.pool, row.id, { status: 'delivered' }, second!.attempts)).toBe(true);

    // The first sweeper's POST finally comes back — with an outcome that is now
    // a statement about a row somebody else has settled.
    const stale = await settleDelivery(
      ctx.pool,
      row.id,
      { status: 'failed', error: 'receiver responded 500', nextAttemptAt: new Date(Date.now() + 60_000) },
      first!.attempts,
    );
    expect(stale).toBe(false);

    const after = await readRow(row.id);
    expect(after.status).toBe('delivered');
    expect(after.last_error).toBeNull();
    expect(after.attempts).toBe(second!.attempts);
  });

  it('does not resurrect a row a replay has reopened', async () => {
    // The other way the attempt count moves under a sweeper: `requeueDelivery`
    // and the bulk replay both reset it to 0 while an attempt is in flight.
    const row = await pendingDelivery();
    const [claimed] = await claimRetryableDeliveries(ctx.pool, { limit: 5 });
    await ctx.pool.query(
      `UPDATE partner_webhook_deliveries
          SET status = 'pending', attempts = 0, claimed_at = NULL, next_attempt_at = now()
        WHERE id = $1`,
      [row.id],
    );
    const applied = await settleDelivery(
      ctx.pool,
      row.id,
      { status: 'failed', error: 'receiver responded 500', nextAttemptAt: null },
      claimed!.attempts,
    );
    expect(applied).toBe(false);
    const after = await readRow(row.id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
  });

  describe('through the delivery path, with a receiver that stalls', () => {
    let receiver: FastifyInstance;
    let receiverUrl: string;
    let hookWithReceiver: string;
    /** Runs inside the POST the sweeper is waiting on — the takeover window. */
    let duringRequest: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      receiver = Fastify({ logger: false });
      receiver.post('/hook', async (_req, reply) => {
        if (duringRequest) await duringRequest();
        return reply.status(200).send({ ok: true });
      });
      await receiver.listen({ port: 0, host: '127.0.0.1' });
      const address = receiver.server.address();
      if (typeof address === 'object' && address) receiverUrl = `http://127.0.0.1:${address.port}/hook`;

      const partnerId = await seedPartner(ctx, 'Handoff Receivers');
      const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
      const hook = await createWebhook(ctx.pool, {
        partnerId,
        url: receiverUrl,
        secret: newWebhookSecret(),
        events: [],
        createdBy: admin.id,
      });
      hookWithReceiver = hook.id;
    }, 60_000);

    afterAll(async () => receiver?.close());
    afterEach(() => {
      duringRequest = null;
    });

    it('reports the retry sweep pass that delivered a duplicate', async () => {
      const row = await recordDelivery(ctx.pool, {
        webhookId: hookWithReceiver,
        eventType: 'valuation.state_changed',
        payload: { event: 'valuation.state_changed' },
      });
      await ctx.pool.query(
        `UPDATE partner_webhook_deliveries
            SET claimed_at = NULL, next_attempt_at = now() - interval '1 second' WHERE id = $1`,
        [row.id],
      );

      // The second sweeper takes the row and settles it while the first
      // sweeper's request is open. Once, so the takeover is the retry sweep's
      // own attempt rather than every attempt in the file.
      let taken = false;
      duringRequest = async () => {
        if (taken) return;
        taken = true;
        await expireLease(row.id);
        const [other] = await claimRetryableDeliveries(ctx.pool, { limit: 5 });
        await settleDelivery(ctx.pool, row.id, { status: 'delivered' }, other!.attempts);
      };

      const result = await retryDueDeliveries({ pool: ctx.pool, allowPrivateTargets: true });
      expect(result.attempted).toBe(1);
      expect(result.superseded).toBe(1);
      expect(result.delivered).toBe(0);

      // The winner's outcome stands, and the row is not owed another attempt.
      const after = await readRow(row.id);
      expect(after.status).toBe('delivered');
      expect(after.claimed_at).toBeNull();
    });

    it('reports a first delivery whose row was taken over mid-POST', async () => {
      let taken = false;
      duringRequest = async () => {
        if (taken) return;
        taken = true;
        const { rows } = await ctx.pool.query<{ id: string }>(
          `UPDATE partner_webhook_deliveries SET attempts = attempts + 1
            WHERE webhook_id = $1 AND status = 'pending' RETURNING id`,
          [hookWithReceiver],
        );
        expect(rows.length).toBe(1);
      };

      const { rows } = await ctx.pool.query<{ id: string; secret: string; url: string; events: string[] }>(
        'SELECT * FROM partner_webhooks WHERE id = $1',
        [hookWithReceiver],
      );
      const outcome = await deliverToWebhook(
        { pool: ctx.pool, allowPrivateTargets: true },
        { ...(rows[0]! as never), url: receiverUrl },
        'webhook.test',
        { event: 'webhook.test' },
      );
      expect(outcome).toBe('superseded');
    });
  });
});

/**
 * The backlog gauge, and what its two settled counts are counting.
 *
 * `failed` used to be every delivery that had ever given up. Nothing purges
 * this table — the outbox it was modelled on is drained by retention and
 * deliveries are kept as the partner's audit trail — so that number only ever
 * grows, and after a year of successful sends it is a fact about the platform's
 * history rather than an answer to the question it is read to ask. It also cost
 * a sequential scan of the whole table on an endpoint that is deliberately
 * uncached and opened during an incident (see 0180).
 */
describe.skipIf(!dbUp)('the delivery backlog gauge', () => {
  let ctx: TestApp;
  let webhookId: string;

  const seed = async (
    status: 'pending' | 'delivered' | 'failed',
    opts: { ageHours?: number; due?: boolean } = {},
  ): Promise<string> => {
    const row = await recordDelivery(ctx.pool, {
      webhookId,
      eventType: 'valuation.state_changed',
      payload: { event: 'valuation.state_changed' },
    });
    const age = String(opts.ageHours ?? 0);
    await ctx.pool.query(
      `UPDATE partner_webhook_deliveries
          SET status = $2,
              claimed_at = NULL,
              created_at = now() - ($3 || ' hours')::interval,
              delivered_at = CASE WHEN $2 = 'delivered' THEN now() - ($3 || ' hours')::interval END,
              next_attempt_at = now() ${opts.due ? "- interval '1 minute'" : "+ interval '1 hour'"}
        WHERE id = $1`,
      [row.id, status, age],
    );
    return row.id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    const partnerId = await seedPartner(ctx, 'Gauge Partners');
    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const hook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'https://hooks.example.test/gauge',
      secret: newWebhookSecret(),
      events: [],
      createdBy: admin.id,
    });
    webhookId = hook.id;
  }, 60_000);

  afterAll(async () => ctx?.teardown());
  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM partner_webhook_deliveries');
  });

  it('counts only what settled inside the window', async () => {
    await seed('failed', { ageHours: 1 });
    await seed('failed', { ageHours: 2 });
    await seed('failed', { ageHours: BACKLOG_WINDOW_HOURS + 1 });
    await seed('delivered', { ageHours: 3 });
    await seed('delivered', { ageHours: BACKLOG_WINDOW_HOURS + 5 });

    const stats = await deliveryBacklogStats(ctx.pool);
    expect(stats.failed).toBe(2);
    expect(stats.delivered).toBe(1);
    expect(stats.window_hours).toBe(BACKLOG_WINDOW_HOURS);
  });

  it('does not window the live set, which the ladder and the reaper bound', async () => {
    // A pending row older than the window is still owed a delivery, so counting
    // it is the whole point; the ladder's reach and `failExhaustedDeliveries`
    // are what stop this set growing, not a cutoff.
    await seed('pending', { ageHours: BACKLOG_WINDOW_HOURS + 10, due: true });
    await seed('pending', { ageHours: 0, due: false });

    const stats = await deliveryBacklogStats(ctx.pool);
    expect(stats.pending).toBe(2);
    expect(stats.due).toBe(1);
  });

  it('answers a caller that asks for a different window', async () => {
    await seed('failed', { ageHours: 5 });
    await seed('failed', { ageHours: 30 });
    const wide = await deliveryBacklogStats(ctx.pool, { windowHours: 48 });
    expect(wide.failed).toBe(2);
    expect(wide.window_hours).toBe(48);
  });
});
