import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { INT4_MAX } from '../../src/domain/int4.js';
import { findInvoiceByStripeId } from '../../src/repos/billing.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const WEBHOOK_SECRET = 'whsec_settlement_amounts';

function signedHeaders(payload: string, secret = WEBHOOK_SECRET): Record<string, string> {
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
}

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('amounts a settlement event carries', () => {
  let ctx: TestApp;
  let client: { id: string; email: string; token: string };

  const post = (url: string, body: string) =>
    ctx.app.inject({ method: 'POST', url, headers: signedHeaders(body), payload: body });

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const seedInvoice = async (stripeInvoiceId: string, amountCents: number) => {
    await ctx.pool.query(
      `INSERT INTO invoices (id, user_id, number, amount_cents, currency, status, issued_at,
                             line_items, stripe_invoice_id)
       VALUES ($1, $2, $3, $4, 'usd', 'paid', now(), '[]', $5)`,
      [newUlid(), client.id, `INV-AMT-${stripeInvoiceId}`, amountCents, stripeInvoiceId],
    );
  };

  const refundCharge = (invoiceId: string, amountRefunded: unknown, chargeId: string) =>
    post(
      '/api/v1/stripe/webhook',
      JSON.stringify({
        id: `evt_${chargeId}`,
        type: 'charge.refunded',
        data: { object: { id: chargeId, invoice: invoiceId, amount_refunded: amountRefunded } },
      }),
    );

  it('refuses a refund total that is not whole minor units', async () => {
    await seedInvoice('in_amt_frac', 100_000);
    const res = await refundCharge('in_amt_frac', 12.5, 'ch_amt_frac');
    expect(res.statusCode).toBeLessThan(500);
    const invoice = await findInvoiceByStripeId(ctx.pool, 'in_amt_frac');
    expect(Number(invoice?.refunded_cents)).toBe(0);
  });

  it('refuses a refund total the column cannot hold', async () => {
    await seedInvoice('in_amt_big', 100_000);
    const res = await refundCharge('in_amt_big', INT4_MAX + 1, 'ch_amt_big');
    expect(res.statusCode).toBeLessThan(500);
  });

  it('refuses an invoice amount the column cannot hold, without burning a number', async () => {
    const before = await ctx.pool.query<{ seq: number }>('SELECT seq FROM invoice_sequences');
    const res = await post(
      '/api/v1/billing/webhook',
      JSON.stringify({
        id: 'evt_invoice_amount_overflow',
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_amount_overflow',
            amount_paid: INT4_MAX + 1,
            currency: 'usd',
            metadata: { user_id: client.id },
          },
        },
      }),
    );
    expect(res.statusCode).toBe(400);
    const after = await ctx.pool.query<{ seq: number }>('SELECT seq FROM invoice_sequences');
    expect(after.rows.map((r) => Number(r.seq))).toEqual(before.rows.map((r) => Number(r.seq)));
  });
});
