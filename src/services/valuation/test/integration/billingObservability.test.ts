/**
 * What the billing webhooks say out loud about money that did not arrive.
 *
 * The audit trail and the notification centre both learned about a declined
 * renewal in R215; the log did not. `alertPaymentFailed` writes a line only
 * when its own notification insert *fails*, so the ordinary dunning path —
 * mark past due, audit, tell the subscriber and the billing group — produced
 * no log output at all. Nothing on the log side could count declines over a
 * window, join a run of them to one account, or be looked up against the
 * `evt_…` the Stripe dashboard shows.
 *
 * And the branch below it wrote nothing at all: `markSubscriptionPastDue`
 * answers null both for a subscription that has already ended (ordinary) and
 * for one this platform holds no row for (a subscriber being billed for a plan
 * we cannot see), and neither was distinguished or mentioned.
 *
 * Driven through `app.inject` against the real handler, like
 * `stripeWebhookCorrelation.test.ts`: the claim is about the wiring, and a unit
 * test of a logger passes whether or not the route reaches it.
 */

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { newUlid } from '@n409/shared';
import { createUser } from '../../src/repos/users.js';
import { createPayment, markPayment } from '../../src/repos/payments.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const WEBHOOK_SECRET = 'whsec_billing_observability';
const dbUp = await isDbAvailable();

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

