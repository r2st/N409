import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  billingSummary,
  findActiveSubscription,
  recordInvoiceRefund,
  upsertSubscription,
} from '../../src/repos/billing.js';
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

  /**
   * `invoices` had no way to record money going back out until migration 0169:
   * every row is created 'paid' and nothing wrote to it again, so the revenue
   * line was gross of every refund ever issued and stayed that way.
   */
  it('nets refunds out of collected, and still states the gross', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    await ctx.pool.query(
      `INSERT INTO invoices (id, user_id, number, amount_cents, currency, status, issued_at, line_items,
                             stripe_invoice_id)
       VALUES ($1, $2, $3, 100000, 'usd', 'paid', now(), '[]', $4)`,
      [newUlid(), user.id, `INV-TEST-${Date.now()}`, 'in_refund_summary'],
    );

    const before = await billingSummary(ctx.pool);
    expect(before.collected_cents).toBe(before.gross_cents);
    expect(before.refunded_cents).toBe(0);

    await recordInvoiceRefund(ctx.pool, 'in_refund_summary', 25_000);
    const after = await billingSummary(ctx.pool);
    // The gross is what was billed and does not move — an auditor reading the
    // invoice sequence has to be able to find it.
    expect(after.gross_cents).toBe(before.gross_cents);
    expect(after.refunded_cents).toBe(25_000);
    expect(after.collected_cents).toBe(before.collected_cents - 25_000);
  });

  it('records a refund total by assignment, so a redelivery is free', async () => {
    // `amount_refunded` on the Stripe charge is a running total, so the same
    // event delivered twice writes the number that is already there.
    expect(await recordInvoiceRefund(ctx.pool, 'in_refund_summary', 25_000)).toBeNull();
    expect((await billingSummary(ctx.pool)).refunded_cents).toBe(25_000);

    // A second, larger refund is news.
    expect(await recordInvoiceRefund(ctx.pool, 'in_refund_summary', 40_000)).not.toBeNull();
    expect((await billingSummary(ctx.pool)).refunded_cents).toBe(40_000);

    // An out-of-order redelivery carrying the earlier, smaller total must not
    // walk the figure back up the revenue line.
    expect(await recordInvoiceRefund(ctx.pool, 'in_refund_summary', 25_000)).toBeNull();
    expect((await billingSummary(ctx.pool)).refunded_cents).toBe(40_000);
  });

  it('ignores a refund against an invoice this platform never issued', async () => {
    expect(await recordInvoiceRefund(ctx.pool, 'in_not_ours', 5_000)).toBeNull();
  });

  /**
   * "How did we do this month" — the question the screen could not answer,
   * because every revenue figure on it was since-the-beginning.
   *
   * Asserted as deltas rather than absolutes: the summary aggregates the whole
   * table and the tests above have already put invoices in it. What each of
   * these states is which window moved and by how much, which is the whole of
   * what the figures claim.
   */
  describe('revenue by month', () => {
    /** UTC, matching the boundary the summary states — see billingSummary. */
    const monthStart = (monthsAgo: number): Date => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
    };
    const daysAfter = (from: Date, days: number) => new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

    let seq = 0;
    const paidInvoice = async (paidAt: Date | null, amountCents: number): Promise<string> => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const stripeId = `in_month_${(seq += 1)}_${Date.now()}`;
      await ctx.pool.query(
        `INSERT INTO invoices (id, user_id, number, amount_cents, currency, status,
                               issued_at, paid_at, line_items, stripe_invoice_id)
         VALUES ($1, $2, $3, $4, 'usd', 'paid', $5, $6, '[]', $7)`,
        [
          newUlid(),
          user.id,
          `INV-MONTH-${seq}-${Date.now()}`,
          amountCents,
          // issued_at doubles as the fallback the summary coalesces to, so it
          // is deliberately set to the same instant except where a test is
          // about the fallback itself.
          paidAt ?? monthStart(0),
          paidAt,
          stripeId,
        ],
      );
      return stripeId;
    };

    it('names the window it is reporting: the first of the current UTC month', async () => {
      const summary = await billingSummary(ctx.pool);
      expect(summary.month_start).toBe(monthStart(0).toISOString().slice(0, 10));
    });

    it('puts money in the month it was collected in, and only that month', async () => {
      const before = await billingSummary(ctx.pool);
      await paidInvoice(daysAfter(monthStart(0), 0.5), 30_000);
      const afterThis = await billingSummary(ctx.pool);
      expect(afterThis.month_collected_cents).toBe(before.month_collected_cents + 30_000);
      expect(afterThis.prev_month_collected_cents).toBe(before.prev_month_collected_cents);

      await paidInvoice(daysAfter(monthStart(1), 3), 12_000);
      const afterPrev = await billingSummary(ctx.pool);
      expect(afterPrev.prev_month_collected_cents).toBe(before.prev_month_collected_cents + 12_000);
      expect(afterPrev.month_collected_cents).toBe(afterThis.month_collected_cents);
    });

    /**
     * A window is a window. Older money is still revenue and still in the
     * lifetime figure — it is simply not in either of the two months on screen,
     * which is what makes "this month" mean anything.
     */
    it('leaves older money out of both windows without losing it from collected', async () => {
      const before = await billingSummary(ctx.pool);
      await paidInvoice(daysAfter(monthStart(4), 2), 77_000);
      const after = await billingSummary(ctx.pool);
      expect(after.month_collected_cents).toBe(before.month_collected_cents);
      expect(after.prev_month_collected_cents).toBe(before.prev_month_collected_cents);
      expect(after.collected_cents).toBe(before.collected_cents + 77_000);
    });

    /**
     * The boundary itself. An invoice paid at the first instant of the month
     * belongs to it; the month before ends strictly before that instant, so
     * nothing is counted twice and nothing falls between them.
     */
    it('counts the month-start instant in the new month, not the old one', async () => {
      const before = await billingSummary(ctx.pool);
      await paidInvoice(monthStart(0), 5_000);
      await paidInvoice(new Date(monthStart(0).getTime() - 1), 7_000);
      const after = await billingSummary(ctx.pool);
      expect(after.month_collected_cents).toBe(before.month_collected_cents + 5_000);
      expect(after.prev_month_collected_cents).toBe(before.prev_month_collected_cents + 7_000);
    });

    /**
     * The month figures are the lifetime one windowed, not a second definition
     * of revenue — which is the property that lets them sit on one screen. A
     * refund therefore comes off the month the invoice was *paid* in, so a
     * prior month restates downwards rather than this month absorbing it.
     */
    it('nets a refund out of the month the invoice was paid in', async () => {
      const thisMonth = await paidInvoice(daysAfter(monthStart(0), 0.25), 50_000);
      const lastMonth = await paidInvoice(daysAfter(monthStart(1), 5), 40_000);
      const before = await billingSummary(ctx.pool);

      await recordInvoiceRefund(ctx.pool, thisMonth, 20_000);
      const afterThis = await billingSummary(ctx.pool);
      expect(afterThis.month_collected_cents).toBe(before.month_collected_cents - 20_000);
      expect(afterThis.prev_month_collected_cents).toBe(before.prev_month_collected_cents);
      expect(afterThis.collected_cents).toBe(before.collected_cents - 20_000);

      await recordInvoiceRefund(ctx.pool, lastMonth, 15_000);
      const afterPrev = await billingSummary(ctx.pool);
      expect(afterPrev.prev_month_collected_cents).toBe(before.prev_month_collected_cents - 15_000);
      expect(afterPrev.month_collected_cents).toBe(afterThis.month_collected_cents);
      expect(afterPrev.collected_cents).toBe(before.collected_cents - 35_000);
    });

    /**
     * The gross line never moves, in a window or out of it: it is what was
     * billed, and an auditor reading the invoice sequence has to be able to
     * find it.
     */
    it('leaves gross alone when a windowed figure comes down', async () => {
      const invoice = await paidInvoice(daysAfter(monthStart(0), 0.75), 9_000);
      const before = await billingSummary(ctx.pool);
      await recordInvoiceRefund(ctx.pool, invoice, 9_000);
      const after = await billingSummary(ctx.pool);
      expect(after.gross_cents).toBe(before.gross_cents);
      expect(after.month_collected_cents).toBe(before.month_collected_cents - 9_000);
    });

    /**
     * A paid invoice with no `paid_at` would otherwise be in the lifetime
     * figure and in no month at all — a row that reconciles against nothing.
     * The summary falls back to `issued_at`, which is NOT NULL.
     */
    it('falls back to issued_at, so no paid invoice is in the lifetime total and no month', async () => {
      const before = await billingSummary(ctx.pool);
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await ctx.pool.query(
        `INSERT INTO invoices (id, user_id, number, amount_cents, currency, status,
                               issued_at, paid_at, line_items, stripe_invoice_id)
         VALUES ($1, $2, $3, 6500, 'usd', 'paid', $4, NULL, '[]', $5)`,
        [
          newUlid(),
          user.id,
          `INV-NOPAIDAT-${Date.now()}`,
          daysAfter(monthStart(0), 0.1),
          `in_no_paid_at_${Date.now()}`,
        ],
      );
      const after = await billingSummary(ctx.pool);
      expect(after.collected_cents).toBe(before.collected_cents + 6_500);
      expect(after.month_collected_cents).toBe(before.month_collected_cents + 6_500);
    });
  });

  it('ignores a cancelled subscription in every figure', async () => {
    const before = await billingSummary(ctx.pool);
    await subscriber('canceled', 'annual_retainer');
    const after = await billingSummary(ctx.pool);
    expect(after).toEqual(before);
  });
});
