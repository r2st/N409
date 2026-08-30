import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPayment,
  findPaymentBySessionId,
  markPayment,
  recordDispute,
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
// The receipt is drawn with the same embedded Unicode face as the 409A
// deliverable, so its text only comes back through the face's /ToUnicode CMap.
// A local decoder here read glyph indices as Latin-1 and failed on text the
// receipt does say; there is one reader for this service now.
import { readable } from './support/pdfText.js';

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

    it('dates the receipt when the money arrived, not when the row last moved', async () => {
      /*
       * `payments` had no settlement timestamp, so this document printed
       * "Paid" from `updated_at` — the row's mtime, which `recordRefund`,
       * `recordDispute` and the late receipt-URL resolution all move. A refund
       * six weeks on therefore redated the one document a client keeps to say
       * when they paid us, to the day the money went back. Migration 0195 added
       * `settled_at`; `markPayment` stamps it once.
       */
      const { vid, payment } = await settledPayment('Receipt Dated Co', 'cs_test_receipt_dated');
      // Both columns back-dated together, which is the state a payment settled
      // in June and refunded today is actually in.
      await ctx.pool.query(`UPDATE payments SET settled_at = $2, updated_at = $2 WHERE id = $1`, [
        payment.id,
        '2026-06-01T09:30:00Z',
      ]);
      await recordRefund(ctx.pool, payment.id, { refundedCents: 50_000, fullyRefunded: false });

      const moved = await ctx.pool.query<{ settled: Date; updated: Date }>(
        'SELECT settled_at AS settled, updated_at AS updated FROM payments WHERE id = $1',
        [payment.id],
      );
      // The premise: the refund moved one of them and not the other.
      expect(moved.rows[0]!.settled.toISOString().slice(0, 10)).toBe('2026-06-01');
      expect(moved.rows[0]!.updated.toISOString().slice(0, 10)).not.toBe('2026-06-01');

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const text = readable(res.rawPayload);
      expect(text).toContain('2026-06-01');
      expect(text).not.toContain(moved.rows[0]!.updated.toISOString().slice(0, 10));
    });

    it('stamps the settlement once, so a redelivered webhook cannot re-date it', async () => {
      const { payment } = await settledPayment('Receipt Replay Co', 'cs_test_receipt_replay');
      await ctx.pool.query(`UPDATE payments SET settled_at = $2 WHERE id = $1`, [
        payment.id,
        '2026-06-01T09:30:00Z',
      ]);
      // Stripe retries a settlement for three days, and an operator can resend
      // one by hand at any point.
      await markPayment(ctx.pool, payment.id, 'succeeded');
      const { rows } = await ctx.pool.query<{ settled: Date }>(
        'SELECT settled_at AS settled FROM payments WHERE id = $1',
        [payment.id],
      );
      expect(rows[0]!.settled.toISOString()).toBe('2026-06-01T09:30:00.000Z');
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

    it('issues a receipt for a payment that was refunded in full', async () => {
      /*
       * `status === 'succeeded'` is the answer to "is this row still holding
       * money", and the guard asked it where "did this client ever pay us" was
       * the question. A full refund and a lost chargeback both move the row to
       * 'refunded', so the receipt's own refund branch — written to state what
       * was returned and what is left — was reachable only for the *partial*
       * case, which leaves the row 'succeeded'. The client whose money all came
       * back was left with Stripe's receipt for the gross.
       */
      const { vid, payment } = await settledPayment('Receipt Full Refund Co', 'cs_test_receipt_full');
      await recordRefund(ctx.pool, payment.id, { refundedCents: 219_000, fullyRefunded: true });
      const { rows } = await ctx.pool.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [
        payment.id,
      ]);
      expect(rows[0]!.status).toBe('refunded');

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const text = readable(res.rawPayload);
      expect(text).toContain('Refunded');
      // Gross, what came back, and nothing left.
      expect(text).toContain('$2,190.00');
      expect(text).toContain('$0.00');
      // And the document must not head itself "paid" over money that has gone.
      expect(text).toContain('refunded');
    });

    it('refuses a receipt for a payment that failed or expired', async () => {
      // The other half of the guard: 'settled' widened to include 'refunded'
      // and must not have widened to everything that is not pending.
      const vid = await createValuation('Receipt Expired Co');
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_test_receipt_expired',
        amountCents: 119_000,
        currency: 'USD',
        createdBy: ops.id,
      });
      await markPayment(ctx.pool, payment.id, 'expired');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
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

    it('404s a payment id that is not an id', async () => {
      // 404 rather than a 500 from the `ulid` domain rejecting the comparison,
      // and rather than a 422 that would tell a caller the id was merely the
      // wrong shape for a receipt that may not be theirs.
      const vid = await createValuation('Receipt Bad Id Co');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/not-a-payment-id/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('says a disputed payment is disputed rather than heading it paid', async () => {
      const { vid, payment } = await settledPayment('Receipt Dispute Co', 'cs_test_receipt_6');
      await recordDispute(ctx.pool, payment.id, 'open');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const text = readable(res.rawPayload);
      // The money is held, not returned — so the document must not read like a
      // refund and must not quietly still read "paid".
      expect(text).toContain('disputed');
      expect(text).not.toContain('Refunded');
    });

    it('does not head a receipt disputed for a chargeback we won', async () => {
      /*
       * `dispute_status` is never cleared, so 'won' is permanent — and the
       * heading read it as "there is a dispute" rather than "there was one and
       * we kept the money". The client's own copy of a payment they made, and
       * we retained, said it was disputed for ever. `warning_closed` — an
       * early-warning enquiry that never became a chargeback at all — records
       * 'won' too, so it carried the same brand.
       */
      const { vid, payment } = await settledPayment('Receipt Won Co', 'cs_test_receipt_won');
      await recordDispute(ctx.pool, payment.id, 'won');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const text = readable(res.rawPayload);
      // The case is still stated — it happened — but in the tense it happened
      // in, and the payment is headed as what it is.
      expect(text).toContain('resolved in our favour');
      expect(text).toContain('paid');
      expect(text).not.toContain('disputed');
    });

    it('renders a payment taken before add-ons were itemised', async () => {
      // `price_breakdown` is null on every row written before migration 0108.
      // With no lines to print, the receipt states the engagement and the total
      // rather than an empty table under a "Description" heading.
      const vid = await createValuation('Legacy Receipt Co');
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_test_receipt_7',
        amountCents: 119_000,
        currency: 'USD',
        createdBy: ops.id,
      });
      await markPayment(ctx.pool, payment.id, 'succeeded');
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const text = readable(res.rawPayload);
      expect(text).toContain('Valuation engagement');
      expect(text).toContain('$1,190.00');
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
