import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DELIVERY_PREDATES_RETRIES_ERROR,
  DELIVERY_REPLAY_MAX_AGE_HOURS,
  createWebhook,
  listFailedDeliveries,
  recordDelivery,
  replayFailedDeliveries,
} from '../../src/repos/partnerWebhooks.js';
import { newWebhookSecret } from '../../src/domain/partnerWebhooks.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The dead letter queue.
 *
 * Delivery retries (0103) gave a failed delivery a ladder to climb and a
 * terminal state at the top of it. What they did not give anyone was a way to
 * look at what had settled there. `deliveryBacklogStats` reports `failed: N`
 * and the route serving it said of that number that "a failed row is terminal
 * and nothing else will ever come back for it" — accurate, and an operator
 * holding a count with no next step.
 *
 * The one replay in the service was `requeueDelivery`: one id, scoped to one
 * partner, reached through the partner's own API. That is the right tool for a
 * partner whose receiver was down. It is no tool at all for the case that
 * actually needs one — a bad deploy that 500s every POST for ten minutes, where
 * the failed deliveries belong to a dozen partners, none of whom did anything
 * wrong, and none of whom has any reason to know there is something to replay.
 *
 * ## The reason a replay is bounded rather than a button
 *
 * A payload is a snapshot of a transition, not a pointer to current state. So a
 * replay is not "deliver this again", it is "assert this old thing, now" — and
 * because nothing orders deliveries, a replayed event can land after the events
 * that superseded it. A partner tracking state from the stream is then walked
 * backwards, which is a worse outcome than the notification they never got.
 * Three classes are refused for that reason and each is asserted below: too
 * old, retired by 0103, and endpoint disabled.
 */
