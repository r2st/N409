import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newUlid } from '@n409/shared';
import { listNotifications } from '../../src/repos/notifications.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Self-serve subscription management and dunning.
 *
 * Two churn causes that the product used to create for itself: a subscriber had
 * no way to cancel or change a card without emailing support (the only path to
 * cancelSubscription was a Stripe-side event), and a failed renewal was handled
 * nowhere at all, so an expired card lapsed a paying account in silence.
 */

const WEBHOOK_SECRET = 'whsec_portal_test';
const SECRET_KEY = 'sk_test_portal';

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('billing portal + dunning', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let subscriber: Awaited<ReturnType<typeof seedUser>>;

  const post = (body: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: signedHeaders(body),
      payload: body,
    });

  /** A subscription row as the checkout webhook would have left it. */
  const seedSubscription = async (
    userId: string,
    stripeSubId: string,
    customerId: string | null,
  ): Promise<string> => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO subscriptions (id, user_id, plan_tier, status, stripe_subscription_id, stripe_customer_id)
       VALUES ($1, $2, 'annual_retainer', 'active', $3, $4)`,
      [id, userId, stripeSubId, customerId],
    );
    return id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_SECRET_KEY: SECRET_KEY });
    ops = await seedUser(ctx, { roles: ['admin'] });
    subscriber = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => ctx?.teardown());

  describe('POST /billing/portal', () => {
    it('returns a portal URL for the caller’s own Stripe customer', async () => {
      await seedSubscription(subscriber.id, 'sub_portal_1', 'cus_portal_1');

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.com/session/abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/portal',
        headers: authHeader(subscriber.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ portal_url: 'https://billing.stripe.com/session/abc' });

      // The customer sent to Stripe is the caller's, taken from our own row —
      // never anything the request could have supplied.
      const [, init] = fetchSpy.mock.calls[0]!;
      expect(String(init?.body)).toContain('customer=cus_portal_1');
    });

    it('will not open a portal for a user with no billing account', async () => {
      const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/portal',
        headers: authHeader(stranger.token),
      });
      expect(res.statusCode).toBe(409);
    });

    it('requires authentication', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/billing/portal' });
      expect(res.statusCode).toBe(401);
    });

    it('surfaces a Stripe failure as a 502 rather than a 500', async () => {
      // Its own subscriber: one active subscription per user is a DB invariant.
      const errUser = await seedUser(ctx, { roles: ['valuation_user'] });
      await seedSubscription(errUser.id, 'sub_portal_err', 'cus_portal_err');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'No such customer' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/portal',
        headers: authHeader(errUser.token),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().detail).toContain('No such customer');
    });

    it('advertises portal availability on /me/subscription', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/subscription',
        headers: authHeader(subscriber.token),
      });
      expect(res.json().portal_available).toBe(true);

      const stranger = await seedUser(ctx, { roles: ['valuation_user'] });
      const none = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/subscription',
        headers: authHeader(stranger.token),
      });
      expect(none.json().portal_available).toBe(false);
    });
  });

  describe('invoice.payment_failed', () => {
    const failedEvent = (subId: string, amountDue = 2_000_000) =>
      JSON.stringify({
        type: 'invoice.payment_failed',
        data: { object: { id: `in_${subId}`, subscription: subId, amount_due: amountDue, currency: 'usd' } },
      });

    const notificationsFor = async (userId: string) =>
      (await listNotifications(ctx.pool, userId, { limit: 200 })).filter(
        (n) => n.type === 'subscription_payment_failed',
      );

    it('marks the subscription past due and tells the subscriber and ops', async () => {
      const dunned = await seedUser(ctx, { roles: ['valuation_user'] });
      await seedSubscription(dunned.id, 'sub_dun_1', 'cus_dun_1');

      expect((await post(failedEvent('sub_dun_1'))).statusCode).toBe(200);

      const { rows } = await ctx.pool.query<{ status: string }>(
        'SELECT status FROM subscriptions WHERE stripe_subscription_id = $1',
        ['sub_dun_1'],
      );
      expect(rows[0]?.status).toBe('past_due');
      expect(await notificationsFor(dunned.id)).toHaveLength(1);
      expect((await notificationsFor(ops.id)).length).toBeGreaterThan(0);
    });

    it('never resurrects a cancelled subscription', async () => {
      const gone = await seedUser(ctx, { roles: ['valuation_user'] });
      await seedSubscription(gone.id, 'sub_dun_gone', 'cus_dun_gone');
      await ctx.pool.query(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = now()
          WHERE stripe_subscription_id = $1`,
        ['sub_dun_gone'],
      );

      expect((await post(failedEvent('sub_dun_gone'))).statusCode).toBe(200);

      const { rows } = await ctx.pool.query<{ status: string }>(
        'SELECT status FROM subscriptions WHERE stripe_subscription_id = $1',
        ['sub_dun_gone'],
      );
      expect(rows[0]?.status).toBe('canceled');
      expect(await notificationsFor(gone.id)).toHaveLength(0);
    });

    it('acknowledges a failure for a subscription we do not know', async () => {
      expect((await post(failedEvent('sub_never_seen'))).statusCode).toBe(200);
    });

    it('rejects an unsigned event', async () => {
      const body = failedEvent('sub_dun_1');
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
