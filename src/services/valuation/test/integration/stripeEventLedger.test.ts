import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findActiveSubscription } from '../../src/repos/billing.js';
import { findStripeEvent } from '../../src/repos/stripeEvents.js';
import { createPayment, findPaymentBySessionId } from '../../src/repos/payments.js';
import { priceForKind } from '../../src/routes/payments.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The webhook event ledger (migration 0155).
 *
 * Stripe delivers at least once and guarantees no ordering, and every handler
 * on both endpoints was written knowing the first half. The half nothing
 * covered is the second: `customer.subscription.updated` carries the
 * subscription's state wholesale, so of two of them the later one is simply
 * right — and the upsert had no way to know which it was holding. Stripe's own
 * retry is the common way they arrive reversed. A delivery that fails at 10:00
 * and succeeds on its third attempt at 10:12 lands *after* the 10:05 event that
 * superseded it, and the subscription goes back to what it said at 10:00.
 */

const WEBHOOK_SECRET = 'whsec_ledger_test';
const dbUp = await isDbAvailable();

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

/** Unix seconds, since that is what Stripe puts in `created`. */
const T = Math.floor(Date.UTC(2026, 0, 2, 10, 0, 0) / 1000);

describe.skipIf(!dbUp)('stripe webhook event ledger', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  });
  afterAll(async () => ctx?.teardown());

  const deliver = (url: string, event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({ method: 'POST', url, headers: signedHeaders(payload), payload });
  };

  const toBilling = (event: unknown) => deliver('/api/v1/billing/webhook', event);
  const toPayments = (event: unknown) => deliver('/api/v1/stripe/webhook', event);

  /** A `customer.subscription.updated` for one subscription at one instant. */
  const subEvent = (args: {
    eventId: string;
    subId: string;
    userId: string;
    status: string;
    created: number;
    tier?: string;
  }) => ({
    id: args.eventId,
    type: 'customer.subscription.updated',
    created: args.created,
    data: {
      object: {
        id: args.subId,
        status: args.status,
        customer: `cus_${args.subId}`,
        metadata: { user_id: args.userId, plan_tier: args.tier ?? 'enterprise' },
      },
    },
  });

  describe('out-of-order subscription events', () => {
    it('refuses to let a retried older event undo a newer one', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const subId = 'sub_order_1';

      // 10:05 — the renewal failed and Stripe says past_due. Delivered first
      // because the 10:00 event's delivery is still being retried.
      const newer = await toBilling(
        subEvent({ eventId: 'evt_newer_1', subId, userId: user.id, status: 'past_due', created: T + 300 }),
      );
      expect(newer.statusCode).toBe(200);
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('past_due');

      // 10:00 — the event that said active, arriving late.
      const older = await toBilling(
        subEvent({ eventId: 'evt_older_1', subId, userId: user.id, status: 'active', created: T }),
      );
      expect(older.statusCode).toBe(200);
      expect(older.json()).toMatchObject({ received: true, stale: true });

      // Without the ledger this row reads 'active' again, and a subscriber
      // whose card has just been declined keeps the plan and its quota.
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('past_due');
      expect((await findStripeEvent(ctx.pool, 'evt_older_1'))?.outcome).toBe('stale');
    });

    it('applies the events in order when they arrive in order', async () => {
      // The vacuity guard: the test above must fail because the event was
      // stale, not because a second `updated` never lands at all.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const subId = 'sub_order_2';

      await toBilling(
        subEvent({ eventId: 'evt_ord_a', subId, userId: user.id, status: 'active', created: T }),
      );
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('active');

      const second = await toBilling(
        subEvent({ eventId: 'evt_ord_b', subId, userId: user.id, status: 'past_due', created: T + 300 }),
      );
      expect(second.json()).not.toHaveProperty('stale');
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('past_due');
    });

    it('applies both when Stripe stamped them the same second', async () => {
      // `created` has one-second resolution, so a tie carries no information.
      // Arrival order is then the only order there is — which is what happened
      // before the ledger existed, and is the safe answer where it cannot tell.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const subId = 'sub_order_3';

      await toBilling(
        subEvent({ eventId: 'evt_tie_a', subId, userId: user.id, status: 'past_due', created: T }),
      );
      const tie = await toBilling(
        subEvent({ eventId: 'evt_tie_b', subId, userId: user.id, status: 'active', created: T }),
      );
      expect(tie.json()).not.toHaveProperty('stale');
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('active');
    });

    it('orders each subscription against its own history, not the table', async () => {
      const a = await seedUser(ctx, { roles: ['valuation_user'] });
      const b = await seedUser(ctx, { roles: ['valuation_user'] });

      await toBilling(
        subEvent({
          eventId: 'evt_iso_a',
          subId: 'sub_iso_a',
          userId: a.id,
          status: 'active',
          created: T + 999,
        }),
      );
      // Older in absolute terms, but the first thing said about sub_iso_b.
      const other = await toBilling(
        subEvent({ eventId: 'evt_iso_b', subId: 'sub_iso_b', userId: b.id, status: 'active', created: T }),
      );
      expect(other.json()).not.toHaveProperty('stale');
      expect((await findActiveSubscription(ctx.pool, b.id))?.status).toBe('active');
    });
  });

  describe('duplicate delivery', () => {
    it('answers a redelivered event from the ledger without re-running it', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const event = subEvent({
        eventId: 'evt_dup_1',
        subId: 'sub_dup_1',
        userId: user.id,
        status: 'active',
        created: T,
      });

      expect((await toBilling(event)).statusCode).toBe(200);
      const replay = await toBilling(event);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ received: true, duplicate: true });
      expect((await findStripeEvent(ctx.pool, 'evt_dup_1'))?.outcome).toBe('handled');
    });

    it('records an event it decided to ignore, so the replay is not re-decided', async () => {
      const res = await toPayments({
        id: 'evt_ignored_1',
        type: 'customer.updated',
        created: T,
        data: { object: { id: 'cus_1' } },
      });
      expect(res.json()).toMatchObject({ received: true, ignored: 'customer.updated' });

      const row = await findStripeEvent(ctx.pool, 'evt_ignored_1');
      expect(row).toMatchObject({ endpoint: 'payments', outcome: 'handled' });
      // No object id: `customer.updated` is not a type whose order is
      // knowable, and putting it in the ordering index would let one fact
      // about an object suppress another.
      expect(row?.object_id).toBe(null);

      expect((await toPayments({ id: 'evt_ignored_1', type: 'customer.updated' })).json()).toMatchObject({
        duplicate: true,
      });
    });

    it('keeps the two endpoints apart in the ledger', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const vid = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(user.token),
          payload: { kind: '409a', company_name: 'Ledger Endpoint Co' },
        })
      ).json().valuation.id as string;
      await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_ledger_1',
        amountCents: priceForKind('409a'),
        currency: 'USD',
        createdBy: user.id,
      });

      await toPayments({
        id: 'evt_pay_1',
        type: 'checkout.session.completed',
        created: T,
        data: { object: { id: 'cs_ledger_1', payment_status: 'paid', amount_total: priceForKind('409a') } },
      });
      expect((await findStripeEvent(ctx.pool, 'evt_pay_1'))?.endpoint).toBe('payments');
    });

    /**
     * One Stripe event, delivered to both endpoints, is not a replay.
     *
     * An Event is created once and delivered to every registered endpoint
     * subscribed to its type, carrying the same `evt_…` id to each. Both of this
     * service's webhooks are subscribed to `checkout.session.completed`, and
     * they have to be: the payments endpoint fulfils a `mode: 'payment'` session
     * and the billing endpoint starts the subscription for a
     * `mode: 'subscription'` one, each branching on `mode` and ignoring the
     * other's. Keyed on the event id alone, whichever delivery arrived second
     * was answered from the ledger as a duplicate and its half never ran.
     */
    it('handles the same event at both endpoints, because that is not a replay', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const vid = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(user.token),
          payload: { kind: '409a', company_name: 'Both Endpoints Co' },
        })
      ).json().valuation.id as string;
      await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_both_1',
        amountCents: priceForKind('409a'),
        currency: 'USD',
        createdBy: user.id,
      });

      const event = {
        id: 'evt_both_1',
        type: 'checkout.session.completed',
        created: T,
        data: {
          object: {
            id: 'cs_both_1',
            mode: 'payment',
            payment_status: 'paid',
            amount_total: priceForKind('409a'),
          },
        },
      };

      // The billing endpoint sees it first. Its mode is 'payment', so it
      // matches no branch there and is recorded as dealt with.
      expect((await toBilling(event)).statusCode).toBe(200);

      // The payments endpoint's delivery is the one that fulfils. Keyed on the
      // event id alone it was refused here, the payments row stayed 'pending'
      // forever, and the client had paid for a 409A they would never be given —
      // with a 200 to Stripe, so no retry and no failed-delivery list to find
      // it in.
      const fulfilled = await toPayments(event);
      expect(fulfilled.statusCode).toBe(200);
      expect(fulfilled.json()).not.toMatchObject({ duplicate: true });
      expect((await findPaymentBySessionId(ctx.pool, 'cs_both_1'))?.status).toBe('succeeded');

      // Each endpoint keeps its own row, and a genuine redelivery to the same
      // endpoint is still a duplicate.
      expect((await findStripeEvent(ctx.pool, 'evt_both_1', 'billing'))?.endpoint).toBe('billing');
      expect((await findStripeEvent(ctx.pool, 'evt_both_1', 'payments'))?.endpoint).toBe('payments');
      expect((await toPayments(event)).json()).toMatchObject({ duplicate: true });
    });
  });

  /**
   * The other writer of subscription state.
   *
   * A subscription-mode `checkout.session.completed` is handled by writing a
   * status through the same `upsertSubscription` the `customer.subscription.*`
   * events use — 'active' or 'past_due', derived from the session's
   * `payment_status`. So it is a snapshot of the subscription's state like they
   * are, and the same reordering applies to it: the billing route answers a
   * failed handler with a 5xx to provoke redelivery, so a transient failure is
   * ordinarily redelivered minutes later, after the subscription event that has
   * since said what the status really is.
   */
  describe('a subscription checkout among the subscription events', () => {
    const checkoutEvent = (args: {
      eventId: string;
      subId: string;
      userId: string;
      paymentStatus: string;
      created: number;
    }) => ({
      id: args.eventId,
      type: 'checkout.session.completed',
      created: args.created,
      data: {
        object: {
          id: `cs_${args.subId}`,
          mode: 'subscription',
          payment_status: args.paymentStatus,
          subscription: args.subId,
          customer: `cus_${args.subId}`,
          metadata: { user_id: args.userId, plan_tier: 'enterprise' },
        },
      },
    });

    it('refuses to let a retried checkout undo a newer subscription event', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const subId = 'sub_cs_1';

      // 10:05 — the first debit was declined and Stripe says past_due.
      await toBilling(
        subEvent({ eventId: 'evt_cs_newer', subId, userId: user.id, status: 'past_due', created: T + 300 }),
      );
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('past_due');

      // 10:00 — the checkout session that said the money landed, arriving late
      // because its first delivery failed and Stripe retried it.
      const late = await toBilling(
        checkoutEvent({
          eventId: 'evt_cs_older',
          subId,
          userId: user.id,
          paymentStatus: 'paid',
          created: T,
        }),
      );
      expect(late.statusCode).toBe(200);
      expect(late.json()).toMatchObject({ received: true, stale: true });

      // Without the ordering key this reads 'active' again, and a subscriber
      // whose payment was declined keeps the plan and its quota.
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('past_due');
    });

    it('applies the checkout when nothing newer is known about the subscription', async () => {
      // The vacuity guard: the test above must fail because the event was
      // stale, not because a subscription checkout never lands at all.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const first = await toBilling(
        checkoutEvent({
          eventId: 'evt_cs_first',
          subId: 'sub_cs_2',
          userId: user.id,
          paymentStatus: 'paid',
          created: T,
        }),
      );
      expect(first.json()).not.toHaveProperty('stale');
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('active');
    });

    it('never lets a checkout session suppress a subscription event', async () => {
      // The ordering is deliberately asymmetric. `customer.subscription.*`
      // carries `current_period_start`/`_end`, which no checkout session has and
      // which the quota reset keys off, and a subscription event created a
      // second earlier and delivered a moment later is an ordinary sequence.
      // Suppressing it symmetrically would drop the billing period to protect a
      // status the subscription event is the authority on — trading a real loss
      // for a smaller one. This pins that direction against being "simplified"
      // into symmetry later.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const subId = 'sub_cs_3';

      await toBilling(
        checkoutEvent({
          eventId: 'evt_cs_newer_2',
          subId,
          userId: user.id,
          paymentStatus: 'paid',
          created: T + 300,
        }),
      );
      const older = await toBilling(
        subEvent({ eventId: 'evt_sub_older', subId, userId: user.id, status: 'past_due', created: T }),
      );
      expect(older.json()).not.toHaveProperty('stale');
    });
  });

  describe('a payload with no event id', () => {
    it('is always handled, because inventing a rule Stripe does not have is worse', async () => {
      // Every real delivery carries an `evt_…`. A payload without one is
      // something constructed by hand — an operator's curl, a replay tool —
      // and refusing to act on it would be a rule of our own invention.
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_noid',
            status: 'active',
            metadata: { user_id: user.id, plan_tier: 'enterprise' },
          },
        },
      };
      expect((await toBilling(event)).json()).not.toHaveProperty('duplicate');
      expect((await toBilling(event)).json()).not.toHaveProperty('duplicate');
      expect((await findActiveSubscription(ctx.pool, user.id))?.status).toBe('active');
    });
  });
});
