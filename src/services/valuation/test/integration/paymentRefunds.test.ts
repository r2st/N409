import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { createPayment, findPaymentBySessionId, markPayment } from '../../src/repos/payments.js';
import { findInvoiceByStripeId } from '../../src/repos/billing.js';
import { priceForKind } from '../../src/routes/payments.js';
import { listNotifications } from '../../src/repos/notifications.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Money going back out: `charge.refunded` and the dispute pair.
 *
 * Before these were handled the webhook answered `{ignored: 'charge.refunded'}`
 * and everything downstream still said the engagement was paid — the payments
 * row, `valuations.paid_status`, and the account billing totals — with no
 * notification anywhere. A client could pay, receive the 409A, charge it back,
 * and remain a paying customer in our own records.
 */

const WEBHOOK_SECRET = 'whsec_refund_test';
const PRICE = priceForKind('409a');

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('refunds and chargebacks', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  let client: { id: string; email: string; token: string };

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

  /** A valuation owned by `client`, paid for through the normal webhook path. */
  const seedPaid = async (
    name: string,
    key: string,
  ): Promise<{ vid: string; sessionId: string; chargeId: string; intentId: string }> => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    const vid = created.json().valuation.id as string;

    const sessionId = `cs_${key}`;
    const intentId = `pi_${key}`;
    const chargeId = `ch_${key}`;
    await createPayment(ctx.pool, {
      valuationId: vid,
      sessionId,
      amountCents: PRICE,
      currency: 'USD',
      createdBy: ops.id,
    });
    const completed = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: { id: sessionId, payment_intent: intentId, payment_status: 'paid', amount_total: PRICE },
      },
    });
    expect((await post(completed)).statusCode).toBe(200);
    expect(await paidStatus(vid)).toBe('paid');

    // Stripe's charge id normally arrives with the receipt lookup, which is
    // skipped here (no STRIPE_SECRET_KEY). Set it so the charge-keyed lookup
    // path is the one under test rather than the intent fallback.
    await ctx.pool.query('UPDATE payments SET charge_id = $1 WHERE session_id = $2', [chargeId, sessionId]);
    return { vid, sessionId, chargeId, intentId };
  };

  const refundEvent = (charge: Record<string, unknown>) =>
    JSON.stringify({ type: 'charge.refunded', data: { object: charge } });

  const disputeEvent = (type: string, dispute: Record<string, unknown>) =>
    JSON.stringify({ type: `charge.dispute.${type}`, data: { object: dispute } });

  /**
   * Notifications of one type for one user about one valuation. Scoped to the
   * valuation because the users are shared across this file's tests, and an
   * unscoped count would pass on the sum of everything that came before.
   */
  const notificationsFor = async (userId: string, type: string, valuationId: string) =>
    (await listNotifications(ctx.pool, userId, { limit: 200 })).filter(
      (n) => n.type === type && n.valuation_id === valuationId,
    );

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  describe('charge.refunded', () => {
    it('a full refund revokes the paid status and tells the owner and ops', async () => {
      const { vid, sessionId, chargeId, intentId } = await seedPaid('Refund Co', 'refund_full');

      const res = await post(
        refundEvent({ id: chargeId, payment_intent: intentId, amount: PRICE, amount_refunded: PRICE }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ received: true, refunded: true });

      const payment = await findPaymentBySessionId(ctx.pool, sessionId);
      expect(payment?.status).toBe('refunded');
      expect(Number(payment?.refunded_cents)).toBe(PRICE);
      expect(payment?.refunded_at).not.toBeNull();

      // The regression this exists for: the engagement used to stay 'paid'.
      expect(await paidStatus(vid)).toBe('unpaid');

      expect(await notificationsFor(client.id, 'payment_reversed', vid)).toHaveLength(1);
      expect(await notificationsFor(ops.id, 'payment_reversed', vid)).toHaveLength(1);
    });

    it('writes the reversal into the valuation audit trail as Stripe, not a person', async () => {
      const { vid, chargeId, intentId } = await seedPaid('Audited Refund Co', 'refund_audit');
      await post(
        refundEvent({ id: chargeId, payment_intent: intentId, amount: PRICE, amount_refunded: PRICE }),
      );

      const { rows } = await ctx.pool.query<{ actor_type: string; source: string; payload: unknown }>(
        `SELECT actor_type, source, payload FROM valuation_events
          WHERE valuation_id = $1 AND type = 'valuation_updated'
          ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
        [vid],
      );
      expect(rows[0]?.actor_type).toBe('system');
      expect(rows[0]?.source).toBe('stripe');
      expect(rows[0]?.payload).toMatchObject({ changes: { paid_status: { from: 'paid', to: 'unpaid' } } });
    });

    it('a partial refund is recorded but leaves the engagement paid', async () => {
      const { vid, sessionId, chargeId, intentId } = await seedPaid('Partial Co', 'refund_partial');

      const res = await post(
        refundEvent({ id: chargeId, payment_intent: intentId, amount: PRICE, amount_refunded: 20_000 }),
      );
      expect(res.json()).toMatchObject({ refunded: false });

      const payment = await findPaymentBySessionId(ctx.pool, sessionId);
      expect(payment?.status).toBe('succeeded');
      expect(Number(payment?.refunded_cents)).toBe(20_000);
      expect(await paidStatus(vid)).toBe('paid');
      expect(await notificationsFor(client.id, 'payment_partially_refunded', vid)).toHaveLength(1);
    });

    it('a redelivered refund is idempotent — one revocation, one alert', async () => {
      const { vid, chargeId, intentId } = await seedPaid('Replay Refund Co', 'refund_replay');
      const event = refundEvent({
        id: chargeId,
        payment_intent: intentId,
        amount: PRICE,
        amount_refunded: PRICE,
      });

      expect((await post(event)).statusCode).toBe(200);
      expect((await post(event)).statusCode).toBe(200);

      expect(await paidStatus(vid)).toBe('unpaid');
      // The second delivery finds paid_status already 'unpaid' and patches
      // nothing, so it must not raise a second alert on the same valuation.
      expect(await notificationsFor(client.id, 'payment_reversed', vid)).toHaveLength(1);
    });

    it('resolves the payment by intent when no charge id was ever stored', async () => {
      const { vid, sessionId, intentId } = await seedPaid('Intent Only Co', 'refund_intent');
      await ctx.pool.query('UPDATE payments SET charge_id = NULL WHERE session_id = $1', [sessionId]);

      await post(
        refundEvent({ id: 'ch_unknown', payment_intent: intentId, amount: PRICE, amount_refunded: PRICE }),
      );

      expect((await findPaymentBySessionId(ctx.pool, sessionId))?.status).toBe('refunded');
      expect(await paidStatus(vid)).toBe('unpaid');
    });

    it('acknowledges a refund for a charge we never recorded without failing', async () => {
      const res = await post(
        refundEvent({ id: 'ch_nobody', payment_intent: 'pi_nobody', amount: 500, amount_refunded: 500 }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ignored: 'unknown charge' });
    });
  });

  describe('charge.dispute', () => {
    it('an opened dispute alerts ops but does not pull the report', async () => {
      const { vid, sessionId, chargeId, intentId } = await seedPaid('Dispute Open Co', 'dispute_open');

      const res = await post(
        disputeEvent('created', {
          id: 'dp_1',
          charge: chargeId,
          payment_intent: intentId,
          status: 'needs_response',
          amount: PRICE,
        }),
      );
      expect(res.json()).toMatchObject({ dispute_status: 'open' });

      const payment = await findPaymentBySessionId(ctx.pool, sessionId);
      expect(payment?.dispute_status).toBe('open');
      expect(payment?.disputed_at).not.toBeNull();
      // Still ours until the case is decided.
      expect(payment?.status).toBe('succeeded');
      expect(Number(payment?.refunded_cents)).toBe(0);
      expect(await paidStatus(vid)).toBe('paid');

      expect(await notificationsFor(ops.id, 'payment_disputed', vid)).toHaveLength(1);
      // The client raised it; telling them about it would read as an accusation.
      expect(await notificationsFor(client.id, 'payment_disputed', vid)).toHaveLength(0);
    });

    it('a lost dispute revokes exactly like a full refund', async () => {
      const { vid, sessionId, chargeId, intentId } = await seedPaid('Dispute Lost Co', 'dispute_lost');
      await post(
        disputeEvent('created', {
          id: 'dp_2',
          charge: chargeId,
          payment_intent: intentId,
          status: 'needs_response',
        }),
      );

      const res = await post(
        disputeEvent('closed', { id: 'dp_2', charge: chargeId, payment_intent: intentId, status: 'lost' }),
      );
      expect(res.json()).toMatchObject({ dispute_status: 'lost' });

      const payment = await findPaymentBySessionId(ctx.pool, sessionId);
      expect(payment?.status).toBe('refunded');
      expect(payment?.dispute_status).toBe('lost');
      expect(Number(payment?.refunded_cents)).toBe(PRICE);
      expect(await paidStatus(vid)).toBe('unpaid');
      expect(await notificationsFor(client.id, 'payment_reversed', vid)).toHaveLength(1);
    });

    it('a won dispute leaves the money and the engagement alone', async () => {
      const { vid, sessionId, chargeId, intentId } = await seedPaid('Dispute Won Co', 'dispute_won');
      await post(
        disputeEvent('created', {
          id: 'dp_3',
          charge: chargeId,
          payment_intent: intentId,
          status: 'under_review',
        }),
      );

      await post(
        disputeEvent('closed', { id: 'dp_3', charge: chargeId, payment_intent: intentId, status: 'won' }),
      );

      const payment = await findPaymentBySessionId(ctx.pool, sessionId);
      expect(payment?.status).toBe('succeeded');
      expect(payment?.dispute_status).toBe('won');
      expect(Number(payment?.refunded_cents)).toBe(0);
      expect(await paidStatus(vid)).toBe('paid');
    });
  });

  describe('billing totals', () => {
    it('report what was kept, not what was charged', async () => {
      // A fresh owner so the rollup covers only this test's payments.
      const owner = await seedUser(ctx, { roles: ['valuation_user'] });
      const mk = async (name: string, key: string): Promise<string> => {
        const created = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(owner.token),
          payload: { kind: '409a', company_name: name },
        });
        const vid = created.json().valuation.id as string;
        await createPayment(ctx.pool, {
          valuationId: vid,
          sessionId: `cs_${key}`,
          amountCents: PRICE,
          currency: 'USD',
          createdBy: ops.id,
        });
        await post(
          JSON.stringify({
            type: 'checkout.session.completed',
            data: {
              object: {
                id: `cs_${key}`,
                payment_intent: `pi_${key}`,
                payment_status: 'paid',
                amount_total: PRICE,
              },
            },
          }),
        );
        await ctx.pool.query('UPDATE payments SET charge_id = $1 WHERE session_id = $2', [
          `ch_${key}`,
          `cs_${key}`,
        ]);
        return vid;
      };

      await mk('Totals Kept Co', 'totals_kept');
      await mk('Totals Back Co', 'totals_back');
      await mk('Totals Partial Co', 'totals_partial');

      await post(
        refundEvent({
          id: 'ch_totals_back',
          payment_intent: 'pi_totals_back',
          amount: PRICE,
          amount_refunded: PRICE,
        }),
      );
      await post(
        refundEvent({
          id: 'ch_totals_partial',
          payment_intent: 'pi_totals_partial',
          amount: PRICE,
          amount_refunded: 19_000,
        }),
      );

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/billing',
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().billing.totals).toEqual({
        gross_cents: PRICE * 3,
        refunded_cents: PRICE + 19_000,
        paid_cents: PRICE * 3 - PRICE - 19_000,
        succeeded_count: 2,
        refunded_count: 1,
        payment_count: 3,
      });

      // The refunded engagement is billable again, so it belongs in the
      // pay-now list the same page renders.
      const unpaid = res.json().billing.unpaid_valuations as Array<{ company_name: string }>;
      expect(unpaid.map((u) => u.company_name)).toContain('Totals Back Co');
    });
  });

  /**
   * A settlement event redelivered *after* the money went back out.
   *
   * Stripe retries a `checkout.session.completed` for up to three days and an
   * operator can resend one from the dashboard at any time, so a replay landing
   * after a refund or a chargeback is ordinary rather than exotic. Fulfilment
   * decided whether the event was news by reading `status === 'succeeded'` — and
   * both reversals move the row to 'refunded', which is not that. So the replay
   * marked the payment succeeded again and put the engagement back to paid: a
   * client with every cent returned, holding a published 409A, counted as a
   * paying customer.
   */
  describe('a settlement event replayed after the money came back', () => {
    const completedEvent = (sessionId: string, intentId: string) =>
      JSON.stringify({
        type: 'checkout.session.completed',
        data: {
          object: { id: sessionId, payment_intent: intentId, payment_status: 'paid', amount_total: PRICE },
        },
      });

    it('does not un-refund a fully refunded payment', async () => {
      const { vid, sessionId, chargeId, intentId } = await seedPaid(
        'Post-Refund Replay Co',
        'post_refund_replay',
      );
      expect((await post(refundEvent({ id: chargeId, amount_refunded: PRICE }))).statusCode).toBe(200);
      expect(await paidStatus(vid)).toBe('unpaid');

      expect((await post(completedEvent(sessionId, intentId))).statusCode).toBe(200);

      const payment = await findPaymentBySessionId(ctx.pool, sessionId);
      expect(payment?.status).toBe('refunded');
      expect(Number(payment?.refunded_cents)).toBe(PRICE);
      expect(await paidStatus(vid)).toBe('unpaid');
    });

    it('does not un-revoke a chargeback decided against us', async () => {
      const { vid, sessionId, chargeId, intentId } = await seedPaid(
        'Post-Chargeback Replay Co',
        'post_dispute_replay',
      );
      expect(
        (await post(disputeEvent('closed', { id: 'dp_replay', charge: chargeId, status: 'lost' })))
          .statusCode,
      ).toBe(200);
      expect(await paidStatus(vid)).toBe('unpaid');

      expect((await post(completedEvent(sessionId, intentId))).statusCode).toBe(200);

      const payment = await findPaymentBySessionId(ctx.pool, sessionId);
      expect(payment?.status).toBe('refunded');
      expect(payment?.dispute_status).toBe('lost');
      expect(await paidStatus(vid)).toBe('unpaid');
    });

    /**
     * The same guard from the other side, asserted where it is decidable.
     *
     * Two deliveries of one event racing across two processes is the case the
     * compare-and-set exists for, and it cannot be staged honestly from a
     * single-threaded test: `fastify.inject` calls interleave at await points
     * that happen to serialise the read and the write, so a parallel-delivery
     * test passes with or without the guard and proves nothing. What *is*
     * decidable is the contract the route now relies on — exactly one caller
     * gets the row back, and the loser is told it lost rather than being handed
     * a row it did not change.
     */
    it('lets exactly one caller claim a pending payment', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: 'Concurrent Settle Co' },
      });
      const vid = created.json().valuation.id as string;
      const payment = await createPayment(ctx.pool, {
        valuationId: vid,
        sessionId: 'cs_concurrent',
        amountCents: PRICE,
        currency: 'USD',
        createdBy: ops.id,
      });

      const claim = () =>
        markPayment(ctx.pool, payment.id, 'succeeded', {
          paymentIntentId: 'pi_concurrent',
          from: ['pending'],
        });
      expect(await claim()).not.toBeNull();
      expect(await claim()).toBeNull();

      // And the unconditional form is still available to callers that are not
      // racing for anything — the receipt fixtures above use it.
      expect(await markPayment(ctx.pool, payment.id, 'failed')).not.toBeNull();
    });
  });

  /**
   * A subscription renewal is charged against a Stripe *invoice* and has no
   * `payments` row, so its `charge.refunded` matched nothing here and was
   * answered `{ignored: 'unknown charge'}`. Nothing else ever writes to
   * `invoices` after the row is created, so the money stayed collected — on the
   * invoice PDF and in the ops revenue line — permanently.
   */
  describe('a refund against a subscription invoice', () => {
    const seedInvoice = async (stripeInvoiceId: string, amountCents: number) => {
      const number = `INV-REFUND-${stripeInvoiceId}`;
      await ctx.pool.query(
        `INSERT INTO invoices (id, user_id, number, amount_cents, currency, status, issued_at,
                               line_items, stripe_invoice_id)
         VALUES ($1, $2, $3, $4, 'usd', 'paid', now(), '[]', $5)`,
        [newUlid(), client.id, number, amountCents, stripeInvoiceId],
      );
      return number;
    };

    const refundCharge = (invoiceId: string, amountRefunded: number, chargeId: string) =>
      post(
        JSON.stringify({
          id: `evt_${chargeId}`,
          type: 'charge.refunded',
          data: { object: { id: chargeId, invoice: invoiceId, amount_refunded: amountRefunded } },
        }),
      );

    it('records it against the invoice and tells the subscriber', async () => {
      const number = await seedInvoice('in_sub_refund_1', 100_000);
      const res = await refundCharge('in_sub_refund_1', 30_000, 'ch_sub_refund_1');
      expect(res.statusCode).toBe(200);
      expect(res.json().refunded).toBe(false); // partial

      const invoice = await findInvoiceByStripeId(ctx.pool, 'in_sub_refund_1');
      expect(Number(invoice?.refunded_cents)).toBe(30_000);
      expect(invoice?.refunded_at).not.toBeNull();
      // The status does not move: Stripe leaves the invoice `paid` and takes
      // the money off the charge, and saying otherwise would say something
      // Stripe does not.
      expect(invoice?.status).toBe('paid');

      const notes = await listNotifications(ctx.pool, client.id, {});
      const refundNote = notes.find((n) => n.type === 'invoice_refunded');
      expect(refundNote?.title).toContain(number);
    });

    it('reports a full refund as full', async () => {
      await seedInvoice('in_sub_refund_2', 50_000);
      const res = await refundCharge('in_sub_refund_2', 50_000, 'ch_sub_refund_2');
      expect(res.json().refunded).toBe(true);
    });

    it('ignores a charge that belongs to no invoice we issued', async () => {
      const res = await refundCharge('in_never_issued', 1_000, 'ch_unknown_invoice');
      expect(res.statusCode).toBe(200);
      expect(res.json().ignored).toMatch(/unknown/i);
    });

    it('ignores a charge carrying neither a payment nor an invoice', async () => {
      const res = await post(
        JSON.stringify({
          id: 'evt_bare_charge',
          type: 'charge.refunded',
          data: { object: { id: 'ch_bare', amount_refunded: 500 } },
        }),
      );
      expect(res.json().ignored).toBe('unknown charge');
    });
  });
});
