import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as paymentsRepo from '../../src/repos/payments.js';
import { createPayment, findPaymentBySessionId } from '../../src/repos/payments.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * What a settlement says when the receipt step goes wrong (R450, methodology
 * M11).
 *
 * The fulfilment handler fetches the charge behind a settled Checkout Session
 * for two reasons: the receipt URL, and the one figure that can say the money
 * has already gone back (`settlementAlreadyRefunded.test.ts`). Four operations
 * sat inside one `try` — the lookup, the receipt write, the refund reading and
 * the refund write — and one `catch` reported every one of them as
 * `{ err }, 'stripe receipt lookup failed'`: at `warn`, with the event id the
 * child logger carries and no payment, engagement or intent on the line.
 *
 * Three different things were behind that sentence. A lookup that failed
 * means the engagement is released without the refund check, which is the
 * exact ordering the check exists for. A refund write that failed after
 * Stripe had already said the money was back is a row that says 'succeeded'
 * for a returned charge, which nothing comes back to correct — the
 * `charge.refunded` that would have may already have been delivered, matched
 * nothing, and been ledgered. Neither is a lookup, and the second is not
 * `warn`: in this estate `warn` promises a retry is coming.
 */

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_receipt_failures';

function signedHeaders(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const intentWithCharge = (amountRefunded: number) =>
  vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'pi_receipt_failures',
        latest_charge: {
          id: 'ch_receipt_failures',
          receipt_url: 'https://stripe.example/receipt',
          amount_refunded: amountRefunded,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );

const unreachable = () =>
  vi.fn().mockRejectedValue(
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.stripe.com'), { code: 'ENOTFOUND' }),
    }),
  );

describe.skipIf(!dbUp)('a settlement whose receipt step fails', () => {
  let ctx: TestApp;
  let ops: { id: string; email: string; token: string };
  let lines: Array<Record<string, unknown>>;
  const AMOUNT = 119_000;

  beforeAll(async () => {
    ctx = await setupTestApp({
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_SECRET_KEY: 'sk_test_x',
      LOG_LEVEL: 'info',
    });
    lines = [];
    (ctx.app.log as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        cb();
      },
    });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
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
        object: { id: sessionId, payment_intent: 'pi_receipt_failures', payment_status: 'paid', amount_total: AMOUNT },
      },
    });
    return ctx.app.inject({ method: 'POST', url: '/api/v1/stripe/webhook', headers: signedHeaders(payload), payload });
  };

  const paidStatus = async (vid: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${vid}`,
      headers: authHeader(ops.token),
    });
    return res.json().valuation.paid_status as string;
  };

  const lineSaying = (mark: number, fragment: string) =>
    lines.slice(mark).find((l) => typeof l.msg === 'string' && l.msg.includes(fragment));

  it('says what a failed lookup costs, and which payment it cost it on', async () => {
    vi.stubGlobal('fetch', unreachable());
    const vid = await pending('LookupDownCo', 'cs_lookup_down');
    const mark = lines.length;
    expect((await settle('cs_lookup_down', 'evt_lookup_down')).statusCode).toBe(200);

    // The ack is unchanged: the engagement is released on the assumption
    // nothing has gone back, which is the documented choice.
    expect(await paidStatus(vid)).toBe('paid');

    const line = lineSaying(mark, 'stripe receipt lookup failed');
    expect(line).toBeDefined();
    expect(line!.level).toBe('warn');
    // The consequence is on the line, not left for the reader to derive.
    expect(line!.msg).toContain('without checking whether the charge was already refunded');
    // And the identifiers a reconciliation needs. The event id alone points at
    // Stripe's dashboard; these point at our rows.
    expect(line!.paymentId).toBeDefined();
    expect(line!.valuationId).toBe(vid);
    expect(line!.sessionId).toBe('cs_lookup_down');
    expect(line!.paymentIntentId).toBe('pi_receipt_failures');
    expect(line!.stripeEventId).toBe('evt_lookup_down');
  });

  it('reports a refund write that failed as the loss it is, not as a lookup', async () => {
    vi.stubGlobal('fetch', intentWithCharge(AMOUNT));
    vi.spyOn(paymentsRepo, 'recordRefund').mockRejectedValueOnce(new Error('statement timeout'));
    const vid = await pending('RefundWriteDownCo', 'cs_refund_write_down');
    const mark = lines.length;
    expect((await settle('cs_refund_write_down', 'evt_refund_write_down')).statusCode).toBe(200);

    // The gate holds on the in-memory reading: no release, no receipt.
    expect(await paidStatus(vid)).toBe('unpaid');
    const row = await findPaymentBySessionId(ctx.pool, 'cs_refund_write_down');
    expect(row?.status).toBe('succeeded');

    expect(lineSaying(mark, 'stripe receipt lookup failed')).toBeUndefined();
    const line = lineSaying(mark, 'a refund Stripe already reports could not be recorded');
    expect(line).toBeDefined();
    // `logUnretried`: error, alerting, and marked as the arm nothing retries.
    expect(line!.level).toBe('error');
    expect(line!.alert).toBe(true);
    expect(line!.retried).toBe(false);
    expect(line!.paymentId).toBe(row?.id);
    expect(line!.valuationId).toBe(vid);
    expect(line!.refundedCents).toBe(AMOUNT);
    expect(line!.fullyRefunded).toBe(true);
  });

  it('still reads the refund off a receipt it could not store', async () => {
    // The receipt is in hand when the row write fails; the old block threw
    // past the refund reading and released the engagement.
    vi.stubGlobal('fetch', intentWithCharge(AMOUNT));
    vi.spyOn(paymentsRepo, 'setPaymentReceipt').mockRejectedValueOnce(new Error('statement timeout'));
    const vid = await pending('ReceiptWriteDownCo', 'cs_receipt_write_down');
    const mark = lines.length;
    expect((await settle('cs_receipt_write_down', 'evt_receipt_write_down')).statusCode).toBe(200);

    expect(await paidStatus(vid)).toBe('unpaid');
    const row = await findPaymentBySessionId(ctx.pool, 'cs_receipt_write_down');
    expect(row?.status).toBe('refunded');

    const line = lineSaying(mark, 'stripe receipt could not be stored');
    expect(line).toBeDefined();
    expect(line!.level).toBe('error');
    expect(line!.alert).toBe(true);
    expect(line!.valuationId).toBe(vid);
  });
});