describe.skipIf(!dbUp)('a declined renewal on the billing webhook', () => {
  let ctx: TestApp;
  let lines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // 'info', because `setupTestApp` runs at 'silent' and every assertion below
    // would then read an empty array — the vacuity the last test guards.
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, LOG_LEVEL: 'info' });
    lines = [];
    (ctx.app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
  });
  afterAll(async () => ctx?.teardown());

  const deliver = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: signedHeaders(payload),
      payload,
    });
  };
  const since = (mark: number) => lines.slice(mark);

  const subscriber = async (
    email: string,
    stripeSubscriptionId: string | null,
    stripeCustomerId: string,
    status = 'active',
  ): Promise<string> => {
    const userId = (await createUser(ctx.pool, { email, passwordDigest: 'x', roles: ['valuation_user'] })).id;
    await ctx.pool.query(
      `INSERT INTO subscriptions (id, user_id, plan_tier, status, stripe_subscription_id, stripe_customer_id)
       VALUES ($1, $2, 'annual_retainer', $3, $4, $5)`,
      [newUlid(), userId, status, stripeSubscriptionId, stripeCustomerId],
    );
    return userId;
  };

  const failedInvoice = (id: string, object: Record<string, unknown>) => ({
    id,
    type: 'invoice.payment_failed',
    created: Math.floor(Date.UTC(2026, 2, 3, 9, 0, 0) / 1000),
    data: { object: { object: 'invoice', ...object } },
  });

  it('names the account, the invoice and the amount when a renewal declines', async () => {
    const userId = await subscriber('dunning-logged@obs.example.com', 'sub_obs_live', 'cus_obs_live');

    const mark = lines.length;
    const res = await deliver(
      failedInvoice('evt_obs_dunning_1', {
        id: 'in_obs_declined',
        subscription: 'sub_obs_live',
        customer: 'cus_obs_live',
        amount_due: 48_000,
        currency: 'eur',
        attempt_count: 2,
      }),
    );
    expect(res.statusCode).toBe(200);

    const line = since(mark).find((l) => String(l.msg).includes('renewal payment failed'));
    expect(line).toBeDefined();
    expect(line!.userId).toBe(userId);
    expect(line!.stripeSubscriptionId).toBe('sub_obs_live');
    expect(line!.stripeInvoiceId).toBe('in_obs_declined');
    expect(line!.amountDueCents).toBe(48_000);
    // The invoice's own currency, like the notification beside it: a declined
    // €480 renewal logged as usd is a figure nobody can match to Stripe.
    expect(line!.currency).toBe('eur');
    expect(line!.status).toBe('past_due');
    expect(line!.attemptCount).toBe(2);
    // The delivery it came in on, from the child logger both webhooks bind.
    expect(line!.stripeEventId).toBe('evt_obs_dunning_1');
    /*
     * And at `warn` without the alert flag. Stripe's dunning schedule retries
     * this invoice for weeks, the subscriber has been asked to fix the card and
     * the plan is still served throughout, which is precisely the case
     * `logFailure` downgrades — the flag belongs to the failure nobody is
     * retrying, asserted below.
     */
    expect(line!.level).toBe('warn');
    expect(line!.alert).toBeUndefined();
  });

  it('alerts when the declining subscription is one we hold no row for', async () => {
    // The customer is ours — we carry a subscription for them — but the
    // subscription being billed is not one we know, so nothing moved to
    // past_due, nobody was told, and the account keeps its entitlement.
    const userId = await subscriber('dunning-unknown@obs.example.com', 'sub_obs_known', 'cus_obs_known');

    const mark = lines.length;
    expect(
      (
        await deliver(
          failedInvoice('evt_obs_dunning_2', {
            id: 'in_obs_unknown_sub',
            subscription: 'sub_obs_never_seen',
            customer: 'cus_obs_known',
            amount_due: 120_000,
            currency: 'usd',
          }),
        )
      ).statusCode,
    ).toBe(200);

    const alert = since(mark).find((l) => l.alert === true);
    expect(alert).toBeDefined();
    expect(alert!.userId).toBe(userId);
    expect(alert!.stripeSubscriptionId).toBe('sub_obs_never_seen');
    expect(alert!.stripeCustomerId).toBe('cus_obs_known');
    expect(alert!.stripeInvoiceId).toBe('in_obs_unknown_sub');
    expect(alert!.amountDueCents).toBe(120_000);
    expect(alert!.stripeEventId).toBe('evt_obs_dunning_2');
  });

  it('stays quiet about a final invoice on a subscription that has already ended', async () => {
    await subscriber('dunning-ended@obs.example.com', 'sub_obs_ended', 'cus_obs_ended', 'canceled');

    const mark = lines.length;
    expect(
      (
        await deliver(
          failedInvoice('evt_obs_dunning_3', {
            id: 'in_obs_final',
            subscription: 'sub_obs_ended',
            customer: 'cus_obs_ended',
            amount_due: 9_900,
            currency: 'usd',
          }),
        )
      ).statusCode,
    ).toBe(200);

    // Ordinary: Stripe raises a last invoice against a cancelled subscription
    // and it declines. An alert on that is how the alert above stops being read.
    expect(since(mark).find((l) => l.alert === true)).toBeUndefined();
    const noted = since(mark).find((l) => String(l.msg).includes('nothing to mark past due'));
    expect(noted).toBeDefined();
    expect(noted!.stripeSubscriptionId).toBe('sub_obs_ended');
  });

  it('stays quiet about a failed invoice belonging to another integration', async () => {
    const mark = lines.length;
    expect(
      (
        await deliver(
          failedInvoice('evt_obs_dunning_4', {
            id: 'in_obs_stranger',
            subscription: 'sub_obs_stranger',
            customer: 'cus_obs_stranger',
            amount_due: 500,
            currency: 'usd',
          }),
        )
      ).statusCode,
    ).toBe(200);
    // A webhook endpoint receives every event on the Stripe account. A customer
    // we have never seen is somebody else's renewal.
    expect(since(mark).find((l) => l.alert === true)).toBeUndefined();
  });

  /**
   * The denominator. A log carrying only the ways a renewal fails cannot answer
   * what share of them are failing, and a settled renewal — which allocates the
   * sequenced invoice number an auditor reads as a count of what was billed —
   * said nothing at all.
   */
  it('records a renewal that went through, with the number it allocated', async () => {
    const userId = await subscriber('renewal-settled@obs.example.com', 'sub_obs_paid', 'cus_obs_paid');

    const mark = lines.length;
    expect(
      (
        await deliver({
          id: 'evt_obs_invoice_paid',
          type: 'invoice.paid',
          created: Math.floor(Date.UTC(2026, 2, 3, 12, 0, 0) / 1000),
          data: {
            object: {
              id: 'in_obs_settled',
              object: 'invoice',
              subscription: 'sub_obs_paid',
              customer: 'cus_obs_paid',
              amount_paid: 480_000,
              currency: 'usd',
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    const line = lines.slice(mark).find((l) => String(l.msg).includes('invoice settled'));
    expect(line).toBeDefined();
    expect(line!.userId).toBe(userId);
    expect(line!.stripeInvoiceId).toBe('in_obs_settled');
    expect(line!.amountCents).toBe(480_000);
    expect(line!.currency).toBe('usd');
    expect(line!.invoiceNumber).toEqual(expect.any(String));
    expect(line!.stripeEventId).toBe('evt_obs_invoice_paid');
  });

  /**
   * The marker the four above are vacuous without: `setupTestApp` defaults to
   * 'silent', and a `lines` array that never fills reads as every "stayed
   * quiet" assertion passing.
   */
  it('is reading a log stream at all', () => {
    expect(lines.length).toBeGreaterThan(0);
  });
});

/**
 * And the one-time flow's version of the same silence.
 *
 * A delayed-notification debit (ACH, SEPA, Bacs) bouncing days after the client
 * clicked through Checkout is the one payment outcome with a gap between what
 * the client believes and what the row says. It marked the payment failed and
 * notified the client and the billing group, and — like the dunning path above
 * — `alertBilling` writes a line only when its own notification insert fails,
 * so the settlement failing left nothing in this service's log.
 */
describe.skipIf(!dbUp)('a delayed payment method that fails to settle', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  let lines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, LOG_LEVEL: 'info' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    lines = [];
    (ctx.app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
  });
  afterAll(async () => ctx?.teardown());

  it('names the session, the payment and the engagement it left unpaid', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Bounced Debit Co' },
    });
    expect(created.statusCode).toBe(201);
    const valuationId = created.json().valuation.id as string;
    const payment = await createPayment(ctx.pool, {
      valuationId,
      sessionId: 'cs_obs_ach_failed',
      amountCents: 250_000,
      currency: 'USD',
      createdBy: ops.id,
    });

    const event = {
      id: 'evt_obs_ach_failed',
      type: 'checkout.session.async_payment_failed',
      created: Math.floor(Date.UTC(2026, 2, 3, 10, 0, 0) / 1000),
      data: { object: { id: 'cs_obs_ach_failed', object: 'checkout.session' } },
    };
    const payload = JSON.stringify(event);
    const mark = lines.length;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stripe/webhook',
      headers: signedHeaders(payload),
      payload,
    });
    expect(res.statusCode).toBe(200);

    const line = lines.slice(mark).find((l) => String(l.msg).includes('failed to settle'));
    expect(line).toBeDefined();
    expect(line!.sessionId).toBe('cs_obs_ach_failed');
    expect(line!.paymentId).toBe(payment.id);
    expect(line!.valuationId).toBe(valuationId);
    expect(line!.amountCents).toBe(250_000);
    expect(line!.currency).toBe('USD');
    // The delivery, from the child logger the handler binds.
    expect(line!.stripeEventId).toBe('evt_obs_ach_failed');
    // The engagement is correctly unpaid and both the client and the billing
    // group have been told, so nothing is waiting on a person of ours.
    expect(line!.level).toBe('warn');
    expect(line!.alert).toBeUndefined();
  });

  /**
   * And not a second time. The compare-and-set that stops the notification
   * going out twice is upstream of the line, so a redelivery must be as quiet
   * as it is harmless.
   */
  it('says it once, however many times Stripe delivers it', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Bounced Twice Co' },
    });
    const valuationId = created.json().valuation.id as string;
    await createPayment(ctx.pool, {
      valuationId,
      sessionId: 'cs_obs_ach_replay',
      amountCents: 100_000,
      currency: 'USD',
      createdBy: ops.id,
    });
    const deliver = (eventId: string) => {
      const payload = JSON.stringify({
        id: eventId,
        type: 'checkout.session.async_payment_failed',
        created: Math.floor(Date.UTC(2026, 2, 3, 11, 0, 0) / 1000),
        data: { object: { id: 'cs_obs_ach_replay', object: 'checkout.session' } },
      });
      return ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(payload),
        payload,
      });
    };
    await deliver('evt_obs_ach_replay_1');

    const mark = lines.length;
    // A different event id, so the ledger cannot collapse it — the same way
    // `invoice.paid` and `invoice.payment_succeeded` arrive for one payment.
    await deliver('evt_obs_ach_replay_2');
    expect(lines.slice(mark).filter((l) => String(l.msg).includes('failed to settle'))).toHaveLength(0);
  });
});

