import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingSummary, findActiveSubscription, upsertSubscription } from '../../src/repos/billing.js';
import { BILLING_SUBSCRIPTION_STATUSES, SERVED_SUBSCRIPTION_STATUSES } from '../../src/domain/billing.js';
import { isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * The figures on the ops billing dashboard, against each other.
 *
 * They used to be three answers to "which subscriptions are live" with no
 * statement of any of them. `findActiveSubscription` and `consumeValuation` —
 * the pair that grants quota — read `('active','trialing','past_due')`; the
 * dashboard's count read `status = 'active'`; the MRR printed beside that count
 * read `('active','trialing')`. So an operator was shown a count and a total
 * that could not be reconciled, and the `past_due` accounts — being served
 * without paying, which is exactly what dunning chases — were in neither.
 *
 * These assertions are about agreement rather than about any one figure: what
 * makes the screen readable is that the counts add up to the served set and
 * that MRR covers a set the counts name.
 */

const dbUp = await isDbAvailable();

/** Annual price → the monthly figure the summary rounds it to. */
const monthly = (annualCents: number) => Math.round(annualCents / 12);
const ANNUAL_RETAINER_CENTS = 2_000_000;
const ENTERPRISE_CENTS = 5_000_000;

describe.skipIf(!dbUp)('ops billing summary', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await setupTestApp();
    // A clean slate: the summary is an aggregate over the whole table, so
    // anything another suite left behind would be inside every figure here.
    await ctx.pool.query('DELETE FROM subscriptions');
  });
  afterAll(async () => ctx?.teardown());

  const subscriber = async (status: 'active' | 'trialing' | 'past_due' | 'canceled', tier: string) => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await upsertSubscription(ctx.pool, {
      userId: user.id,
      planTier: tier,
      status,
      stripeSubscriptionId: `sub_${status}_${user.id}`,
      stripeCustomerId: `cus_${user.id}`,
    });
    return user;
  };

  it('states the two sets it uses and does not overlap them wrongly', () => {
    // `past_due` is the whole of the difference: served but not billing.
    expect([...SERVED_SUBSCRIPTION_STATUSES]).toEqual(
      expect.arrayContaining([...BILLING_SUBSCRIPTION_STATUSES]),
    );
    expect(SERVED_SUBSCRIPTION_STATUSES.filter((s) => !BILLING_SUBSCRIPTION_STATUSES.includes(s))).toEqual([
      'past_due',
    ]);
  });

  it('counts each status, and served is their sum', async () => {
    const active = await subscriber('active', 'annual_retainer');
    const trialing = await subscriber('trialing', 'annual_retainer');
    const pastDue = await subscriber('past_due', 'enterprise');
    const canceled = await subscriber('canceled', 'enterprise');

    const summary = await billingSummary(ctx.pool);
    expect(summary.active).toBe(1);
    expect(summary.trialing).toBe(1);
    expect(summary.past_due).toBe(1);
    expect(summary.served).toBe(summary.active + summary.trialing + summary.past_due);
    expect(summary.served).toBe(3);

    // The served count is not a number of its own: it is exactly the set that
    // gets quota, which is what makes it the answer to "how many accounts are
    // we carrying". A cancelled subscription is in neither.
    const served = await Promise.all(
      [active, trialing, pastDue, canceled].map((u) => findActiveSubscription(ctx.pool, u.id)),
    );
    expect(served.filter(Boolean)).toHaveLength(summary.served);
    expect(await findActiveSubscription(ctx.pool, canceled.id)).toBeNull();
  });

  it('sums MRR over exactly the subscriptions the active and trialing counts name', async () => {
    // Two annual retainers billing, one enterprise not: the past_due row is the
    // one whose money has not arrived, and counting it is how MRR drifts above
    // cash. The figure below is only reachable if the set is right — including
    // past_due would add the far larger enterprise line.
    const summary = await billingSummary(ctx.pool);
    expect(summary.mrr_cents).toBe(monthly(ANNUAL_RETAINER_CENTS) * 2);
    expect(summary.mrr_cents).not.toBe(monthly(ANNUAL_RETAINER_CENTS) * 2 + monthly(ENTERPRISE_CENTS));
  });

  it('ignores a cancelled subscription in every figure', async () => {
    const before = await billingSummary(ctx.pool);
    await subscriber('canceled', 'annual_retainer');
    const after = await billingSummary(ctx.pool);
    expect(after).toEqual(before);
  });
});
