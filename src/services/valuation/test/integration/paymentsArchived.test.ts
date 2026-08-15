import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayment, markPayment } from '../../src/repos/payments.js';
import { markValuationsArchived } from '../../src/repos/retention.js';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Taking money for an engagement the firm has retired.
 *
 * The soft-delete sweep stopped `listUnpaidValuationsForScope` offering an
 * archived engagement on the billing page, on the grounds that the list "is not
 * a report, it is a demand for money with a button beside it". The button was
 * never gated. An engagement's own page stays reachable by id — deliberately,
 * so ops can work a retired file — so its pay panel still rendered, still
 * quoted a price, and `POST …/payments/checkout` still ran all the way to
 * Stripe and opened a live Checkout Session.
 *
 * A `sk_live_` key is configured here for one reason: without it the checkout
 * answers 503 for everyone, which would let this suite pass on the wrong
 * refusal. Nothing in it reaches Stripe — every request is expected to be
 * turned away before the outbound call.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('payments on a retired engagement', () => {
  let ctx: TestApp;
  let ops: { id: string; token: string };
  let client: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp({ STRIPE_SECRET_KEY: 'sk_live_not_used', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const createValuation = async (companyName: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  /**
   * Through the retention sweep's own writer, not a bare UPDATE: it is what
   * archives an engagement in production, and it invalidates the row cache
   * `findValuationById` reads through. A direct UPDATE leaves a stale row
   * cached and quietly tests nothing.
   */
  const archive = (id: string) => markValuationsArchived(ctx.pool, [id]);

  const quote = (id: string, token: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/payments/quote`,
      headers: authHeader(token),
    });

  const checkout = (id: string, token: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/payments/checkout`,
      headers: authHeader(token),
      payload: {},
    });

  it('refuses to open a checkout for an archived engagement', async () => {
    const vid = await createValuation('Retired Pay Co');
    await archive(vid);

    const res = await checkout(vid, client.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/retired/i);

    // And nothing was recorded: a pending payments row against a retired
    // engagement is a bill somebody would later chase.
    const { rows } = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM payments WHERE valuation_id = $1',
      [vid],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses ops the same way — it is the engagement, not the caller', async () => {
    const vid = await createValuation('Retired Ops Pay Co');
    await archive(vid);
    const res = await checkout(vid, ops.token);
    expect(res.statusCode).toBe(409);
  });

  it('quotes the price but does not offer it', async () => {
    const vid = await createValuation('Retired Quote Co');
    const live = await quote(vid, client.token);
    expect(live.statusCode).toBe(200);
    expect(live.json().quote.payable).toBe(true);

    await archive(vid);
    const retired = await quote(vid, client.token);
    expect(retired.statusCode).toBe(200);
    // The price is a fact and ops reading a closed file should still see it;
    // `payable` is what the panel keys the button off, so the two agree with
    // the POST above rather than offering a button it would refuse.
    expect(retired.json().quote.amount_cents).toBe(live.json().quote.amount_cents);
    expect(retired.json().quote.payable).toBe(false);
    expect(retired.json().quote.configured).toBe(true);
  });

  it('still says a settled engagement is not payable', async () => {
    const vid = await createValuation('Settled Quote Co');
    await ctx.pool.query("UPDATE valuations SET paid_status = 'paid' WHERE id = $1", [vid]);
    invalidateValuation(vid);
    expect((await quote(vid, client.token)).json().quote.payable).toBe(false);
  });

  it('leaves the record of a payment already taken alone', async () => {
    // Money that moved did not stop having moved because the engagement was
    // later retired — the receipt and the history are records, not demands.
    const vid = await createValuation('Retired Receipt Co');
    const payment = await createPayment(ctx.pool, {
      valuationId: vid,
      sessionId: 'cs_retired_receipt',
      amountCents: 119_000,
      currency: 'USD',
      createdBy: ops.id,
    });
    await markPayment(ctx.pool, payment.id, 'succeeded');
    await archive(vid);

    const receipt = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${vid}/payments/${payment.id}/receipt.pdf`,
      headers: authHeader(client.token),
    });
    expect(receipt.statusCode).toBe(200);

    const history = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${vid}/payments`,
      headers: authHeader(client.token),
    });
    expect(history.json().payments).toHaveLength(1);

    const billing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/billing',
      headers: authHeader(client.token),
    });
    const ids = (billing.json().billing.payments as Array<{ valuation_id: string }>).map(
      (p) => p.valuation_id,
    );
    expect(ids).toContain(vid);
  });
});
