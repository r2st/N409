import crypto from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPayment,
  findPaymentBySessionId,
  markPayment,
  recordRefund,
} from '../../src/repos/payments.js';
import { priceForKind } from '../../src/routes/payments.js';
import {
  EXPRESS_DELIVERY_CENTS,
  EXPRESS_DELIVERY_DAYS,
  QSBS_LETTER_CENTS,
  STANDARD_DELIVERY_DAYS,
} from '../../src/domain/pricing.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Payment UI backend (P0 #2 phase A): the quote endpoint and the signed
 * webhook lifecycle — completed flips payment + valuation idempotently,
 * expired/failed only downgrade pending rows.
 */

const WEBHOOK_SECRET = 'whsec_integration_test';

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('payments quote + webhook', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  let client: { id: string; email: string; token: string };

  const createValuation = async (companyName: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  beforeAll(async () => {
    // Webhook secret set, Stripe secret key NOT set: signature verification is
    // exercised for real; the receipt lookup is skipped (no outbound call).
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  describe('quote', () => {
    it('returns the list price, currency, and configured flag', async () => {
      const vid = await createValuation('Quote Co');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/quote`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const quote = res.json().quote;
      // A valuation with no raise recorded is quoted at the entry band, so the
      // total is still the bare list price.
      expect(quote).toMatchObject({
        kind: '409a',
        base_cents: priceForKind('409a'),
        amount_cents: priceForKind('409a'),
        band_uplift_cents: 0,
        addons: [],
        unavailable_addons: [],
        delivery_days: STANDARD_DELIVERY_DAYS,
        currency: 'USD',
        configured: false, // STRIPE_SECRET_KEY unset in this app
      });
      expect(quote.band.key).toBe('under_1m');
      expect(quote.lines).toEqual([
        { key: 'base', label: '409A valuation', amount_cents: priceForKind('409a') },
      ]);
    });

    it('re-quotes add-ons from query flags, itemised, without creating anything', async () => {
      const vid = await createValuation('Quote Addon Co');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/quote?express=true&qsbs_letter=1`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const quote = res.json().quote;
      expect(quote.amount_cents).toBe(priceForKind('409a') + EXPRESS_DELIVERY_CENTS + QSBS_LETTER_CENTS);
      expect(quote.delivery_days).toBe(EXPRESS_DELIVERY_DAYS);
      expect(quote.addons.map((a: { key: string }) => a.key)).toEqual(['express', 'qsbs_letter']);
      // The breakdown adds up to the total it is a breakdown of.
      expect(quote.lines.reduce((s: number, l: { amount_cents: number }) => s + l.amount_cents, 0)).toBe(
        quote.amount_cents,
      );
      // Quoting is read-only.
      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments`,
        headers: authHeader(ops.token),
      });
      expect(list.json().payments).toEqual([]);
    });

    it('is valuation-scoped: out-of-scope client sees 404', async () => {
      const vid = await createValuation('Quote Scope Co');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/quote`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('receipt pdf', () => {
    /** Readable text of a rendered PDF — inflate the streams, decode the hex runs. */
    function readable(pdf: Buffer): string {
      const raw = pdf.toString('latin1');
      let all = raw;
      for (const m of raw.matchAll(/stream\r?\n/g)) {
        const start = m.index + m[0].length;
        const end = pdf.indexOf(Buffer.from('endstream'), start);
        if (end < 0) continue;
        try {
          all += inflateSync(pdf.subarray(start, end)).toString('latin1');
        } catch {
          // Not a deflate stream — nothing to read.
        }
      }
      return Array.from(all.matchAll(/<([0-9a-fA-F]+)>/g))
        .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
        .join('');
    }

    const settledPayment = async (company: string, sessionId: string) => {
      const vid = await createValuation(company);
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId,
        amountCents: 219_000,
        currency: 'USD',
        createdBy: ops.id,
        express: true,
        priceBreakdown: [
          { key: 'base', label: '409A valuation', amount_cents: 119_000 },
          { key: 'band', label: '$1M – $5M raised', amount_cents: 50_000 },
          { key: 'express', label: 'Express delivery — 1 business day', amount_cents: 50_000 },
        ],
      });
      await markPayment(ctx.pool, payment.id, 'succeeded');
      return { vid, payment };
    };

    it('itemises what was sold, not just the total', async () => {
      const { vid, payment } = await settledPayment('Receipt Co', 'cs_test_receipt_1');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

      // The breakdown stored at checkout is what the client reads back — the
      // reason migration 0108 persisted it rather than recomputing.
      const text = readable(res.rawPayload);
      expect(text).toContain('409A valuation');
      expect(text).toContain('Express delivery');
      expect(text).toContain('$1,190.00');
      expect(text).toContain('$2,190.00');
    });

    it('states a refund on the receipt rather than the gross', async () => {
      const { vid, payment } = await settledPayment('Receipt Refund Co', 'cs_test_receipt_2');
      await recordRefund(ctx.pool, payment.id, { refundedCents: 50_000, fullyRefunded: false });
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const text = readable(res.rawPayload);
      expect(text).toContain('Refunded');
      expect(text).toContain('$1,690.00');
    });

    it('refuses a receipt for a payment that has not settled', async () => {
      const vid = await createValuation('Receipt Pending Co');
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_test_receipt_3',
        amountCents: 119_000,
        currency: 'USD',
        createdBy: ops.id,
      });
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      // A document headed "Receipt" for an unpaid checkout is how a client
      // comes to believe they have paid.
      expect(res.statusCode).toBe(409);
    });

    it('404s a payment belonging to another valuation', async () => {
      const { payment } = await settledPayment('Receipt Scope A', 'cs_test_receipt_4');
      const other = await createValuation('Receipt Scope B');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${other}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('is valuation-scoped: out-of-scope client sees 404', async () => {
      const { vid, payment } = await settledPayment('Receipt Scope Co', 'cs_test_receipt_5');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('webhook', () => {
    it('marks the payment succeeded and flips the valuation paid, idempotently', async () => {
      const vid = await createValuation('Webhook Co');
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_test_success_1',
        amountCents: priceForKind('409a'),
        currency: 'USD',
        createdBy: ops.id,
      });
      expect(payment.status).toBe('pending');

      const event = JSON.stringify({
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_success_1',
            payment_intent: 'pi_test_1',
            amount_total: 119_000,
          },
        },
      });
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(event),
        payload: event,
      });
      expect(first.statusCode).toBe(200);

      const marked = await findPaymentBySessionId(ctx.pool, 'cs_test_success_1');
      expect(marked?.status).toBe('succeeded');
      expect(marked?.payment_intent_id).toBe('pi_test_1');
      // No STRIPE_SECRET_KEY → receipt lookup skipped, columns stay null.
      expect(marked?.receipt_url).toBeNull();
      expect(marked?.charge_id).toBeNull();

      const valuation = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}`,
        headers: authHeader(ops.token),
      });
      expect(valuation.json().valuation.paid_status).toBe('paid');

      // Replay must not double-apply (regression guard for webhook retries).
      const replay = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(event),
        payload: event,
      });
      expect(replay.statusCode).toBe(200);
      const after = await findPaymentBySessionId(ctx.pool, 'cs_test_success_1');
      expect(after?.status).toBe('succeeded');
      expect(after?.updated_at).toEqual(marked?.updated_at);
    });

    it('expires pending sessions but never downgrades a succeeded payment', async () => {
      const vid = await createValuation('Expire Co');
      await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_test_expire_1',
        amountCents: priceForKind('409a'),
        currency: 'USD',
        createdBy: ops.id,
      });

      const expire = (sessionId: string) =>
        JSON.stringify({ type: 'checkout.session.expired', data: { object: { id: sessionId } } });

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(expire('cs_test_expire_1')),
        payload: expire('cs_test_expire_1'),
      });
      expect(res.statusCode).toBe(200);
      expect((await findPaymentBySessionId(ctx.pool, 'cs_test_expire_1'))?.status).toBe('expired');

      // A late "expired" for the already-succeeded session is a no-op.
      const late = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers: signedHeaders(expire('cs_test_success_1')),
        payload: expire('cs_test_success_1'),
      });
      expect(late.statusCode).toBe(200);
      expect((await findPaymentBySessionId(ctx.pool, 'cs_test_success_1'))?.status).toBe('succeeded');
    });

    /**
     * Delayed-notification methods (ACH, SEPA, Bacs, boleto, OXXO, Konbini)
     * complete the Checkout Session before any money moves: `completed` arrives
     * with `payment_status: 'unpaid'` and the debit settles days later.
     *
     * Fulfilling on `completed` alone gave the valuation away. The row went
     * `succeeded` on the click-through, so when the debit bounced,
     * `async_payment_failed` found it no longer `pending` and its guard
     * declined to act — the client kept a published 409A and paid nothing.
     */
    describe('delayed-notification payment methods', () => {
      const completed = (sessionId: string, paymentStatus?: string) =>
        JSON.stringify({
          type: 'checkout.session.completed',
          data: {
            object: {
              id: sessionId,
              payment_intent: `pi_for_${sessionId}`,
              amount_total: 119_000,
              ...(paymentStatus ? { payment_status: paymentStatus } : {}),
            },
          },
        });

      const asyncEvent = (type: string, sessionId: string) =>
        JSON.stringify({
          type,
          data: { object: { id: sessionId, payment_intent: `pi_for_${sessionId}`, amount_total: 119_000 } },
        });

      const post = (body: string) =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/stripe/webhook',
          headers: signedHeaders(body),
          payload: body,
        });

      const paidStatus = async (vid: string): Promise<string> => {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${vid}`,
          headers: authHeader(ops.token),
        });
        return res.json().valuation.paid_status as string;
      };

      const seed = async (name: string, sessionId: string): Promise<string> => {
        const vid = await createValuation(name);
        await createPayment(ctx.pool, {
          valuationId: vid,
          sessionId,
          amountCents: priceForKind('409a'),
          currency: 'USD',
          createdBy: ops.id,
        });
        return vid;
      };

      it('does not release the valuation while the session reports itself unpaid', async () => {
        const vid = await seed('ACH Pending Co', 'cs_test_ach_pending');

        expect((await post(completed('cs_test_ach_pending', 'unpaid'))).statusCode).toBe(200);

        expect((await findPaymentBySessionId(ctx.pool, 'cs_test_ach_pending'))?.status).toBe('pending');
        expect(await paidStatus(vid)).toBe('unpaid');
      });

      it('releases it when the delayed debit settles', async () => {
        const vid = await seed('ACH Settles Co', 'cs_test_ach_ok');

        await post(completed('cs_test_ach_ok', 'unpaid'));
        expect(await paidStatus(vid)).toBe('unpaid');

        expect(
          (await post(asyncEvent('checkout.session.async_payment_succeeded', 'cs_test_ach_ok'))).statusCode,
        ).toBe(200);

        const settled = await findPaymentBySessionId(ctx.pool, 'cs_test_ach_ok');
        expect(settled?.status).toBe('succeeded');
        expect(settled?.payment_intent_id).toBe('pi_for_cs_test_ach_ok');
        expect(await paidStatus(vid)).toBe('paid');
      });

      it('marks the payment failed — and leaves the valuation unpaid — when the debit bounces', async () => {
        const vid = await seed('ACH Bounces Co', 'cs_test_ach_fail');

        await post(completed('cs_test_ach_fail', 'unpaid'));
        expect(
          (await post(asyncEvent('checkout.session.async_payment_failed', 'cs_test_ach_fail'))).statusCode,
        ).toBe(200);

        expect((await findPaymentBySessionId(ctx.pool, 'cs_test_ach_fail'))?.status).toBe('failed');
        // The regression this whole block exists for: before the fix the
        // valuation was already 'paid' by this point and stayed that way.
        expect(await paidStatus(vid)).toBe('unpaid');
      });

      it('an async success is idempotent across Stripe redeliveries', async () => {
        const vid = await seed('ACH Replay Co', 'cs_test_ach_replay');
        await post(completed('cs_test_ach_replay', 'unpaid'));
        await post(asyncEvent('checkout.session.async_payment_succeeded', 'cs_test_ach_replay'));
        const first = await findPaymentBySessionId(ctx.pool, 'cs_test_ach_replay');

        await post(asyncEvent('checkout.session.async_payment_succeeded', 'cs_test_ach_replay'));

        const after = await findPaymentBySessionId(ctx.pool, 'cs_test_ach_replay');
        expect(after?.status).toBe('succeeded');
        expect(after?.updated_at).toEqual(first?.updated_at);
        expect(await paidStatus(vid)).toBe('paid');
      });

      it('a late async failure never downgrades a settled payment', async () => {
        const vid = await seed('ACH Late Co', 'cs_test_ach_late');
        await post(completed('cs_test_ach_late', 'paid'));
        expect(await paidStatus(vid)).toBe('paid');

        await post(asyncEvent('checkout.session.async_payment_failed', 'cs_test_ach_late'));

        expect((await findPaymentBySessionId(ctx.pool, 'cs_test_ach_late'))?.status).toBe('succeeded');
        expect(await paidStatus(vid)).toBe('paid');
      });

      it('a card session still settles immediately on completed', async () => {
        const vid = await seed('Card Co', 'cs_test_card');

        await post(completed('cs_test_card', 'paid'));

        expect((await findPaymentBySessionId(ctx.pool, 'cs_test_card'))?.status).toBe('succeeded');
        expect(await paidStatus(vid)).toBe('paid');
      });

      it('a fully-discounted session needs no payment and settles too', async () => {
        const vid = await seed('Comped Co', 'cs_test_comped');

        await post(completed('cs_test_comped', 'no_payment_required'));

        expect((await findPaymentBySessionId(ctx.pool, 'cs_test_comped'))?.status).toBe('succeeded');
        expect(await paidStatus(vid)).toBe('paid');
      });
    });

    it('rejects a tampered signature', async () => {
      const event = JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_success_1' } },
      });
      const headers = signedHeaders(event);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stripe/webhook',
        headers,
        payload: event.replace('cs_test', 'cs_evil'),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

/**
 * A deployment holding a Stripe *test* key.
 *
 * This is not a hypothetical configuration — it is the state every deployment
 * passes through on its way to taking money, and the state this one is in
 * today. The danger is that a test key is fully functional: it opens a real
 * Checkout Session at a real Stripe URL, and that page accepts `4242…` while
 * declining every card a client owns. Neither side is told why. So the rule
 * the routes enforce is that a test key is configured for ops and unconfigured
 * for everyone else, and these tests are about the two halves agreeing —
 * a quote that offers a button the checkout would refuse is the actual bug.
 */
describe.skipIf(!dbUp)('payments with a Stripe test key', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  let client: { id: string; email: string; token: string };
  let clientValuation: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_test_integration' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'Test Mode Co' },
    });
    expect(res.statusCode).toBe(201);
    clientValuation = res.json().valuation.id as string;
  });
  afterAll(async () => ctx?.teardown());

  const quoteFor = async (token: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${clientValuation}/payments/quote`,
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().quote;
  };

  it('tells the client the same thing an unconfigured deployment does', async () => {
    const quote = await quoteFor(client.token);
    expect(quote.configured).toBe(false);
    // And nothing about which Stripe account we hold — that is internal detail
    // on a screen the client is trying to pay from.
    expect(quote.test_mode).toBeUndefined();
  });

  it('refuses the client a checkout rather than opening one their card will fail', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${clientValuation}/payments/checkout`,
      headers: authHeader(client.token),
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    // Same problem type as an unset key: to the client it is the same
    // situation, and the pay panel already renders that one sentence.
    expect(res.json().type).toBe('urn:n409:problem:payments-unconfigured');
  });

  it('leaves the checkout open to ops, and says why they should care', async () => {
    const quote = await quoteFor(ops.token);
    expect(quote.configured).toBe(true);
    expect(quote.test_mode).toBe(true);
  });

  it('still quotes the same price to both — only the button differs', async () => {
    // The mode gates who may pay, never what they would have paid. A price
    // that moved with the key would make every test-mode rehearsal worthless.
    const [asClient, asOps] = await Promise.all([quoteFor(client.token), quoteFor(ops.token)]);
    expect(asClient.amount_cents).toBe(asOps.amount_cents);
    expect(asClient.lines).toEqual(asOps.lines);
  });

  it('withholds subscription checkout from a client too', async () => {
    // The worse of the two flows to get wrong: a one-off is a failed payment,
    // a subscription is one that silently never starts.
    const plans = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: authHeader(client.token),
    });
    expect(plans.json().configured).toBe(false);

    const sub = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscribe',
      headers: authHeader(client.token),
      payload: { plan_tier: 'annual_retainer' },
    });
    expect(sub.statusCode).toBe(503);
  });
});
