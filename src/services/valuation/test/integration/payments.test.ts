import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayment, findPaymentBySessionId } from '../../src/repos/payments.js';
import { priceForKind } from '../../src/routes/payments.js';
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
      expect(res.json().quote).toEqual({
        amount_cents: priceForKind('409a'),
        currency: 'USD',
        kind: '409a',
        configured: false, // STRIPE_SECRET_KEY unset in this app
      });
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

        expect((await post(asyncEvent('checkout.session.async_payment_succeeded', 'cs_test_ach_ok'))).statusCode).toBe(
          200,
        );

        const settled = await findPaymentBySessionId(ctx.pool, 'cs_test_ach_ok');
        expect(settled?.status).toBe('succeeded');
        expect(settled?.payment_intent_id).toBe('pi_for_cs_test_ach_ok');
        expect(await paidStatus(vid)).toBe('paid');
      });

      it('marks the payment failed — and leaves the valuation unpaid — when the debit bounces', async () => {
        const vid = await seed('ACH Bounces Co', 'cs_test_ach_fail');

        await post(completed('cs_test_ach_fail', 'unpaid'));
        expect((await post(asyncEvent('checkout.session.async_payment_failed', 'cs_test_ach_fail'))).statusCode).toBe(
          200,
        );

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
