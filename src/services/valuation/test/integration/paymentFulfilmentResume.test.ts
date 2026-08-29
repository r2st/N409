import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPaymentBySessionId, createPayment, recordRefund } from '../../src/repos/payments.js';
import { findValuationById } from '../../src/repos/valuations.js';
import { priceForKind } from '../../src/routes/payments.js';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

/**
 * A fulfilment that stopped halfway (round 203, methodology M5).
 *
 * `markPayment(from: ['pending'])` is what makes a redelivered
 * `checkout.session.completed` safe: the second delivery loses the
 * compare-and-set and returns. Everything the fulfilment does *after* that
 * claim is a separate statement — the receipt, the valuation's paid fields, the
 * lifecycle move, the announcement — and two of them are deliberately not
 * wrapped, so a pool timeout or a restart between them 5xx's the webhook.
 *
 * Which is the right answer, because a 5xx is how Stripe is asked to come back.
 * The problem was what it came back to: the payment row was already
 * 'succeeded', so the claim was declined and the handler returned having done
 * nothing, and the ledger — which records only on success — let the *next*
 * redelivery repeat the same no-op. The charge was collected, the payment row
 * said succeeded, and the engagement stayed unpaid, unadvanced and
 * unannounced, for good.
 */

const WEBHOOK_SECRET = 'whsec_resume_test';
const dbUp = await isDbAvailable();

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const T = Math.floor(Date.UTC(2026, 7, 30, 10, 0, 0) / 1000);

describe.skipIf(!dbUp)('resuming an abandoned fulfilment', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  });
  afterAll(async () => ctx?.teardown());

  const deliver = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stripe/webhook',
      headers: signedHeaders(payload),
      payload,
    });
  };

  async function seedCheckout(company: string, sessionId: string) {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const vid = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(user.token),
        payload: { kind: '409a', company_name: company },
      })
    ).json().valuation.id as string;
    await createPayment(ctx.pool, {
      valuationId: vid,
      sessionId,
      amountCents: priceForKind('409a'),
      currency: 'USD',
      createdBy: user.id,
    });
    return { user, vid };
  }

  const completed = (eventId: string, sessionId: string) => ({
    id: eventId,
    type: 'checkout.session.completed',
    created: T,
    data: {
      object: {
        id: sessionId,
        mode: 'payment',
        payment_status: 'paid',
        amount_total: priceForKind('409a'),
      },
    },
  });

  const receivedCount = async (valuationId: string) =>
    Number(
      (
        await ctx.pool.query(
          `SELECT count(*)::int AS n FROM notifications WHERE valuation_id = $1 AND type = 'payment_received'`,
          [valuationId],
        )
      ).rows[0].n,
    );

  it('finishes an engagement the first delivery settled but never reached', async () => {
    const { vid } = await seedCheckout('Abandoned Fulfilment Co', 'cs_resume_1');

    // The first delivery: the money write lands, the engagement's does not.
    // Failing the valuation UPDATE is the real shape of it — a pool timeout, a
    // deadlock, a restart — rather than a hand-set row.
    let fail = true;
    const restore = interceptPoolQueries(ctx.pool, (sql) => {
      if (fail && /UPDATE valuations SET/.test(sql)) throw new Error('pool timeout');
      return undefined;
    });
    const first = await deliver(completed('evt_resume_1', 'cs_resume_1'));
    restore();
    expect(first.statusCode).toBeGreaterThanOrEqual(500);

    // Exactly the state that used to be permanent.
    expect((await findPaymentBySessionId(ctx.pool, 'cs_resume_1'))?.status).toBe('succeeded');
    expect((await findValuationById(ctx.pool, vid))?.paid_status).toBe('unpaid');

    // Stripe redelivers the same event id. The ledger writes only on success,
    // so it is still 'fresh' — and the claim it can no longer win is no longer
    // the end of the handler.
    fail = false;
    const second = await deliver(completed('evt_resume_1', 'cs_resume_1'));
    expect(second.statusCode).toBe(200);

    const valuation = await findValuationById(ctx.pool, vid);
    expect(valuation?.paid_status).toBe('paid');
    expect(Number(valuation?.amount_cents)).toBe(priceForKind('409a'));
    expect(await receivedCount(vid)).toBe(1);
  });

  it('still does nothing for an ordinary redelivery of a fulfilment that finished', async () => {
    // The resume must not become a second fulfilment. A completed one leaves
    // the engagement paid, and that is what tells the redelivery to stop —
    // one notification, not two.
    const { vid } = await seedCheckout('Ordinary Replay Co', 'cs_resume_2');

    expect((await deliver(completed('evt_resume_2a', 'cs_resume_2'))).statusCode).toBe(200);
    expect((await findValuationById(ctx.pool, vid))?.paid_status).toBe('paid');
    expect(await receivedCount(vid)).toBe(1);

    // A fresh event id, so the ledger's duplicate check is not what answers it
    // — the resume's own guard is.
    expect((await deliver(completed('evt_resume_2b', 'cs_resume_2'))).statusCode).toBe(200);
    expect(await receivedCount(vid)).toBe(1);
  });

  it('does not resume a payment that has since been refunded', async () => {
    // 'succeeded' is the whole entitlement. A refund or a lost chargeback moves
    // the row off it before clearing the valuation, so a redelivery arriving
    // afterwards must find nothing to finish — this is the replay that used to
    // put a refunded client back to paid.
    const { vid } = await seedCheckout('Refunded Replay Co', 'cs_resume_3');

    expect((await deliver(completed('evt_resume_3a', 'cs_resume_3'))).statusCode).toBe(200);
    const payment = await findPaymentBySessionId(ctx.pool, 'cs_resume_3');
    await ctx.pool.query(`UPDATE payments SET status = 'refunded' WHERE id = $1`, [payment!.id]);
    await ctx.pool.query(`UPDATE valuations SET paid_status = 'unpaid' WHERE id = $1`, [vid]);

    expect((await deliver(completed('evt_resume_3b', 'cs_resume_3'))).statusCode).toBe(200);
    expect((await findValuationById(ctx.pool, vid))?.paid_status).toBe('unpaid');
    expect((await findPaymentBySessionId(ctx.pool, 'cs_resume_3'))?.status).toBe('refunded');
    expect(await receivedCount(vid)).toBe(1);
  });
});

