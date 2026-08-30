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
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

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
   * The marker the four above are vacuous without: `setupTestApp` defaults to
   * 'silent', and a `lines` array that never fills reads as every "stayed
   * quiet" assertion passing.
   */
  it('is reading a log stream at all', () => {
    expect(lines.length).toBeGreaterThan(0);
  });
});