describe.skipIf(!dbUp)('the webhook dead letter queue', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let partnerId: string;
  let otherPartnerId: string;
  let webhookId: string;
  let otherWebhookId: string;
  let opsToken: string;
  let clientToken: string;

  /** A delivery already settled as failed, optionally aged and re-blamed. */
  const deadLetter = async (
    opts: { webhookId?: string; ageHours?: number; lastError?: string; event?: string } = {},
  ): Promise<string> => {
    const row = await recordDelivery(ctx.pool, {
      webhookId: opts.webhookId ?? webhookId,
      eventType: opts.event ?? 'valuation.report_ready',
      payload: { event: opts.event ?? 'valuation.report_ready' },
    });
    await ctx.pool.query(
      `UPDATE partner_webhook_deliveries
          SET status = 'failed', claimed_at = NULL, attempts = max_attempts,
              last_error = $2,
              created_at = now() - ($3 || ' hours')::interval
        WHERE id = $1`,
      [row.id, opts.lastError ?? 'HTTP 500', String(opts.ageHours ?? 0)],
    );
    return row.id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    app = ctx.app;
    partnerId = await seedPartner(ctx, 'Deadletter Partners');
    otherPartnerId = await seedPartner(ctx, 'Second Partners');

    const admin = await seedUser(ctx, { roles: ['partner'], partnerId });
    const hook = await createWebhook(ctx.pool, {
      partnerId,
      url: 'https://hooks.example.test/a',
      secret: newWebhookSecret(),
      events: [],
      createdBy: admin.id,
    });
    webhookId = hook.id;

    const otherAdmin = await seedUser(ctx, { roles: ['partner'], partnerId: otherPartnerId });
    const otherHook = await createWebhook(ctx.pool, {
      partnerId: otherPartnerId,
      url: 'https://hooks.example.test/b',
      secret: newWebhookSecret(),
      events: [],
      createdBy: otherAdmin.id,
    });
    otherWebhookId = otherHook.id;

    opsToken = (await seedUser(ctx, { roles: ['reviewer'] })).token;
    clientToken = (await seedUser(ctx, { roles: ['client'] })).token;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    // Each case owns the queue: the listing is global by design, so a row left
    // by the previous test is a row this one would count.
    await ctx.pool.query('DELETE FROM partner_webhook_deliveries');
  });

  describe('what an operator can see', () => {
    it('names the partner, the endpoint and the reason behind the count', async () => {
      await deadLetter({ lastError: 'HTTP 503' });
      const rows = await listFailedDeliveries(ctx.pool);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        partner_id: partnerId,
        webhook_id: webhookId,
        url: 'https://hooks.example.test/a',
        event_type: 'valuation.report_ready',
        last_error: 'HTTP 503',
        replayable: true,
      });
    });

    it('does not carry the payload into a triage listing', async () => {
      // A payload holds the valuation's company name and state. The listing is
      // for deciding what to replay, which needs none of that.
      await deadLetter();
      const rows = await listFailedDeliveries(ctx.pool);
      expect(rows[0]).not.toHaveProperty('payload');
    });

    it('shows only what actually gave up', async () => {
      // A pending row is owed another attempt by the sweep; it is backlog, not
      // a dead letter, and listing it would have an operator replaying rows
      // that were never abandoned.
      await recordDelivery(ctx.pool, {
        webhookId,
        eventType: 'valuation.state_changed',
        payload: {},
      });
      await deadLetter();

      const rows = await listFailedDeliveries(ctx.pool);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_type).toBe('valuation.report_ready');
    });

    it('marks the rows a replay would refuse, before one is run', async () => {
      const fresh = await deadLetter();
      const stale = await deadLetter({ ageHours: DELIVERY_REPLAY_MAX_AGE_HOURS + 1 });
      const retired = await deadLetter({ lastError: DELIVERY_PREDATES_RETRIES_ERROR });

      const byId = new Map((await listFailedDeliveries(ctx.pool)).map((r) => [r.id, r.replayable] as const));
      expect(byId.get(fresh)).toBe(true);
      expect(byId.get(stale)).toBe(false);
      expect(byId.get(retired)).toBe(false);
    });

    it('can be narrowed to one partner during a partner-specific incident', async () => {
      await deadLetter();
      await deadLetter({ webhookId: otherWebhookId });

      const mine = await listFailedDeliveries(ctx.pool, { partnerId });
      expect(mine).toHaveLength(1);
      expect(mine[0]!.partner_id).toBe(partnerId);
      expect(await listFailedDeliveries(ctx.pool)).toHaveLength(2);
    });
  });

  describe('replaying in bulk', () => {
    it('re-opens a failed delivery with the full ladder ahead of it', async () => {
      // Attempts reset for the same reason the partner-facing replay resets
      // them: a receiver reachable again gets the patience a new event gets.
      const id = await deadLetter();
      const replayed = await replayFailedDeliveries(ctx.pool);
      expect(replayed.map((d) => d.id)).toEqual([id]);

      const { rows } = await ctx.pool.query(
        'SELECT status, attempts, last_error, next_attempt_at <= now() AS due FROM partner_webhook_deliveries WHERE id = $1',
        [id],
      );
      expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null, due: true });
    });

    it('crosses partners, which is the case the partner-facing replay cannot serve', async () => {
      // Our outage, not theirs. Both partners' deliveries come back in one
      // action by an operator who has confirmed the cause was ours.
      await deadLetter();
      await deadLetter({ webhookId: otherWebhookId });

      const replayed = await replayFailedDeliveries(ctx.pool);
      expect(replayed).toHaveLength(2);
      expect(await listFailedDeliveries(ctx.pool)).toEqual([]);
    });

    it('refuses a payload old enough to have been overtaken', async () => {
      const stale = await deadLetter({ ageHours: DELIVERY_REPLAY_MAX_AGE_HOURS + 1 });
      const fresh = await deadLetter({ ageHours: DELIVERY_REPLAY_MAX_AGE_HOURS - 1 });

      const replayed = await replayFailedDeliveries(ctx.pool);
      expect(replayed.map((d) => d.id)).toEqual([fresh]);

      const { rows } = await ctx.pool.query('SELECT status FROM partner_webhook_deliveries WHERE id = $1', [
        stale,
      ]);
      expect(rows[0]!.status).toBe('failed');
    });

    it('does not undo the retirement 0103 performed deliberately', async () => {
      // Those rows were settled when retries were introduced, precisely because
      // their payloads describe transitions many deploys old. A bulk replay
      // must not reverse that decision as a side effect. Aged to zero so the
      // only thing refusing it is the error stamp.
      const retired = await deadLetter({ lastError: DELIVERY_PREDATES_RETRIES_ERROR });
      expect(await replayFailedDeliveries(ctx.pool)).toEqual([]);

      const { rows } = await ctx.pool.query('SELECT status FROM partner_webhook_deliveries WHERE id = $1', [
        retired,
      ]);
      expect(rows[0]!.status).toBe('failed');
    });

    it('leaves a disabled endpoint alone', async () => {
      // `claimRetryableDeliveries` already declines to sweep these — a partner
      // who turned an endpoint off should not have its backlog arrive when they
      // turn it back on. A replay that ignored the flag would hand the sweep a
      // row it refuses to send, so the delivery would sit pending forever
      // instead of being honestly terminal.
      const id = await deadLetter();
      await ctx.pool.query('UPDATE partner_webhooks SET enabled = false WHERE id = $1', [webhookId]);

      expect(await replayFailedDeliveries(ctx.pool)).toEqual([]);
      const { rows } = await ctx.pool.query('SELECT status FROM partner_webhook_deliveries WHERE id = $1', [
        id,
      ]);
      expect(rows[0]!.status).toBe('failed');

      await ctx.pool.query('UPDATE partner_webhooks SET enabled = true WHERE id = $1', [webhookId]);
    });

    it('replays only the reviewed set when ids are given', async () => {
      const chosen = await deadLetter();
      const untouched = await deadLetter();

      const replayed = await replayFailedDeliveries(ctx.pool, { ids: [chosen] });
      expect(replayed.map((d) => d.id)).toEqual([chosen]);

      const { rows } = await ctx.pool.query('SELECT status FROM partner_webhook_deliveries WHERE id = $1', [
        untouched,
      ]);
      expect(rows[0]!.status).toBe('failed');
    });

    it('treats an empty id list as none rather than everything', async () => {
      // The distinction between "replay these" with nothing selected and
      // "replay everything" is one keystroke in a UI, and getting it wrong
      // sends every partner their entire dead letter queue.
      await deadLetter();
      expect(await replayFailedDeliveries(ctx.pool, { ids: [] })).toEqual([]);
      expect(await listFailedDeliveries(ctx.pool)).toHaveLength(1);
    });

    it('is idempotent in the way that matters — a replayed row is no longer failed', async () => {
      await deadLetter();
      expect(await replayFailedDeliveries(ctx.pool)).toHaveLength(1);
      // Second run finds nothing: the row is pending now and belongs to the
      // sweep, so a double-click cannot reset a delivery already in flight.
      expect(await replayFailedDeliveries(ctx.pool)).toEqual([]);
    });
  });

  describe('the routes', () => {
    it('serves the queue and the replay bound to ops', async () => {
      await deadLetter();
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/webhooks/deliveries/failed',
        headers: authHeader(opsToken),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().deliveries).toHaveLength(1);
      expect(res.json().replay_max_age_hours).toBe(DELIVERY_REPLAY_MAX_AGE_HOURS);
    });

    it('refuses a client — a callback URL is the partner’s infrastructure', async () => {
      await deadLetter();
      for (const url of [
        '/api/v1/admin/webhooks/deliveries/failed',
        '/api/v1/admin/webhooks/deliveries/replay',
      ]) {
        const res = await app.inject({
          method: url.endsWith('replay') ? 'POST' : 'GET',
          url,
          headers: authHeader(clientToken),
          ...(url.endsWith('replay') ? { payload: {} } : {}),
        });
        expect(res.statusCode).toBe(403);
      }
    });

    it('reports which ids it replayed, not just how many', async () => {
      // A count cannot distinguish "12 replayed" from "12 of the 40 I asked
      // for", and the difference is whether the incident is over.
      const fresh = await deadLetter();
      const stale = await deadLetter({ ageHours: DELIVERY_REPLAY_MAX_AGE_HOURS + 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/webhooks/deliveries/replay',
        headers: authHeader(opsToken),
        payload: { ids: [fresh, stale] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ replayed: 1, ids: [fresh] });
    });

    it('leaves a durable record of the operator action, not just a log line', async () => {
      // R434 (M4): this route re-sends payloads to partner infrastructure by
      // hand, the same external effect a live delivery has — and wrote only a
      // `req.log.info` line. `data_remediation_rerun` is the same shape of
      // action (a reviewed bulk decision over a queue) and has always recorded
      // one; this route did not.
      const fresh = await deadLetter();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/webhooks/deliveries/replay',
        headers: authHeader(opsToken),
        payload: { ids: [fresh] },
      });
      expect(res.statusCode).toBe(200);

      const { rows } = await ctx.pool.query(
        `SELECT type, subject_type, payload FROM admin_events WHERE type = 'partner_webhook_deliveries_replayed' ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.subject_type).toBe('partner_webhook_delivery');
      expect(rows[0]!.payload).toMatchObject({ requested: 1, replayed: 1, ids: [fresh] });
    });

    it('refuses a body it cannot read rather than replaying everything', async () => {
      await deadLetter();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/webhooks/deliveries/replay',
        headers: authHeader(opsToken),
        payload: { ids: 'not-an-array' },
      });
      // 422, not 400: the service-wide rule is that a query string it could not
      // read is a 400 and a body it read and will not act on is a 422. This is a
      // body parse, and answering 400 here was the copied-neighbour mistake that
      // `queryValidationStatus` exists to catch.
      expect(res.statusCode).toBe(422);
      expect(await listFailedDeliveries(ctx.pool)).toHaveLength(1);
    });
  });
});