/**
 * The same shape on the way back out (round 203, methodology M5).
 *
 * `recordRefund` writes the figure and `revokePaidStatus` applies it, and the
 * second is not wrapped. A failure between them 5xx's the webhook so Stripe
 * comes back — to a row already carrying the full total, which is exactly what
 * "not news" looks like. The handler returned, and the engagement stayed paid:
 * a client with every cent back still holding a published 409A.
 */
describe.skipIf(!dbUp)('resuming an abandoned revocation', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
  });
  afterAll(async () => ctx?.teardown());

  const deliver = (event: unknown) => {
    const payload = JSON.stringify(event);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stripe/webhook',
      headers: signedHeaders(payload),
      payload,
    });
  };

  /** A paid engagement with a settled payment row, ready to be refunded. */
  async function seedPaid(company: string, sessionId: string, chargeId: string) {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const vid = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(user.token),
        payload: { kind: '409a', company_name: company },
      })
    ).json().valuation.id as string;
    await createPayment(ctx.pool, {
      valuationId: vid,
      sessionId,
      amountCents: priceForKind('409a'),
      currency: 'USD',
      createdBy: user.id,
    });
    await deliver({
      id: `evt_paid_${chargeId}`,
      type: 'checkout.session.completed',
      created: T,
      data: {
        object: {
          id: sessionId,
          mode: 'payment',
          payment_status: 'paid',
          amount_total: priceForKind('409a'),
        },
      },
    });
    const payment = (await findPaymentBySessionId(ctx.pool, sessionId))!;
    await ctx.pool.query(`UPDATE payments SET charge_id = $2 WHERE id = $1`, [payment.id, chargeId]);
    return { vid, paymentId: payment.id };
  }

  const refunded = (eventId: string, chargeId: string, amountRefunded: number) => ({
    id: eventId,
    type: 'charge.refunded',
    created: T,
    data: { object: { id: chargeId, amount_refunded: amountRefunded } },
  });

  const reversedCount = async (valuationId: string) =>
    Number(
      (
        await ctx.pool.query(
          `SELECT count(*)::int AS n FROM notifications WHERE valuation_id = $1 AND type = 'payment_reversed'`,
          [valuationId],
        )
      ).rows[0].n,
    );

  it('takes the engagement back when the first delivery only got as far as the money', async () => {
    const { vid } = await seedPaid('Abandoned Revocation Co', 'cs_revoke_1', 'ch_revoke_1');

    let fail = true;
    const restore = interceptPoolQueries(ctx.pool, (sql) => {
      if (fail && /UPDATE valuations SET/.test(sql)) throw new Error('pool timeout');
      return undefined;
    });
    const first = await deliver(refunded('evt_revoke_1', 'ch_revoke_1', priceForKind('409a')));
    restore();
    expect(first.statusCode).toBeGreaterThanOrEqual(500);

    // The state that used to be permanent: every cent back, engagement paid.
    expect((await findPaymentBySessionId(ctx.pool, 'cs_revoke_1'))?.status).toBe('refunded');
    expect((await findValuationById(ctx.pool, vid))?.paid_status).toBe('paid');

    fail = false;
    expect((await deliver(refunded('evt_revoke_1', 'ch_revoke_1', priceForKind('409a')))).statusCode).toBe(
      200,
    );
    expect((await findValuationById(ctx.pool, vid))?.paid_status).toBe('unpaid');
    expect(await reversedCount(vid)).toBe(1);
  });

  it('still says nothing on an ordinary redelivery of a refund that finished', async () => {
    const { vid } = await seedPaid('Ordinary Refund Replay Co', 'cs_revoke_2', 'ch_revoke_2');

    expect((await deliver(refunded('evt_revoke_2a', 'ch_revoke_2', priceForKind('409a')))).statusCode).toBe(
      200,
    );
    expect((await findValuationById(ctx.pool, vid))?.paid_status).toBe('unpaid');
    expect(await reversedCount(vid)).toBe(1);

    expect((await deliver(refunded('evt_revoke_2b', 'ch_revoke_2', priceForKind('409a')))).statusCode).toBe(
      200,
    );
    expect(await reversedCount(vid)).toBe(1);
  });

  it('refuses a smaller total that arrives after a larger one', async () => {
    // Stripe sends one charge.refunded per refund, so a part refund and the
    // rest of it are two events about one charge. Delivered out of order, the
    // earlier one used to overwrite the later — leaving a part-refund figure on
    // a row already marked refunded, and a revenue line netting off too little.
    const { paymentId } = await seedPaid('Backwards Refund Co', 'cs_revoke_3', 'ch_revoke_3');
    const full = priceForKind('409a');

    expect(await recordRefund(ctx.pool, paymentId, { refundedCents: full, fullyRefunded: true })).not.toBe(
      null,
    );
    expect(await recordRefund(ctx.pool, paymentId, { refundedCents: 5_000, fullyRefunded: false })).toBe(
      null,
    );

    const row = await findPaymentBySessionId(ctx.pool, 'cs_revoke_3');
    expect(Number(row?.refunded_cents)).toBe(full);
    expect(row?.status).toBe('refunded');
  });
});
