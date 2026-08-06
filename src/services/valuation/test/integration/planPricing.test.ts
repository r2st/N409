import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';
import { DEFAULT_PRICE_CENTS, FALLBACK_PRICE_CENTS, priceForKind } from '../../src/routes/payments.js';
import { isEntryPrice } from '../../src/domain/billing.js';
import { listPlans } from '../../src/repos/billing.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The Billing screen must not quote a price the checkout will not charge.
 *
 * `plan_limits` was seeded with per_valuation at $2,000 while the one-time flow
 * charges $990–$1,490 by product kind. Nothing connected the two, so the
 * catalogue drifted 68% above the real price of the flagship 409A and stayed
 * there — visible to every signed-in customer without a subscription, on the
 * last screen before Stripe.
 *
 * There is no single true price for the tier, so the contract asserted here is
 * the weaker, checkable one: the quoted figure is a genuine floor, and it is
 * the floor of the prices `priceForKind` can actually return. A new product
 * priced under it, or a hand-edited catalogue row, fails here rather than at a
 * customer's first charge.
 */

const dbUp = await isDbAvailable();

/** Every amount the one-time checkout can charge, across every product kind. */
const chargeableCents = (): number[] => [
  ...VALUATION_KINDS.map((kind) => priceForKind(kind)),
  FALLBACK_PRICE_CENTS,
];

describe('per-valuation plan price vs. what checkout charges', () => {
  it('quotes a floor that no product undercuts', () => {
    // Pure half — runs with or without a database, and pins the invariant to
    // the constants rather than to the seeded number.
    const cheapest = Math.min(...chargeableCents());
    expect(cheapest).toBe(FALLBACK_PRICE_CENTS);
    expect(Math.max(...chargeableCents())).toBe(Math.max(...Object.values(DEFAULT_PRICE_CENTS)));
  });

  it('treats a one-time interval as an entry price, not a quote', () => {
    expect(isEntryPrice({ interval: 'one_time' })).toBe(true);
    expect(isEntryPrice({ interval: 'year' })).toBe(false);
    expect(isEntryPrice({ interval: 'month' })).toBe(false);
  });
});

describe.skipIf(!dbUp)('plan catalogue agrees with the checkout price list', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  it('seeds per_valuation at the cheapest price a product can be charged', async () => {
    const plans = await listPlans(ctx.pool);
    const perValuation = plans.find((p) => p.tier === 'per_valuation');
    expect(perValuation, 'per_valuation plan is missing from plan_limits').toBeDefined();
    expect(perValuation!.interval).toBe('one_time');
    expect(perValuation!.price_cents).toBe(Math.min(...chargeableCents()));
  });

  it('never quotes above a price a customer could actually be charged', async () => {
    const plans = await listPlans(ctx.pool);
    for (const plan of plans.filter(isEntryPrice)) {
      // A floor above the cheapest product is the exact failure that shipped:
      // $2,000.00 on the card, $1,190.00 at the Stripe page.
      expect(plan.price_cents, `${plan.tier} quotes more than the cheapest product`).toBeLessThanOrEqual(
        Math.min(...chargeableCents()),
      );
    }
  });

  it('serves the corrected figure over /billing/plans', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(200);
    const plan = (res.json().plans as Array<{ tier: string; price_cents: number }>).find(
      (p) => p.tier === 'per_valuation',
    );
    expect(plan!.price_cents).toBe(priceForKind('fmv'));
    expect(plan!.price_cents).not.toBe(200_000);
  });
});
