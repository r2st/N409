import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findActiveSubscription } from '../../src/repos/billing.js';
import { findStripeEvent } from '../../src/repos/stripeEvents.js';
import { createPayment } from '../../src/repos/payments.js';
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
