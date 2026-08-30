import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeValuation, findActiveSubscription, upsertSubscription } from '../../src/repos/billing.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Every Stripe subscription event the billing webhook handles.
 *
 * `subscriptions.test.ts` covers one of them — `customer.subscription.created`
 * on the happy path — and the signature check. The rest of the ladder decides
 * whether an account is billable, how much quota it has, and whether an
 * invoice exists, and none of it had been exercised. Stripe also makes no
 * ordering guarantee between the events of a single checkout, so the pairs
 * below arrive in both orders in production.
 */

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_test_secret';

function stripeSig(payload: string, secret = WEBHOOK_SECRET): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

describe.skipIf(!dbUp)('billing webhook events', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  });
  afterAll(async () => ctx?.teardown());

  /** POST a signed event and return the response. */
  const deliver = async (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'stripe-signature': stripeSig(payload), 'content-type': 'application/json' },
      payload,
    });
  };

  const subscriptionOf = async (userId: string) => {
    const { rows } = await ctx.pool.query<{
      plan_tier: string;
      status: string;
      valuations_used: number;
      current_period_start: Date | null;
      current_period_end: Date | null;
      canceled_at: Date | null;
    }>('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]);
    return rows[0] ?? null;
  };

  describe('checkout.session.completed', () => {
    it('does not hand over the plan before the first debit has cleared', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await deliver({
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            // A delayed-notification method (SEPA, Bacs) completes the session
            // with the money still in flight. Calling this active would hand
            // over the plan's quota against a debit that can still fail.
            payment_status: 'unpaid',
            subscription: 'sub_unpaid_1',
            customer: 'cus_unpaid_1',
            metadata: { user_id: user.id, plan_tier: 'enterprise' },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect((await subscriptionOf(user.id))?.status).toBe('past_due');
    });

    it('activates the plan when the session settled', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await deliver({
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            payment_status: 'paid',
            subscription: 'sub_paid_1',
            customer: 'cus_paid_1',
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      const sub = await subscriptionOf(user.id);
      expect(sub?.status).toBe('active');
      expect(sub?.plan_tier).toBe('annual_retainer');
    });

    it('ignores a one-off checkout — that is the payments webhook’s event', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await deliver({
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'payment',
            payment_status: 'paid',
            metadata: { user_id: user.id, plan_tier: 'enterprise' },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(await subscriptionOf(user.id)).toBeNull();
    });

    it('ignores a session carrying no plan metadata', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await deliver({
        type: 'checkout.session.completed',
        data: {
          object: { mode: 'subscription', payment_status: 'paid', metadata: { user_id: user.id } },
        },
      });
      expect(await subscriptionOf(user.id)).toBeNull();
    });

    /*
     * The ordering case. Stripe fires `customer.subscription.created` and
     * `checkout.session.completed` for the same checkout and guarantees nothing
     * about which is delivered first — so the session event routinely lands on
     * a row that already carries the real billing period. The session object
     * has no period fields at all, and writing them as NULL both blanks the
     * period on the account and, because the usage reset keys off the period
     * having changed, hands back a full quota.
     */
    it('does not blank the billing period a subscription event already wrote', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const start = Math.floor(Date.now() / 1000);
      await deliver({
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_ordering_1',
            status: 'active',
            customer: 'cus_ordering_1',
            current_period_start: start,
            current_period_end: start + 31_536_000,
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      await ctx.pool.query(
        "UPDATE subscriptions SET valuations_used = 7 WHERE stripe_subscription_id = 'sub_ordering_1'",
      );

      await deliver({
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            payment_status: 'paid',
            subscription: 'sub_ordering_1',
            customer: 'cus_ordering_1',
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });

      const sub = await subscriptionOf(user.id);
      expect(sub?.current_period_start).not.toBeNull();
      expect(sub?.current_period_end).not.toBeNull();
      // And the quota is still spent: a period that did not change is not a
      // new period, so there is nothing to reset.
      expect(sub?.valuations_used).toBe(7);
    });
  });

  describe('customer.subscription.updated', () => {
    it('maps every Stripe status onto the local one', async () => {
      const cases: Array<[string, string]> = [
        ['trialing', 'trialing'],
        ['active', 'active'],
        ['canceled', 'canceled'],
        ['incomplete_expired', 'canceled'],
        ['past_due', 'past_due'],
        ['unpaid', 'past_due'],
        ['incomplete', 'past_due'],
      ];
      for (const [stripeStatus, local] of cases) {
        const user = await seedUser(ctx, { roles: ['valuation_user'] });
        await deliver({
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: `sub_status_${stripeStatus}`,
              status: stripeStatus,
              metadata: { user_id: user.id, plan_tier: 'enterprise' },
            },
          },
        });
        expect([stripeStatus, (await subscriptionOf(user.id))?.status]).toEqual([stripeStatus, local]);
      }
    });

    it('resets the quota when a genuinely new period starts', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const start = Math.floor(Date.now() / 1000);
      const send = (periodStart: number) =>
        deliver({
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_renewal_1',
              status: 'active',
              current_period_start: periodStart,
              current_period_end: periodStart + 2_592_000,
              metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
            },
          },
        });

      await send(start);
      await ctx.pool.query(
        "UPDATE subscriptions SET valuations_used = 9 WHERE stripe_subscription_id = 'sub_renewal_1'",
      );
      // Same period redelivered: not a renewal, so the count stands.
      await send(start);
      expect((await subscriptionOf(user.id))?.valuations_used).toBe(9);

      await send(start + 2_592_000);
      expect((await subscriptionOf(user.id))?.valuations_used).toBe(0);
    });

    it('ignores an event whose subscription carries no id', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const res = await deliver({
        type: 'customer.subscription.updated',
        data: { object: { status: 'active', metadata: { user_id: user.id, plan_tier: 'enterprise' } } },
      });
      expect(res.statusCode).toBe(200);
      expect(await subscriptionOf(user.id)).toBeNull();
    });

    /**
     * Stripe makes no ordering guarantee, and its own retry mechanism is how
     * events most often arrive out of order: a delivery that failed once is
     * redelivered minutes later, behind everything generated since. A
     * subscription `updated` from before the cancellation therefore lands after
     * `deleted` routinely — and it used to flip the row back to 'active',
     * clear `canceled_at`, and hand a cancelled subscriber their quota back.
     *
     * Cancellation is terminal in Stripe (a resubscribe issues a new
     * subscription id), so "already cancelled" is never the stale half.
     */
    it('does not resurrect a cancelled subscription when a stale update arrives after it', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        stripeSubscriptionId: 'sub_stale_1',
      });
      await deliver({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_stale_1' } },
      });
      expect((await subscriptionOf(user.id))?.status).toBe('canceled');

      const res = await deliver({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_stale_1',
            status: 'active',
            current_period_start: Math.floor(Date.now() / 1000),
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      // Accepted, because there is nothing for Stripe to redeliver — the event
      // is simply older news than what we hold.
      expect(res.statusCode).toBe(200);
      const sub = await subscriptionOf(user.id);
      expect(sub?.status).toBe('canceled');
      expect(sub?.canceled_at).not.toBeNull();

      // The two consequences that made it matter: the plan is gone, and its
      // quota can no longer be spent.
      expect(await findActiveSubscription(ctx.pool, user.id)).toBeNull();
      expect(await consumeValuation(ctx.pool, user.id)).toBe(false);
    });

    it('still applies an ordinary update to a live subscription', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'past_due',
        stripeSubscriptionId: 'sub_stale_2',
      });
      await deliver({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_stale_2',
            status: 'active',
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      expect((await subscriptionOf(user.id))?.status).toBe('active');
    });
  });

  describe('a plan change made in the Stripe portal', () => {
    /*
     * `metadata.plan_tier` is stamped once, by the checkout that started the
     * subscription, and Stripe's hosted portal — the one this product's
     * "Manage subscription" button opens — changes the plan by swapping the
     * subscription's *item*. The metadata still names the tier the customer
     * left, so trusting it wrote the old tier straight back over itself and
     * the change reached nothing: not the quota join, not the Billing screen,
     * not the ops MRR.
     */
    it('follows an upgrade onto the tier actually being billed', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const item = (amountCents: number) => ({
        data: [
          {
            quantity: 1,
            price: { unit_amount: amountCents, currency: 'usd', recurring: { interval: 'year' } },
          },
        ],
      });
      await deliver({
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_upgrade_1',
            status: 'active',
            items: item(2_000_000),
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      expect((await subscriptionOf(user.id))?.plan_tier).toBe('annual_retainer');

      // The portal moves them to Enterprise. The metadata is untouched — this
      // is exactly what Stripe delivers.
      await deliver({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_upgrade_1',
            status: 'active',
            items: item(5_000_000),
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      expect((await subscriptionOf(user.id))?.plan_tier).toBe('enterprise');
      // And the quota moved with it: Enterprise is unlimited, the retainer is 12.
      for (let i = 0; i < 13; i += 1) expect(await consumeValuation(ctx.pool, user.id)).toBe(true);
    });

    it('follows a downgrade, so the larger quota stops being served', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const item = (amountCents: number) => ({
        data: [
          {
            quantity: 1,
            price: { unit_amount: amountCents, currency: 'usd', recurring: { interval: 'year' } },
          },
        ],
      });
      await deliver({
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_downgrade_1',
            status: 'active',
            items: item(5_000_000),
            metadata: { user_id: user.id, plan_tier: 'enterprise' },
          },
        },
      });
      await deliver({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_downgrade_1',
            status: 'active',
            items: item(2_000_000),
            metadata: { user_id: user.id, plan_tier: 'enterprise' },
          },
        },
      });
      const sub = await subscriptionOf(user.id);
      expect(sub?.plan_tier).toBe('annual_retainer');
      await ctx.pool.query(
        "UPDATE subscriptions SET valuations_used = 12 WHERE stripe_subscription_id = 'sub_downgrade_1'",
      );
      // The retainer's twelve are spent; the unlimited tier they no longer pay
      // for does not go on answering for them.
      expect(await consumeValuation(ctx.pool, user.id)).toBe(false);
    });

    it('keeps the metadata tier when the item names no plan we sell', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await deliver({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_unknown_price_1',
            status: 'active',
            items: {
              data: [
                {
                  quantity: 1,
                  price: { unit_amount: 123_456, currency: 'usd', recurring: { interval: 'month' } },
                },
              ],
            },
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      expect((await subscriptionOf(user.id))?.plan_tier).toBe('annual_retainer');
    });

    it('keeps the metadata tier for a subscription carrying more than one item', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const line = (amountCents: number) => ({
        quantity: 1,
        price: { unit_amount: amountCents, currency: 'usd', recurring: { interval: 'year' } },
      });
      await deliver({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_multi_item_1',
            status: 'active',
            items: { data: [line(5_000_000), line(2_000_000)] },
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      expect((await subscriptionOf(user.id))?.plan_tier).toBe('annual_retainer');
    });
  });

  describe('customer.subscription.deleted', () => {
    it('cancels the local row', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'enterprise',
        stripeSubscriptionId: 'sub_delete_1',
      });
      await deliver({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_delete_1' } },
      });
      const sub = await subscriptionOf(user.id);
      expect(sub?.status).toBe('canceled');
      expect(sub?.canceled_at).not.toBeNull();
    });
  });

  describe('invoice.paid', () => {
    const invoiceRows = async (userId: string) => {
      const { rows } = await ctx.pool.query<{ number: string; amount_cents: number; status: string }>(
        'SELECT * FROM invoices WHERE user_id = $1 ORDER BY issued_at ASC',
        [userId],
      );
      return rows;
    };

    it('records the invoice against the subscription’s owner', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        stripeSubscriptionId: 'sub_invoice_1',
      });
      const res = await deliver({
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_paid_1',
            subscription: 'sub_invoice_1',
            amount_paid: 2_000_000,
            currency: 'gbp',
            description: 'Annual retainer',
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const rows = await invoiceRows(user.id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.amount_cents)).toBe(2_000_000);
      expect(rows[0]!.status).toBe('paid');
    });

    it('is idempotent — Stripe delivers at least once', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        stripeSubscriptionId: 'sub_invoice_2',
      });
      const event = {
        type: 'invoice.payment_succeeded',
        data: {
          object: { id: 'in_paid_2', subscription: 'sub_invoice_2', amount_due: 50_000, currency: 'usd' },
        },
      };
      await deliver(event);
      await deliver(event);
      // One row, and — because the redelivery is refused before a sequence is
      // allocated — no gap in the numbering an auditor reads as a count.
      expect(await invoiceRows(user.id)).toHaveLength(1);
    });

    it('records nothing when the invoice belongs to no one we know', async () => {
      const res = await deliver({
        type: 'invoice.paid',
        data: { object: { id: 'in_orphan_1', subscription: 'sub_never_seen', amount_paid: 100 } },
      });
      expect(res.statusCode).toBe(200);
      const { rows } = await ctx.pool.query("SELECT 1 FROM invoices WHERE stripe_invoice_id = 'in_orphan_1'");
      expect(rows).toHaveLength(0);
    });
  });

  describe('invoice.payment_failed', () => {
    it('marks the subscription past due so someone can be told', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        stripeSubscriptionId: 'sub_dunning_1',
      });
      await deliver({
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_failed_1', subscription: 'sub_dunning_1', amount_due: 200_000 } },
      });
      expect((await subscriptionOf(user.id))?.status).toBe('past_due');
    });

    it('never resurrects a cancelled subscription into a billable state', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'canceled',
        stripeSubscriptionId: 'sub_dunning_2',
      });
      await deliver({
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_failed_2', subscription: 'sub_dunning_2', amount_due: 200_000 } },
      });
      expect((await subscriptionOf(user.id))?.status).toBe('canceled');
    });

    it('does nothing for a failure not tied to a subscription', async () => {
      const res = await deliver({
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_failed_3', amount_due: 200_000 } },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('the events it does not handle', () => {
    it('accepts an unknown type without acting on it', async () => {
      const res = await deliver({ type: 'customer.created', data: { object: { id: 'cus_x' } } });
      expect(res.statusCode).toBe(200);
    });

    it('accepts an event with no type or object at all', async () => {
      const res = await deliver({});
      expect(res.statusCode).toBe(200);
    });

    it('refuses a body that is not JSON', async () => {
      const payload = 'not json';
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'stripe-signature': stripeSig(payload), 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toBe('Invalid webhook payload');
    });

    it('refuses a delivery with no signature header', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
