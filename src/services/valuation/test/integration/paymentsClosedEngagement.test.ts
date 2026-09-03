import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateValuation } from '../../src/repos/valuations.js';
import { markValuationsArchived } from '../../src/repos/retention.js';
import { STATE_GROUPS } from '../../src/domain/operations.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Taking money for an engagement the firm has closed.
 *
 * `paymentsArchived.test.ts` shut this door on a *retired* engagement: the
 * pay-now list had excluded one for years, and the button had never been
 * gated, so the pay panel on a retired file still opened a live Stripe
 * Checkout Session. The gate it added reads `archived_at`, and retirement is
 * not how work stops — `cancelled`, `timeout` and `ignored` are the three
 * terminal states of `WORKFLOW_TRANSITIONS`, the pay-now list has excluded
 * them since it was written, and closing a file is what ops do years before
 * the retention sweep ever archives it. So the reachable half of the pair was
 * the one left open.
 *
 * A `sk_live_` key is configured for one reason: without it the checkout
 * answers 503 for everyone, which would let this suite pass on the wrong
 * refusal. Nothing here reaches Stripe.
 */

const dbUp = await isDbAvailable();

describe.skipIf(!dbUp)('payments on a closed engagement', () => {
  let ctx: TestApp;
  let client: { id: string; token: string };

  beforeAll(async () => {
    ctx = await setupTestApp({
      AUTO_PIPELINE: 'off',
      STRIPE_SECRET_KEY: 'sk_live_not_used',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
    });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);
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

  const close = async (id: string, state: string) => {
    await ctx.pool.query('UPDATE valuations SET state = $2::valuation_state WHERE id = $1', [id, state]);
    invalidateValuation(id);
  };

  const quote = (id: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/payments/quote`,
      headers: authHeader(client.token),
    });

  const checkout = (id: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/payments/checkout`,
      headers: authHeader(client.token),
      payload: {},
    });

  it.each(STATE_GROUPS.closed)('refuses to open a checkout for a %s engagement', async (state) => {
    const vid = await createValuation(`Closed ${state} Pay Co`);
    await close(vid, state);

    const res = await checkout(vid);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/closed/i);

    // Nothing recorded: a pending payments row against a closed engagement is
    // a bill somebody would later chase.
    const { rows } = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM payments WHERE valuation_id = $1',
      [vid],
    );
    expect(rows[0]?.n).toBe(0);
  });

  /**
   * The panel is quoted the price and told which refusal, so it does not have
   * to guess — it used to say "retired" about every one of them.
   */
  it('quotes a closed engagement, marks it unpayable, and names the closure', async () => {
    const vid = await createValuation('Quoted Closed Co');
    await close(vid, 'cancelled');

    const res = await quote(vid);
    expect(res.statusCode).toBe(200);
    const body = res.json().quote;
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.payable).toBe(false);
    expect(body.payable_reason).toBe('closed');
  });

  it('still calls a retired engagement retired', async () => {
    const vid = await createValuation('Retired Not Closed Co');
    await markValuationsArchived(ctx.pool, [vid]);

    expect((await quote(vid)).json().quote.payable_reason).toBe('retired');
    const res = await checkout(vid);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/retired/i);
  });

  it('leaves a live engagement payable', async () => {
    const vid = await createValuation('Live Pay Co');
    const body = (await quote(vid)).json().quote;
    expect(body.payable).toBe(true);
    expect(body.payable_reason).toBeUndefined();
  });
});
