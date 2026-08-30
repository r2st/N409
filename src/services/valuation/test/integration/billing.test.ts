import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayment, markPayment } from '../../src/repos/payments.js';
import { priceForKind } from '../../src/routes/payments.js';
import { authHeader, isDbAvailable, seedPartner, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Account-level billing rollup (P2 #13): payments across the caller's
 * accessible valuations with totals and receipt links; strict server-side
 * scoping (client: own, partner: org, ops: all); unpaid engagements CTA.
 */

const dbUp = await isDbAvailable();

interface BillingJson {
  payments: Array<{
    valuation_id: string;
    company_name: string;
    valuation_number: string;
    amount_cents: string | number;
    status: string;
    receipt_url: string | null;
  }>;
  unpaid_valuations: Array<{ id: string; amount_cents: number }>;
  totals: {
    gross_cents: number;
    refunded_cents: number;
    paid_cents: number;
    succeeded_count: number;
    refunded_count: number;
    payment_count: number;
  };
}

describe.skipIf(!dbUp)('billing rollup', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let partnerUser: Awaited<ReturnType<typeof seedUser>>;
  let partnerId: string;
  let clientValuationId: string;

  const getBilling = async (token: string): Promise<BillingJson> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/billing',
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().billing as BillingJson;
  };

  const createValuation = async (token: string, company: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  /** Simulate a completed checkout: payment row → succeeded with a receipt. */
  const paySucceeded = async (valuationId: string, sessionId: string, amountCents: number) => {
    const payment = await createPayment(ctx.pool, {
      valuationId,
      sessionId,
      amountCents,
      currency: 'USD',
    });
    await markPayment(ctx.pool, payment.id, 'succeeded', {
      receiptUrl: `https://pay.stripe.com/receipts/${sessionId}`,
    });
    await ctx.pool.query(
      `UPDATE valuations SET paid_status = 'paid', amount_cents = $2, paid_at = now() WHERE id = $1`,
      [valuationId, amountCents],
    );
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    otherClient = await seedUser(ctx, { roles: ['valuation_user'] });
    partnerId = await seedPartner(ctx, 'Billing Partner');
    partnerUser = await seedUser(ctx, { roles: ['partner'], partnerId });

    // client: one paid, one unpaid engagement
    clientValuationId = await createValuation(client.token, 'Paid Co');
    await paySucceeded(clientValuationId, 'cs_billing_client', 119_000);
    await createValuation(client.token, 'Unpaid Co');

    // other client: their own paid engagement (must never leak to `client`)
    const otherVal = await createValuation(otherClient.token, 'Other Tenant Co');
    await paySucceeded(otherVal, 'cs_billing_other', 99_000);

    // partner org: a valuation owned by the partner user
    const partnerVal = await createValuation(partnerUser.token, 'Partner Channel Co');
    await paySucceeded(partnerVal, 'cs_billing_partner', 149_000);
  });
  afterAll(async () => ctx?.teardown());

  it('shows a client their own payments with receipt links and matching totals', async () => {
    const billing = await getBilling(client.token);
    expect(billing.payments).toHaveLength(1);
    const payment = billing.payments[0]!;
    expect(payment.company_name).toBe('Paid Co');
    expect(payment.status).toBe('succeeded');
    expect(payment.receipt_url).toBe('https://pay.stripe.com/receipts/cs_billing_client');
    expect(billing.totals).toEqual({
      gross_cents: 119_000,
      refunded_cents: 0,
      paid_cents: 119_000,
      succeeded_count: 1,
      refunded_count: 0,
      payment_count: 1,
      // The engagement's own currency, so the figures are an amount rather
      // than a sum of minor units nobody named. See `collectedTotals`.
      currency: 'usd',
      mixed_currency: false,
    });
  });

  it('surfaces unpaid engagements with the list price as a pay-now CTA', async () => {
    const billing = await getBilling(client.token);
    expect(billing.unpaid_valuations).toHaveLength(1);
    expect(billing.unpaid_valuations[0]!.amount_cents).toBe(priceForKind('409a'));
  });

  it('never leaks cross-tenant payments', async () => {
    const billing = await getBilling(client.token);
    expect(billing.payments.some((p) => p.company_name === 'Other Tenant Co')).toBe(false);
    expect(billing.payments.some((p) => p.company_name === 'Partner Channel Co')).toBe(false);
  });

  it('scopes a partner user to their organisation', async () => {
    const billing = await getBilling(partnerUser.token);
    expect(billing.payments).toHaveLength(1);
    expect(billing.payments[0]!.company_name).toBe('Partner Channel Co');
    expect(billing.totals.paid_cents).toBe(149_000);
  });

  it('gives ops the account-wide view', async () => {
    const billing = await getBilling(ops.token);
    expect(billing.payments.length).toBeGreaterThanOrEqual(3);
    expect(billing.totals.paid_cents).toBe(119_000 + 99_000 + 149_000);
  });

  it('renders an empty state cleanly for a user with no payments', async () => {
    const fresh = await seedUser(ctx, { roles: ['valuation_user'] });
    const billing = await getBilling(fresh.token);
    expect(billing.payments).toEqual([]);
    expect(billing.unpaid_valuations).toEqual([]);
    expect(billing.totals).toEqual({
      gross_cents: 0,
      refunded_cents: 0,
      paid_cents: 0,
      succeeded_count: 0,
      refunded_count: 0,
      payment_count: 0,
      // Nothing collected is in no currency at all; the platform default is
      // the only honest label for a zero.
      currency: 'usd',
      mixed_currency: false,
    });
  });
});
