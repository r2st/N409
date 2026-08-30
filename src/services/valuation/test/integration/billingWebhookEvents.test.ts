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

  describe('an account that already holds a live subscription', () => {
    /*
     * `subscriptions_one_active_per_user` refuses a second live row, and
     * nothing caught it: the webhook answered a bare 500, which to Stripe is a
     * delivery to retry for three days rather than an answer — every retry
     * failing identically, while the customer is charged for a subscription
     * this platform holds no row for.
     *
     * The ordinary way in is a customer in dunning: `past_due` is a served
     * status, so their old row still holds the slot, and they subscribe again
     * believing the plan has lapsed.
     */
    it('answers the delivery instead of failing it forever', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'past_due',
        stripeSubscriptionId: 'sub_first_live',
      });
      const res = await deliver({
        type: 'checkout.session.completed',
        data: {
          object: {
            mode: 'subscription',
            payment_status: 'paid',
            subscription: 'sub_second_live',
            customer: 'cus_second_live',
            metadata: { user_id: user.id, plan_tier: 'enterprise' },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      // The first subscription is untouched — which one survives is a refund
      // decision somebody makes in Stripe, not one this handler makes.
      const { rows } = await ctx.pool.query<{ stripe_subscription_id: string }>(
        'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1',
        [user.id],
      );
      expect(rows.map((r) => r.stripe_subscription_id)).toEqual(['sub_first_live']);
    });

    it('tells the billing group, with the Stripe id needed to reconcile it', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const admin = await seedUser(ctx, { roles: ['admin'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        stripeSubscriptionId: 'sub_conflict_first',
      });
      await deliver({
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_conflict_second',
            status: 'active',
            metadata: { user_id: user.id, plan_tier: 'enterprise' },
          },
        },
      });
      const { rows } = await ctx.pool.query<{ body: string }>(
        "SELECT body FROM notifications WHERE user_id = $1 AND type = 'subscription_conflict'",
        [admin.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toContain('sub_conflict_second');
    });
  });

  describe('the subscriber is warned before a trial converts', () => {
    const noticesOf = async (userId: string) => {
      const { rows } = await ctx.pool.query<{ title: string; body: string }>(
        "SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'subscription_trial_ending'",
        [userId],
      );
      return rows;
    };

    it('names the day it converts and what will be charged', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'trialing',
        stripeSubscriptionId: 'sub_trial_1',
      });
      const res = await deliver({
        type: 'customer.subscription.trial_will_end',
        data: { object: { id: 'sub_trial_1', trial_end: Math.floor(Date.UTC(2026, 8, 2) / 1000) } },
      });
      expect(res.statusCode).toBe(200);
      const notes = await noticesOf(user.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.title).toBe('Your Annual retainer trial ends on 2026-09-02');
      // The price comes off the catalogue, so it is the figure the Billing
      // screen shows beside it.
      expect(notes[0]!.body).toContain('$20,000.00');
    });

    it('says nothing for a subscription that has already ended', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'trialing',
        stripeSubscriptionId: 'sub_trial_gone',
      });
      await deliver({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_trial_gone' } } });
      await deliver({
        type: 'customer.subscription.trial_will_end',
        data: { object: { id: 'sub_trial_gone', trial_end: Math.floor(Date.now() / 1000) + 259_200 } },
      });
      expect(await noticesOf(user.id)).toEqual([]);
    });

    it('says nothing for a subscription this platform does not carry', async () => {
      const res = await deliver({
        type: 'customer.subscription.trial_will_end',
        data: { object: { id: 'sub_trial_not_ours', trial_end: Math.floor(Date.now() / 1000) } },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('the subscriber is told their plan ended', () => {
    const notificationsOf = async (userId: string) => {
      const { rows } = await ctx.pool.query<{ type: string; title: string; body: string }>(
        'SELECT type, title, body FROM notifications WHERE user_id = $1 ORDER BY created_at ASC',
        [userId],
      );
      return rows;
    };

    /*
     * Cancellation takes the plan's quota away the moment it lands — a
     * 'canceled' row is not a served status — and it was the one billing
     * transition that produced no notification and no email. A subscription
     * Stripe cancelled at the end of dunning looked exactly like one the
     * customer had asked to end: silence.
     */
    it('notifies on customer.subscription.deleted, naming the plan and the day', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        stripeSubscriptionId: 'sub_ended_1',
      });
      await deliver({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_ended_1' } },
      });
      const notes = (await notificationsOf(user.id)).filter((n) => n.type === 'subscription_canceled');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.title).toContain('Annual retainer');
      expect(await findActiveSubscription(ctx.pool, user.id)).toBeNull();
    });

    /*
     * Stripe sends `updated` with status 'canceled' and `deleted` for one
     * cancellation and orders neither, so the notice has to be gated on which
     * write ended the subscription rather than on the event type or on the
     * status read back. Both orders, one notification each.
     */
    it('sends exactly one notice however the pair is ordered', async () => {
      for (const [first, second] of [
        ['updated', 'deleted'],
        ['deleted', 'updated'],
      ] as const) {
        const user = await seedUser(ctx, { roles: ['valuation_user'] });
        const stripeId = `sub_pair_${first}`;
        await upsertSubscription(ctx.pool, {
          userId: user.id,
          planTier: 'annual_retainer',
          stripeSubscriptionId: stripeId,
        });
        const events = {
          updated: {
            type: 'customer.subscription.updated',
            data: {
              object: {
                id: stripeId,
                status: 'canceled',
                metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
              },
            },
          },
          deleted: { type: 'customer.subscription.deleted', data: { object: { id: stripeId } } },
        };
        await deliver(events[first]);
        await deliver(events[second]);
        const notes = (await notificationsOf(user.id)).filter((n) => n.type === 'subscription_canceled');
        expect([first, notes.length]).toEqual([first, 1]);
      }
    });

    it('says nothing for a cancellation of a subscription this platform never carried', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await deliver({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_never_seen_1',
            status: 'canceled',
            metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
          },
        },
      });
      // The row is still recorded — that behaviour predates this and the
      // portal reads it for the customer id — but a subscription that was
      // created cancelled is not an account that just ended.
      expect((await subscriptionOf(user.id))?.status).toBe('canceled');
      expect((await notificationsOf(user.id)).filter((n) => n.type === 'subscription_canceled')).toEqual([]);
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

    it('records a prorated plan change as the two lines that explain it', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'enterprise',
        stripeSubscriptionId: 'sub_proration_1',
      });
      await deliver({
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_proration_1',
            subscription: 'sub_proration_1',
            amount_paid: 2_000_000,
            currency: 'usd',
            lines: {
              data: [
                { description: 'Unused time on Annual retainer', amount: -1_400_000 },
                { description: 'Remaining time on Enterprise', amount: 3_400_000 },
              ],
            },
          },
        },
      });
      const { rows } = await ctx.pool.query<{ line_items: Array<{ description: string }> }>(
        "SELECT line_items FROM invoices WHERE stripe_invoice_id = 'in_proration_1'",
      );
      // Netted into one line reading "Subscription", the invoice cannot answer
      // the only question a customer asks a proration.
      expect(rows[0]!.line_items.map((li) => li.description)).toEqual([
        'Unused time on Annual retainer',
        'Remaining time on Enterprise',
      ]);
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