/**
 * Tracing one subscription from the click that started it.
 *
 * The audit catalogue says `checkout_started` and the webhook row it precedes
 * are "the join between 'a person clicked Manage subscription' and 'the plan
 * changed an hour later'". `checkout_started` records `checkout_session_id`;
 * `subscription_started` recorded the event, the subscription and the customer
 * and never the session — so the documented join was "same user, roughly the
 * same minute", which is precisely the reasoning that fails on the account that
 * started two checkouts before either completed.
 */
describe.skipIf(!dbUp)('a subscription checkout on the billing webhook', () => {
  let ctx: TestApp;
  let lines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, LOG_LEVEL: 'info' });
    lines = [];
    (ctx.app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
  });
  afterAll(async () => ctx?.teardown());

  const deliver = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: signedHeaders(payload),
      payload,
    });
  };

  it('records the session id on the subscription it started', async () => {
    const userId = (
      await createUser(ctx.pool, {
        email: 'sub-join@obs.example.com',
        passwordDigest: 'x',
        roles: ['valuation_user'],
      })
    ).id;

    expect(
      (
        await deliver({
          id: 'evt_obs_checkout_1',
          type: 'checkout.session.completed',
          created: Math.floor(Date.UTC(2026, 2, 4, 9, 0, 0) / 1000),
          data: {
            object: {
              id: 'cs_obs_sub_join',
              object: 'checkout.session',
              mode: 'subscription',
              payment_status: 'paid',
              subscription: 'sub_obs_join',
              customer: 'cus_obs_join',
              client_reference_id: userId,
              metadata: { user_id: userId, plan_tier: 'annual_retainer' },
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    const { rows } = await ctx.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM admin_events WHERE type = 'subscription_started' AND subject_id = $1`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    // The field the request-side row is written with, so the two join on a
    // value rather than on a timestamp.
    expect(rows[0]!.payload.checkout_session_id).toBe('cs_obs_sub_join');
    expect(rows[0]!.payload.stripe_event_id).toBe('evt_obs_checkout_1');
  });

  it('alerts when a checkout of ours completes with no plan to attribute it to', async () => {
    // `client_reference_id` is a ULID of ours and the metadata is gone: a
    // subscriber has been put on a recurring charge this platform recorded
    // nothing for, and the delivery used to be dropped without a word.
    const userId = (
      await createUser(ctx.pool, {
        email: 'sub-unattributed@obs.example.com',
        passwordDigest: 'x',
        roles: ['valuation_user'],
      })
    ).id;

    const mark = lines.length;
    expect(
      (
        await deliver({
          id: 'evt_obs_checkout_2',
          type: 'checkout.session.completed',
          created: Math.floor(Date.UTC(2026, 2, 4, 10, 0, 0) / 1000),
          data: {
            object: {
              id: 'cs_obs_unattributed',
              object: 'checkout.session',
              mode: 'subscription',
              payment_status: 'paid',
              subscription: 'sub_obs_unattributed',
              customer: 'cus_obs_unattributed',
              client_reference_id: userId,
              metadata: {},
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    const alert = lines.slice(mark).find((l) => l.alert === true);
    expect(alert).toBeDefined();
    expect(alert!.userId).toBe(userId);
    expect(alert!.checkoutSessionId).toBe('cs_obs_unattributed');
    expect(alert!.stripeSubscriptionId).toBe('sub_obs_unattributed');
    expect(alert!.stripeEventId).toBe('evt_obs_checkout_2');
  });

  it('stays quiet about a subscription checkout that is not ours', async () => {
    const mark = lines.length;
    expect(
      (
        await deliver({
          id: 'evt_obs_checkout_3',
          type: 'checkout.session.completed',
          created: Math.floor(Date.UTC(2026, 2, 4, 11, 0, 0) / 1000),
          data: {
            object: {
              id: 'cs_obs_stranger',
              object: 'checkout.session',
              mode: 'subscription',
              payment_status: 'paid',
              subscription: 'sub_obs_stranger',
              customer: 'cus_obs_stranger',
              metadata: {},
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(lines.slice(mark).find((l) => l.alert === true)).toBeUndefined();
  });

  /**
   * The other half of the same silence: a subscription this platform carries
   * whose metadata was edited away in the Stripe dashboard. Every event about
   * it — a plan swap, a card recovered, a cancellation — was ignored, and the
   * row went on granting quota from whatever status it last held.
   */
  it('alerts when a subscription we carry updates with no metadata', async () => {
    const userId = (
      await createUser(ctx.pool, {
        email: 'sub-stripped@obs.example.com',
        passwordDigest: 'x',
        roles: ['valuation_user'],
      })
    ).id;
    await ctx.pool.query(
      `INSERT INTO subscriptions (id, user_id, plan_tier, status, stripe_subscription_id, stripe_customer_id)
       VALUES ($1, $2, 'annual_retainer', 'active', 'sub_obs_stripped', 'cus_obs_stripped')`,
      [newUlid(), userId],
    );

    const mark = lines.length;
    expect(
      (
        await deliver({
          id: 'evt_obs_stripped_1',
          type: 'customer.subscription.updated',
          created: Math.floor(Date.UTC(2026, 2, 4, 12, 0, 0) / 1000),
          data: {
            object: {
              id: 'sub_obs_stripped',
              object: 'subscription',
              status: 'canceled',
              customer: 'cus_obs_stripped',
              metadata: {},
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    const alert = lines.slice(mark).find((l) => l.alert === true);
    expect(alert).toBeDefined();
    expect(alert!.userId).toBe(userId);
    expect(alert!.stripeSubscriptionId).toBe('sub_obs_stripped');
    expect(alert!.stripeStatus).toBe('canceled');
    expect(alert!.heldStatus).toBe('active');
    // And nothing was written on a guess: the row still says what it said.
    const { rows } = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM subscriptions WHERE stripe_subscription_id = 'sub_obs_stripped'`,
    );
    expect(rows[0]!.status).toBe('active');
  });

  it('stays quiet about a subscription update for a subscription we do not carry', async () => {
    const mark = lines.length;
    expect(
      (
        await deliver({
          id: 'evt_obs_stripped_2',
          type: 'customer.subscription.updated',
          created: Math.floor(Date.UTC(2026, 2, 4, 13, 0, 0) / 1000),
          data: {
            object: {
              id: 'sub_obs_not_ours',
              object: 'subscription',
              status: 'active',
              customer: 'cus_obs_not_ours',
              metadata: {},
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(lines.slice(mark).find((l) => l.alert === true)).toBeUndefined();
  });

  it('is reading a log stream at all', () => {
    expect(lines.length).toBeGreaterThan(0);
  });
});

/**
 * The quota, whose two events were both silent.
 *
 * A subscriber turned away at their plan limit is a 402, and the shared error
 * handler logs 5xx and the database branches — a described 4xx passes without a
 * line. So the most actionable commercial signal this service produces was
 * legible only to the customer who hit it, and so were the two ways the quota
 * accounting goes wrong: a period that was paid for but never granted, and a
 * counter left one high by a release that failed. Both present as this refusal
 * and nothing else.
 */
describe.skipIf(!dbUp)('plan quota', () => {
  let ctx: TestApp;
  let lines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, LOG_LEVEL: 'info' });
    lines = [];
    (ctx.app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
  });
  afterAll(async () => ctx?.teardown());

  it('says who was refused, on what plan, and which period the counter is counting', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const periodStart = new Date(Date.UTC(2026, 0, 1));
    // Exhausted on arrival: the refusal is the subject, not the twelve
    // creations that would otherwise get there.
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (id, user_id, plan_tier, status, stripe_subscription_id, stripe_customer_id,
          current_period_start, current_period_end, quota_period_start, valuations_used)
       VALUES ($1, $2, 'annual_retainer', 'active', 'sub_obs_quota', 'cus_obs_quota', $3, $4, $3, 12)
       RETURNING id`,
      [newUlid(), user.id, periodStart, new Date(Date.UTC(2027, 0, 1))],
    );

    const mark = lines.length;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(user.token),
      payload: { kind: '409a', company_name: 'Over Limit Co' },
    });
    expect(res.statusCode).toBe(402);

    const line = lines.slice(mark).find((l) => String(l.msg).includes('plan valuation limit reached'));
    expect(line).toBeDefined();
    expect(line!.userId).toBe(user.id);
    expect(line!.subscriptionId).toBe(rows[0]!.id);
    expect(line!.planTier).toBe('annual_retainer');
    expect(line!.valuationsUsed).toBe(12);
    expect(line!.valuationLimit).toBe(12);
    // The pair that says whether this period was ever granted: equal here, so
    // the counter is counting the period the row is showing.
    expect(line!.quotaPeriodStart).toBe(periodStart.toISOString());
    expect(line!.currentPeriodStart).toBe(periodStart.toISOString());
    expect(line!.subscriptionStatus).toBe('active');
    expect(line!.level).toBe('warn');
  });

  /**
   * And the grant itself, which happens inside `upsertSubscription`'s statement
   * — gated on the money as well as the date, subtle enough to have been got
   * wrong twice, and reported by nothing.
   */
  it('says when a renewal grants the next period', async () => {
    const userId = (
      await createUser(ctx.pool, {
        email: 'quota-grant@obs.example.com',
        passwordDigest: 'x',
        roles: ['valuation_user'],
      })
    ).id;
    const first = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    const second = Math.floor(Date.UTC(2027, 0, 1) / 1000);
    const renewal = (eventId: string, start: number) => {
      const payload = JSON.stringify({
        id: eventId,
        type: 'customer.subscription.updated',
        created: start,
        data: {
          object: {
            id: 'sub_obs_grant',
            object: 'subscription',
            status: 'active',
            customer: 'cus_obs_grant',
            current_period_start: start,
            current_period_end: start + 31_536_000,
            metadata: { user_id: userId, plan_tier: 'annual_retainer' },
          },
        },
      });
      return ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: signedHeaders(payload),
        payload,
      });
    };

    // The first delivery creates the row, so there is no previous period and
    // nothing was granted *again*.
    const opened = lines.length;
    expect((await renewal('evt_obs_grant_1', first)).statusCode).toBe(200);
    expect(lines.slice(opened).find((l) => String(l.msg).includes('quota granted'))).toBeUndefined();
    await ctx.pool.query(
      `UPDATE subscriptions SET valuations_used = 7 WHERE stripe_subscription_id = 'sub_obs_grant'`,
    );

    const mark = lines.length;
    expect((await renewal('evt_obs_grant_2', second)).statusCode).toBe(200);
    const line = lines.slice(mark).find((l) => String(l.msg).includes('quota granted'));
    expect(line).toBeDefined();
    expect(line!.userId).toBe(userId);
    expect(line!.quotaPeriodStart).toBe(new Date(second * 1000).toISOString());
    expect(line!.previousQuotaPeriodStart).toBe(new Date(first * 1000).toISOString());
    // What the grant cleared, which is the figure that says whether the period
    // it replaced was fully used or thrown away.
    expect(line!.valuationsUsedBefore).toBe(7);
    expect(
      (
        await ctx.pool.query<{ valuations_used: number }>(
          `SELECT valuations_used FROM subscriptions WHERE stripe_subscription_id = 'sub_obs_grant'`,
        )
      ).rows[0]!.valuations_used,
    ).toBe(0);
  });

  /**
   * The reference-equality trap this line was first written with: two `Date`
   * objects the driver built separately are never `===`, so an update that
   * grants nothing must stay quiet or the line means nothing.
   */
  it('says nothing on an update that grants no new period', async () => {
    const userId = (
      await createUser(ctx.pool, {
        email: 'quota-nogrant@obs.example.com',
        passwordDigest: 'x',
        roles: ['valuation_user'],
      })
    ).id;
    const start = Math.floor(Date.UTC(2026, 5, 1) / 1000);
    const deliver = (eventId: string, extra: Record<string, unknown> = {}) => {
      const payload = JSON.stringify({
        id: eventId,
        type: 'customer.subscription.updated',
        created: start,
        data: {
          object: {
            id: 'sub_obs_nogrant',
            object: 'subscription',
            status: 'active',
            customer: 'cus_obs_nogrant',
            current_period_start: start,
            current_period_end: start + 2_592_000,
            metadata: { user_id: userId, plan_tier: 'annual_retainer' },
            ...extra,
          },
        },
      });
      return ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: signedHeaders(payload),
        payload,
      });
    };
    await deliver('evt_obs_nogrant_1');

    const mark = lines.length;
    // Same period, a different fact about it — the shape Stripe sends most of.
    expect((await deliver('evt_obs_nogrant_2', { cancel_at_period_end: true })).statusCode).toBe(200);
    expect(lines.slice(mark).find((l) => String(l.msg).includes('quota granted'))).toBeUndefined();
  });

  it('is reading a log stream at all', () => {
    expect(lines.length).toBeGreaterThan(0);
  });
});

/**
 * Money going back out, which reached the audit trail in R215 and the
 * notification centre before that and the log never.
 *
 * `auditPayment` writes a line only when its own insert fails and
 * `alertBilling` only when its notification insert does, so a refund that
 * worked and a chargeback that opened were both invisible here. The trail
 * answers "what happened to this engagement" a row at a time; what nothing
 * could answer was how much went back out over a window, or which delivery a
 * reversal arrived on — `evt_…` is not a column on the trail.
 */
describe.skipIf(!dbUp)('a reversal on the payments webhook', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  let lines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, LOG_LEVEL: 'info' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    lines = [];
    (ctx.app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
  });
  afterAll(async () => ctx?.teardown());

  /** A settled engagement payment, which is what a reversal needs to arrive at. */
  const settledPayment = async (
    companyName: string,
    sessionId: string,
    chargeId: string,
  ): Promise<{ valuationId: string; paymentId: string }> => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(created.statusCode).toBe(201);
    const valuationId = created.json().valuation.id as string;
    const payment = await createPayment(ctx.pool, {
      valuationId,
      sessionId,
      amountCents: 200_000,
      currency: 'USD',
      createdBy: ops.id,
    });
    await markPayment(ctx.pool, payment.id, 'succeeded', { from: ['pending'] });
    await ctx.pool.query(`UPDATE payments SET charge_id = $1 WHERE id = $2`, [chargeId, payment.id]);
    return { valuationId, paymentId: payment.id };
  };

  const deliver = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stripe/webhook',
      headers: signedHeaders(payload),
      payload,
    });
  };

  it('says how much came back and whether the engagement kept its payment', async () => {
    const { valuationId, paymentId } = await settledPayment(
      'Partly Refunded Co',
      'cs_obs_refund',
      'ch_obs_refund',
    );

    const mark = lines.length;
    expect(
      (
        await deliver({
          id: 'evt_obs_refund_1',
          type: 'charge.refunded',
          created: Math.floor(Date.UTC(2026, 2, 5, 9, 0, 0) / 1000),
          data: {
            object: {
              id: 'ch_obs_refund',
              object: 'charge',
              currency: 'usd',
              amount_refunded: 50_000,
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    const line = lines.slice(mark).find((l) => String(l.msg).includes('partially refunded'));
    expect(line).toBeDefined();
    expect(line!.paymentId).toBe(paymentId);
    expect(line!.valuationId).toBe(valuationId);
    expect(line!.refundedCents).toBe(50_000);
    expect(line!.amountCents).toBe(200_000);
    expect(line!.fullyRefunded).toBe(false);
    // The delivery, so the line joins to the Stripe dashboard the way the
    // audit row's `stripe_event_id` does.
    expect(line!.stripeEventId).toBe('evt_obs_refund_1');
  });

  it('says it once however many times the refund is delivered', async () => {
    await settledPayment('Refunded Twice Co', 'cs_obs_refund_replay', 'ch_obs_refund_replay');
    const refund = (eventId: string) => ({
      id: eventId,
      type: 'charge.refunded',
      created: Math.floor(Date.UTC(2026, 2, 5, 10, 0, 0) / 1000),
      data: {
        object: {
          id: 'ch_obs_refund_replay',
          object: 'charge',
          currency: 'usd',
          amount_refunded: 200_000,
        },
      },
    });
    await deliver(refund('evt_obs_refund_replay_1'));

    const mark = lines.length;
    await deliver(refund('evt_obs_refund_replay_2'));
    // The compare-and-set that stops a second audit row and a second
    // notification is upstream of the line, so the redelivery is as quiet as it
    // is harmless.
    expect(lines.slice(mark).filter((l) => String(l.msg).includes('refunded'))).toHaveLength(0);
  });

  it('alerts when a chargeback opens, because the deadline is the point', async () => {
    const { valuationId, paymentId } = await settledPayment(
      'Disputed Co',
      'cs_obs_dispute',
      'ch_obs_dispute',
    );

    const mark = lines.length;
    expect(
      (
        await deliver({
          id: 'evt_obs_dispute_1',
          type: 'charge.dispute.created',
          created: Math.floor(Date.UTC(2026, 2, 5, 11, 0, 0) / 1000),
          data: {
            object: {
              id: 'dp_obs_dispute',
              object: 'dispute',
              charge: 'ch_obs_dispute',
              status: 'needs_response',
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    const alert = lines.slice(mark).find((l) => l.alert === true);
    expect(alert).toBeDefined();
    expect(alert!.paymentId).toBe(paymentId);
    expect(alert!.valuationId).toBe(valuationId);
    expect(alert!.disputeStatus).toBe('open');
    expect(alert!.chargeId).toBe('ch_obs_dispute');
    expect(alert!.stripeEventId).toBe('evt_obs_dispute_1');
  });

  /**
   * The step the trace used to break at. Everything around a settlement said
   * something — the delayed method waiting, the resumed fulfilment, the
   * delivery that lost the race, the debit that bounced — and money actually
   * arriving said nothing.
   */
  it('records the settlement that released the engagement', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'Settled Co' },
    });
    const valuationId = created.json().valuation.id as string;
    const payment = await createPayment(ctx.pool, {
      valuationId,
      sessionId: 'cs_obs_settled',
      amountCents: 300_000,
      currency: 'USD',
      createdBy: ops.id,
    });

    const mark = lines.length;
    const completed = (eventId: string) => ({
      id: eventId,
      type: 'checkout.session.completed',
      created: Math.floor(Date.UTC(2026, 2, 5, 8, 0, 0) / 1000),
      data: {
        object: {
          id: 'cs_obs_settled',
          object: 'checkout.session',
          payment_status: 'paid',
          amount_total: 300_000,
          currency: 'usd',
        },
      },
    });
    expect((await deliver(completed('evt_obs_settled_1'))).statusCode).toBe(200);

    const line = lines.slice(mark).find((l) => String(l.msg).includes('checkout settled'));
    expect(line).toBeDefined();
    expect(line!.sessionId).toBe('cs_obs_settled');
    expect(line!.paymentId).toBe(payment.id);
    expect(line!.valuationId).toBe(valuationId);
    expect(line!.amountCents).toBe(300_000);
    expect(line!.resumed).toBe(false);
    expect(line!.stripeEventId).toBe('evt_obs_settled_1');

    // And once: the compare-and-set that owns the fulfilment is upstream of it,
    // so a delivery carrying a different event id is still one settlement.
    const again = lines.length;
    await deliver(completed('evt_obs_settled_2'));
    expect(lines.slice(again).filter((l) => String(l.msg).includes('checkout settled'))).toHaveLength(0);
  });

  it('does not alert for a chargeback we won', async () => {
    await settledPayment('Won Dispute Co', 'cs_obs_dispute_won', 'ch_obs_dispute_won');

    const mark = lines.length;
    expect(
      (
        await deliver({
          id: 'evt_obs_dispute_won',
          type: 'charge.dispute.closed',
          created: Math.floor(Date.UTC(2026, 2, 5, 12, 0, 0) / 1000),
          data: {
            object: {
              id: 'dp_obs_dispute_won',
              object: 'dispute',
              charge: 'ch_obs_dispute_won',
              status: 'won',
            },
          },
        })
      ).statusCode,
    ).toBe(200);

    expect(lines.slice(mark).find((l) => l.alert === true)).toBeUndefined();
    // Still recorded: a dispute won is the record that the money stayed.
    expect(lines.slice(mark).find((l) => String(l.msg).includes('in our favour'))).toBeDefined();
  });

  it('is reading a log stream at all', () => {
    expect(lines.length).toBeGreaterThan(0);
  });
});
