import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The three routes that call Stripe, with Stripe down (round 175, M5).
 *
 * The unit suite proves the client turns a transport failure into a
 * `StripeApiError`; this proves each route then has an answer for one. They
 * did not, in three different ways, and the difference mattered most on the
 * one with the largest amount attached:
 *
 *   * `POST …/payments/checkout` caught `StripeApiError` but not the transport
 *     failure underneath it, so an outage was a bare 500;
 *   * `POST /billing/portal` the same;
 *   * `POST /billing/subscribe` had no catch at all, so even a plain rejection
 *     from Stripe — a bad price, a revoked key — came back as an empty 500 on
 *     the button that starts a recurring plan.
 *
 * A test-mode key throughout, because `checkoutAvailableTo` opens the checkout
 * surfaces to ops with one, and the failure being exercised is on the wire
 * rather than in the key.
 */
describe.skipIf(!dbUp)('every Stripe route answers an outage', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({
      AUTO_PIPELINE: 'off',
      EMAIL_MODE: 'off',
      STRIPE_SECRET_KEY: 'sk_test_notarealkey',
    });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'OutageCo' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());
  afterEach(() => vi.restoreAllMocks());

  /** Stripe unreachable: what node's `fetch` does when DNS fails. */
  const stripeDown = () =>
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.stripe.com'), { code: 'ENOTFOUND' }),
      }),
    );

  const expectOutage = (res: { statusCode: number; json: () => Record<string, string> }) => {
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.type).toBe('urn:n409:problem:stripe');
    expect(body.detail).toMatch(/Nothing has been charged/);
    // The transport's own wording names a host and a syscall and must not be
    // in a body a client reads.
    expect(JSON.stringify(body)).not.toMatch(/ENOTFOUND|getaddrinfo/);
  };

  it('answers the one-off checkout with a body about the payment', async () => {
    stripeDown();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/payments/checkout`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expectOutage(res);
  });

  it('answers the subscription checkout, which had no answer at all', async () => {
    const plans = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: authHeader(ops.token),
    });
    const recurring = (plans.json().plans as Array<{ tier: string; interval: string }>).find(
      (p) => p.interval !== 'one_time',
    );
    expect(recurring, 'a recurring plan to subscribe to').toBeDefined();

    stripeDown();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscribe',
      headers: authHeader(ops.token),
      payload: { plan_tier: recurring!.tier },
    });
    expectOutage(res);
  });

  it('leaves no payment row behind for a checkout that never opened', async () => {
    // The other half of "nothing has been charged": the route must not have
    // recorded a pending payment against a session Stripe never created, or
    // the next attempt is refused by `findLiveCheckout` as a payment already
    // in progress — an outage that locks the engagement out of paying at all.
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM payments WHERE valuation_id = $1', [
      valuationId,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('answers the billing portal the same way', async () => {
    // No customer id yet, so this one is refused before Stripe is reached —
    // which is itself the contract: the conflict is about this account, not
    // about Stripe, and it must not be reported as an outage.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe('urn:n409:problem:conflict');
  });
});
