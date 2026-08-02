import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvoice, nextInvoiceSequence } from '../../src/repos/billing.js';
import { invoiceNumber } from '../../src/domain/billing.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_test_secret';

function stripeSig(payload: string, secret = WEBHOOK_SECRET): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

/**
 * Invoice numbering under concurrency.
 *
 * `invoices.number` is `text NOT NULL UNIQUE`, and the sequence behind it used
 * to be derived with `SELECT count(*) ... WHERE month = this month` immediately
 * before the insert. That read-then-write is not atomic, so two deliveries
 * landing together both counted N and both built `INV-YYYYMM-000(N+1)`.
 *
 * This is not a theoretical interleaving. A subscription business renews in
 * bulk at a period boundary, and Stripe fans those `invoice.paid` events out
 * concurrently — the busiest moment of the billing month is exactly when the
 * window is widest.
 *
 * The loser's insert raised a unique violation on `number`, which the webhook's
 * catch-all swallowed before replying `200`. Stripe treats 200 as "handled" and
 * never redelivers, so a customer's paid invoice was silently absent from the
 * billing record with only a log line to show for it.
 */
describe.skipIf(!dbUp)('invoice numbering under concurrency', () => {
  let ctx: TestApp;
  let user: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    user = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  /** An `invoice.paid` event for a distinct Stripe invoice id. */
  function paidEvent(stripeInvoiceId: string): string {
    return JSON.stringify({
      type: 'invoice.paid',
      data: {
        object: {
          id: stripeInvoiceId,
          metadata: { user_id: user.id },
          amount_paid: 12_345,
          currency: 'usd',
          description: 'Subscription',
        },
      },
    });
  }

  it('records every concurrently delivered invoice', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `in_concurrent_${newSuffix()}_${i}`);

    const responses = await Promise.all(
      ids.map((id) => {
        const payload = paidEvent(id);
        return ctx.app.inject({
          method: 'POST',
          url: '/api/v1/billing/webhook',
          headers: { 'stripe-signature': stripeSig(payload), 'content-type': 'application/json' },
          payload,
        });
      }),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);

    // Every event must have produced a row. Under the count(*) race the losers
    // collided on `number`, and the swallowed error left them missing here.
    const { rows } = await ctx.pool.query<{ number: string; stripe_invoice_id: string }>(
      `SELECT number, stripe_invoice_id FROM invoices WHERE stripe_invoice_id = ANY($1::text[])`,
      [ids],
    );
    expect(rows.map((r) => r.stripe_invoice_id).sort()).toEqual([...ids].sort());

    // ...and each under its own number, since the column is UNIQUE and an
    // auditor reads the sequence as a count of what was billed.
    expect(new Set(rows.map((r) => r.number)).size).toBe(ids.length);
  });

  it('allocates distinct numbers to concurrent sequence requests', async () => {
    // The same race one level down, without the webhook around it.
    const issued = new Date().toISOString();
    const seqs = await Promise.all(Array.from({ length: 8 }, () => nextInvoiceSequence(ctx.pool)));
    expect(new Set(seqs).size).toBe(seqs.length);

    // The numbers built from them are what actually has to be unique.
    const numbers = seqs.map((s) => invoiceNumber(issued, s));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('treats a redelivered invoice as the same invoice, not a new one', async () => {
    // Stripe delivers at least once, so the same event can arrive twice. The
    // second must not mint a second invoice for one payment.
    const stripeId = `in_redelivered_${newSuffix()}`;
    const payload = paidEvent(stripeId);
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'stripe-signature': stripeSig(payload), 'content-type': 'application/json' },
        payload,
      });

    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);

    const { rows } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM invoices WHERE stripe_invoice_id = $1',
      [stripeId],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('returns the existing invoice when the same Stripe invoice is created twice', async () => {
    // createInvoice's signature promises an InvoiceRow. On the ON CONFLICT path
    // it used to return undefined behind a non-null assertion, so a caller
    // reading `.id` got a TypeError on the redelivery path only.
    const stripeId = `in_twice_${newSuffix()}`;
    const issued = new Date().toISOString();
    const base = {
      userId: user.id,
      amountCents: 5_000,
      currency: 'usd',
      status: 'paid' as const,
      lineItems: [{ description: 'Subscription', amount_cents: 5_000 }],
      stripeInvoiceId: stripeId,
    };

    const first = await createInvoice(ctx.pool, {
      ...base,
      number: invoiceNumber(issued, await nextInvoiceSequence(ctx.pool)),
    });
    const second = await createInvoice(ctx.pool, {
      ...base,
      number: invoiceNumber(issued, await nextInvoiceSequence(ctx.pool)),
    });

    expect(second).toBeDefined();
    expect(second.id).toBe(first.id);
    expect(second.number).toBe(first.number);
  });
});

/** Keeps ids unique across runs against a reused database. */
function newSuffix(): string {
  return crypto.randomBytes(6).toString('hex');
}
