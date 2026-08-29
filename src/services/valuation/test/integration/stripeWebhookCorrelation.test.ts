/**
 * A Stripe webhook can be traced from the dashboard into these logs.
 *
 * `evt_…` is the identifier the other side of this integration is indexed by.
 * A delivery that reports "failed, will retry" in the Stripe dashboard is
 * looked up by it, and every redelivery of one event carries the same one. It
 * arrived on every request to both webhook endpoints and was logged on exactly
 * one line in the service — billing's "stale Stripe event ignored" — so the two
 * alerting lines about money taken and unreconciled, the 5xx-for-redelivery
 * line, and every receipt and fulfilment line named a session or a payment and
 * never the event. Nothing joined in either direction, and six lines about six
 * deliveries of one event read the same as six payments.
 *
 * Driven through `app.inject` against the real handler rather than by calling
 * a logger directly: the claim is about the wiring, and a unit test of a child
 * logger passes whether or not the route builds one.
 */

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { isDbAvailable, setupTestApp, type TestApp } from './helpers.js';

const WEBHOOK_SECRET = 'whsec_correlation_test';
const dbUp = await isDbAvailable();

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

describe.skipIf(!dbUp)('the Stripe event id on a webhook log line', () => {
  let ctx: TestApp;
  let lines: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // `setupTestApp` runs at 'silent', which would leave every assertion below
    // reading an empty array — the vacuity the third test's marker guards.
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

  const deliver = (url: string, event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({ method: 'POST', url, headers: signedHeaders(payload), payload });
  };

  /** Lines written since the marker, in order. */
  const since = (mark: number) => lines.slice(mark);

  it('names the event on the payments webhook, including on a redelivery', async () => {
    const event = {
      id: 'evt_corr_payments_1',
      type: 'checkout.session.expired',
      created: Math.floor(Date.UTC(2026, 0, 2, 10, 0, 0) / 1000),
      data: { object: { id: 'cs_corr_1', object: 'checkout.session' } },
    };
    const first = await deliver('/api/v1/stripe/webhook', event);
    expect(first.statusCode).toBe(200);

    // The redelivery is the case that had no line at all: Stripe records a 200
    // and this side recorded nothing, which is indistinguishable from the
    // endpoint never having been reached.
    const mark = lines.length;
    const again = await deliver('/api/v1/stripe/webhook', event);
    expect(again.json()).toMatchObject({ duplicate: true });

    const duplicate = since(mark).find((l) => String(l.msg).includes('duplicate delivery'));
    expect(duplicate).toBeDefined();
    expect(duplicate!.stripeEventId).toBe('evt_corr_payments_1');
    expect(duplicate!.stripeEventType).toBe('checkout.session.expired');
    // And the request id, so the line joins to the rest of that delivery.
    expect(duplicate!.requestId).toEqual(expect.any(String));
  });

  it('names the event on the billing webhook too', async () => {
    const event = {
      id: 'evt_corr_billing_1',
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.UTC(2026, 0, 2, 11, 0, 0) / 1000),
      data: { object: { id: 'sub_corr_1', object: 'subscription', metadata: {} } },
    };
    expect((await deliver('/api/v1/billing/webhook', event)).statusCode).toBe(200);

    const mark = lines.length;
    const again = await deliver('/api/v1/billing/webhook', event);
    expect(again.json()).toMatchObject({ duplicate: true });

    const duplicate = since(mark).find((l) => String(l.msg).includes('duplicate delivery'));
    expect(duplicate).toBeDefined();
    expect(duplicate!.stripeEventId).toBe('evt_corr_billing_1');
    expect(duplicate!.stripeEventType).toBe('customer.subscription.deleted');
  });

  it('carries the id on the alert raised when money has no payment row', async () => {
    // The line that matters most and had the least: a settled Checkout session
    // stamped with one of our valuation ids and no payment row behind it is
    // money taken that nobody can reconcile, and it named the session while the
    // thing Stripe would be searched by was the event.
    const mark = lines.length;
    const res = await deliver('/api/v1/stripe/webhook', {
      id: 'evt_corr_unreconciled_1',
      type: 'checkout.session.completed',
      created: Math.floor(Date.UTC(2026, 0, 2, 12, 0, 0) / 1000),
      data: {
        object: {
          id: 'cs_corr_unreconciled',
          object: 'checkout.session',
          payment_status: 'paid',
          amount_total: 250000,
          currency: 'usd',
          client_reference_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
        },
      },
    });
    expect(res.json()).toMatchObject({ unreconciled: expect.any(String) });

    const alert = since(mark).find((l) => l.alert === true);
    expect(alert).toBeDefined();
    expect(alert!.stripeEventId).toBe('evt_corr_unreconciled_1');
    expect(alert!.sessionId).toBe('cs_corr_unreconciled');
  });
});
