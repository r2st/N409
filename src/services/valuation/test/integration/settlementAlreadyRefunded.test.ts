import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPayment, findPaymentBySessionId } from '../../src/repos/payments.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * A settlement that arrives after the money has already gone back.
 *
 * `charge.refunded` names a charge and a payment intent, and a pending
 * `payments` row carries neither — both are written at fulfilment. So a refund
 * delivered *before* the settlement it belongs to matches nothing, is
 * acknowledged, is written into the event ledger, and is never redelivered.
 * The settlement then ran to completion: the engagement crossed the payment
 * gate and the client was mailed a receipt for money they already had back.
 *
 * The charge fetched for the receipt url is the one thing on this path that
 * knows, and it is fetched already.
 */

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_already_refunded';

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

/** A payment intent with its latest charge expanded, as `retrieveReceipt` reads it. */
const intentWithCharge = (amountRefunded: number) =>
  vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'pi_already_refunded',
        latest_charge: {
          id: 'ch_already_refunded',
          receipt_url: 'https://stripe.example/receipt',
          amount_refunded: amountRefunded,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

describe.skipIf(!dbUp)('a settlement on a charge that is already refunded', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  const AMOUNT = 119_000;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_SECRET_KEY: 'sk_test_x' });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => ctx?.teardown());

  const pending = async (company: string, sessionId: string) => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: company },
    });
    const vid = created.json().valuation.id as string;
    await createPayment(ctx.pool, {
      valuationId: vid,
      sessionId,
      amountCents: AMOUNT,
      currency: 'USD',
      createdBy: ops.id,
    });
    return vid;
  };

  const settle = (sessionId: string, eventId: string) => {
    const payload = JSON.stringify({
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          payment_intent: 'pi_already_refunded',
          payment_status: 'paid',
          amount_total: AMOUNT,
        },
      },
    });
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stripe/webhook',
      headers: signedHeaders(payload),
      payload,
    });
  };

  const paidStatus = async (vid: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${vid}`,
      headers: authHeader(ops.token),
    });
    return res.json().valuation.paid_status as string;
  };

  const receipts = async (vid: string) => {
    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications WHERE valuation_id = $1 AND type = 'payment_received'`,
      [vid],
    );
    return Number(rows[0]!.n);
  };

  it('records the refund and does not release the engagement', async () => {
    vi.stubGlobal('fetch', intentWithCharge(AMOUNT));
    const vid = await pending('AlreadyRefundedCo', 'cs_already_refunded');
    expect((await settle('cs_already_refunded', 'evt_already_refunded')).statusCode).toBe(200);

    expect(await paidStatus(vid)).toBe('unpaid');
    expect(await receipts(vid)).toBe(0);
    const row = await findPaymentBySessionId(ctx.pool, 'cs_already_refunded');
    expect(row?.status).toBe('refunded');
    expect(Number(row?.refunded_cents)).toBe(AMOUNT);
  });

  it('still releases an engagement whose charge was only partly refunded', async () => {
    vi.stubGlobal('fetch', intentWithCharge(10_000));
    const vid = await pending('PartlyRefundedCo', 'cs_partly_refunded');
    expect((await settle('cs_partly_refunded', 'evt_partly_refunded')).statusCode).toBe(200);

    expect(await paidStatus(vid)).toBe('paid');
    expect(await receipts(vid)).toBe(1);
    const row = await findPaymentBySessionId(ctx.pool, 'cs_partly_refunded');
    expect(row?.status).toBe('succeeded');
    expect(Number(row?.refunded_cents)).toBe(10_000);
  });

  it('is unchanged for the ordinary settlement, where nothing came back', async () => {
    vi.stubGlobal('fetch', intentWithCharge(0));
    const vid = await pending('OrdinaryCo', 'cs_ordinary_settlement');
    expect((await settle('cs_ordinary_settlement', 'evt_ordinary_settlement')).statusCode).toBe(200);

    expect(await paidStatus(vid)).toBe('paid');
    expect(await receipts(vid)).toBe(1);
    const row = await findPaymentBySessionId(ctx.pool, 'cs_ordinary_settlement');
    expect(row?.status).toBe('succeeded');
    expect(Number(row?.refunded_cents)).toBe(0);
    expect(row?.receipt_url).toBe('https://stripe.example/receipt');
  });
});
