import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMoneyCents } from '../../src/domain/billing.js';
import {
  findInvoiceByStripeId,
  findPlan,
  findPlanForSubscription,
  recordPaidInvoice,
  upsertSubscription,
} from '../../src/repos/billing.js';
import { listNotifications } from '../../src/repos/notifications.js';
import { interceptPoolQueries, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

/**
 * Billing data flow (R184): one figure traced from the Stripe event that
 * carried it to the surface that states it, and the places the trace broke.
 *
 * Each case below is a value that survived every individual check and arrived
 * wrong, or an event that could not be stored and was answered in a way that
 * made the loss permanent. They are grouped by the thing that flows — the
 * quota, the invoice number, the amount, the currency — rather than by the
 * handler, because none of these is visible from inside one handler.
 */

const dbUp = await isDbAvailable();
const WEBHOOK_SECRET = 'whsec_data_flow_r184';
const uniq = () => Math.random().toString(36).slice(2, 10);

describe.skipIf(!dbUp)('billing data flow', () => {
  let ctx: TestApp;

  const signed = (payload: string) => {
    const t = Math.floor(Date.now() / 1000);
    const mac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
    return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` };
  };

  const deliver = (event: Record<string, unknown>) => {
    const body = JSON.stringify({ created: Math.floor(Date.now() / 1000), ...event });
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: signed(body),
      payload: body,
    });
  };

  const invoiceEvent = (id: string, object: Record<string, unknown>) => ({
    id: `evt_${uniq()}`,
    type: 'invoice.paid',
    data: { object: { id, currency: 'usd', ...object } },
  });

  /** Every sequence counter, so a burnt number is visible as a jump. */
  const sequences = async () => {
    const { rows } = await ctx.pool.query<{ period: string; seq: number }>(
      'SELECT period, seq FROM invoice_sequences ORDER BY period',
    );
    return rows.map((r) => `${r.period}:${r.seq}`).join(',');
  };

  beforeAll(async () => {
    ctx = await setupTestApp({
      STRIPE_SECRET_KEY: 'sk_live_data_flow_r184',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      AUTO_PIPELINE: 'off',
      EMAIL_MODE: 'off',
    });
  });
  afterAll(async () => ctx?.teardown());

  // ── The quota: what the plan says, and what enforcement does ──────────────

  describe('the plan a subscription is on', () => {
    /**
     * Retiring a tier from the catalogue is an ordinary price-list change and
     * says nothing about the accounts already on it. `/me/subscription` looked
     * the subscriber's own plan up through `findPlan`, which filters
     * `active = true`, so a deactivated tier came back null — and `usageView`
     * reads a null limit as *unlimited*.
     *
     * The enforcement never agreed: `consumeValuation` joins `plan_limits` with
     * no `active` filter, as does the ops dashboard. So the subscriber was told
     * they had unlimited valuations and `remaining: null` while the thirteenth
     * was refused with a 402 the screen said could not happen, and ops looking
     * at the same account saw `12 / 12`.
     */
    it('is reported to the subscriber even after the tier leaves the catalogue', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'active',
        stripeSubscriptionId: `sub_retired_${uniq()}`,
      });
      await ctx.pool.query('UPDATE subscriptions SET valuations_used = 12 WHERE user_id = $1', [user.id]);
      await ctx.pool.query("UPDATE plan_limits SET active = false WHERE tier = 'annual_retainer'");
      try {
        const view = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/me/subscription',
          headers: { authorization: `Bearer ${user.token}` },
        });
        const body = view.json();
        expect(body.plan?.tier).toBe('annual_retainer');
        expect(body.usage).toMatchObject({ limit: 12, used: 12, remaining: 0, unlimited: false });

        // And it agrees with what actually happens when they try to use it.
        const create = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: { authorization: `Bearer ${user.token}` },
          payload: { kind: '409a', company_name: 'Retired Tier Co' },
        });
        expect(create.statusCode).toBe(402);
        expect(body.usage.exhausted).toBe(true);
      } finally {
        await ctx.pool.query("UPDATE plan_limits SET active = true WHERE tier = 'annual_retainer'");
      }
    });

    it('keeps the two lookups distinct: a retired tier cannot be newly bought', async () => {
      await ctx.pool.query("UPDATE plan_limits SET active = false WHERE tier = 'annual_retainer'");
      try {
        // The catalogue read refuses it — nobody may start a plan that is off
        // sale — and the subscription read still resolves it.
        expect(await findPlan(ctx.pool, 'annual_retainer')).toBeNull();
        expect((await findPlanForSubscription(ctx.pool, 'annual_retainer'))?.valuation_limit).toBe(12);
      } finally {
        await ctx.pool.query("UPDATE plan_limits SET active = true WHERE tier = 'annual_retainer'");
      }
    });
  });

  // ── The invoice number: monotonic, and spent only by a stored invoice ─────

  describe('invoice numbering', () => {
    /**
     * A number is allocated from a counter that only goes up, so anything that
     * fails after the allocation leaves a gap — and the numbering is what an
     * auditor reads as a count of what was billed.
     *
     * The amount is the reachable version of that. `invoices.amount_cents` is
     * an `integer` of whole minor units, and the handler passed
     * `Number(obj.amount_paid ?? …)` to it unchecked: a fraction was refused by
     * the driver *after* the number had been allocated, and answered to Stripe
     * as a 500 — which is not an answer, it is a delivery Stripe retries for
     * days. Each retry burned another number, so one malformed event walked the
     * sequence forward indefinitely with nothing recorded and nobody told.
     */
    it('refuses an amount that is not whole minor units, and spends no number on it', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const before = await sequences();
      const res = await deliver(
        invoiceEvent(`in_fractional_${uniq()}`, {
          amount_paid: 1234.56,
          metadata: { user_id: user.id },
        }),
      );
      // 400, not 500: no redelivery can make a fractional cent storable.
      expect(res.statusCode).toBe(400);
      expect(await sequences()).toBe(before);
    });

    it('refuses an amount that is not a number at all', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const before = await sequences();
      const res = await deliver(
        invoiceEvent(`in_nan_${uniq()}`, { amount_paid: 'lots', metadata: { user_id: user.id } }),
      );
      expect(res.statusCode).toBe(400);
      expect(await sequences()).toBe(before);
    });

    /**
     * `invoices.user_id` is a `ulid` with a foreign key to `users`, and the
     * metadata that fed it is whatever the event says. A webhook endpoint
     * receives every invoice on the Stripe account, so an id in neither shape
     * is an ordinary thing to be sent — and it was the same permanent
     * 5xx-and-burn-a-number loop as the amount above.
     */
    it('ignores an invoice attributed to a user it has never issued, and spends no number', async () => {
      const before = await sequences();
      const bogus = await deliver(
        invoiceEvent(`in_bad_user_${uniq()}`, { amount_paid: 1000, metadata: { user_id: 'not-a-ulid' } }),
      );
      expect(bogus.statusCode).toBe(200);
      const missing = await deliver(
        invoiceEvent(`in_gone_user_${uniq()}`, {
          amount_paid: 1000,
          metadata: { user_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        }),
      );
      expect(missing.statusCode).toBe(200);
      expect(await sequences()).toBe(before);
    });

    /**
     * Stripe sends `invoice.paid` *and* `invoice.payment_succeeded` for one
     * payment, with different event ids the ledger cannot collapse, and fans
     * them out together. The route's read-then-write guard let both deliveries
     * see no invoice and both allocate; the `ON CONFLICT` then declined the
     * loser's insert, so the ordinary concurrent renewal cost two numbers and
     * produced one invoice.
     *
     * Driven at the repo rather than through two `inject`s, which serialise —
     * see the note on staging races in billingStateMachine.test.ts.
     */
    it('spends one number when both events for one payment arrive at once', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const stripeInvoiceId = `in_concurrent_${uniq()}`;
      const input = {
        userId: user.id,
        subscriptionId: null,
        amountCents: 990_000,
        currency: 'usd',
        periodStart: null,
        periodEnd: null,
        lineItems: [{ description: 'Annual retainer', amount_cents: 990_000 }],
        stripeInvoiceId,
      };
      const before = await sequences();
      const results = await Promise.all([
        recordPaidInvoice(ctx.pool, input),
        recordPaidInvoice(ctx.pool, input),
      ]);

      // One writer, one row, one number.
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.invoice.id)).size).toBe(1);
      const { rows } = await ctx.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM invoices WHERE stripe_invoice_id = $1',
        [stripeInvoiceId],
      );
      expect(rows[0]!.n).toBe('1');

      const period = new Date().toISOString().slice(0, 7).replace('-', '');
      const seqOf = (snapshot: string) =>
        Number(
          snapshot
            .split(',')
            .find((s) => s.startsWith(`${period}:`))
            ?.split(':')[1] ?? 0,
        );
      expect(seqOf(await sequences()) - seqOf(before)).toBe(1);
    });

    /**
     * The transient half of the same property. A failure during the write is
     * exactly what the 5xx-for-redelivery design is for, and the redelivery
     * must find the numbering where it left it.
     */
    it('leaves no gap when the write fails and Stripe brings the event back', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const stripeInvoiceId = `in_retried_${uniq()}`;
      const event = invoiceEvent(stripeInvoiceId, { amount_paid: 500_000, metadata: { user_id: user.id } });
      const before = await sequences();

      const restore = interceptPoolQueries(ctx.pool, (sql) => {
        if (sql.includes('INSERT INTO invoices')) throw new Error('connection terminated');
        return undefined;
      });
      try {
        expect((await deliver(event)).statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        restore();
      }
      expect(await sequences()).toBe(before);

      expect((await deliver(event)).statusCode).toBe(200);
      const invoice = await findInvoiceByStripeId(ctx.pool, stripeInvoiceId);
      expect(invoice?.amount_cents).toBe(500_000);
      // The redelivery took the number the failed attempt did not.
      expect(invoice!.number.endsWith('0001') || (await sequences()) !== before).toBe(true);
    });

    /**
     * The number states a month and the row states an instant, and they were
     * produced by two different clocks: the number from `new Date()` here, the
     * row from the column's `now()` default at COMMIT. They must name the same
     * month or the invoice is filed under one and numbered under another.
     */
    it('numbers an invoice in the month it says it was issued in', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const { invoice } = await recordPaidInvoice(ctx.pool, {
        userId: user.id,
        subscriptionId: null,
        amountCents: 12_345,
        currency: 'usd',
        periodStart: null,
        periodEnd: null,
        lineItems: [],
        stripeInvoiceId: `in_month_${uniq()}`,
        issuedAt: new Date('2031-03-31T23:59:59.500Z'),
      });
      expect(invoice.number).toMatch(/^INV-203103-\d{4}$/);
      expect(invoice.issued_at.toISOString().slice(0, 7)).toBe('2031-03');
    });
  });

  // ── The currency: carried with the amount, or not at all ─────────────────

  describe('currency', () => {
    /**
     * The dunning notice is the one message whose whole job is to tell the
     * subscriber which payment to go and fix, and it named the amount in USD
     * whatever the invoice was actually billed in — the currency sits on the
     * same Stripe object as the amount and was simply not read.
     */
    it('states a declined renewal in the currency it was billed in', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const stripeSubId = `sub_eur_${uniq()}`;
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'active',
        stripeSubscriptionId: stripeSubId,
      });

      const res = await deliver({
        id: `evt_${uniq()}`,
        type: 'invoice.payment_failed',
        data: {
          object: { id: `in_${uniq()}`, subscription: stripeSubId, amount_due: 48_000, currency: 'eur' },
        },
      });
      expect(res.statusCode).toBe(200);

      const notice = (await listNotifications(ctx.pool, user.id, {})).find(
        (n) => n.type === 'subscription_payment_failed',
      );
      expect(notice?.body).toContain('€480.00');
      expect(notice?.body).not.toContain('$480.00');
    });

    /**
     * `Intl.NumberFormat` throws on a code it cannot parse, and every currency
     * reaching the formatter came off the wire as `String(obj.currency)` into a
     * `text` column with no constraint. So an unparseable code was not a badly
     * formatted figure, it was an exception out of the invoice PDF, the refund
     * notification and the dunning message. The browser's formatter has fallen
     * back rather than thrown since it was written; this is the same rule on
     * the server, so one figure cannot have two answers to "is it renderable".
     */
    it('renders money rather than throwing on a currency code Intl cannot parse', () => {
      expect(formatMoneyCents(119_000, 'usd')).toBe('$1,190.00');
      expect(() => formatMoneyCents(119_000, 'not-a-currency')).not.toThrow();
      expect(formatMoneyCents(119_000, 'not-a-currency')).toContain('1,190.00');
      expect(formatMoneyCents(119_000, '')).toBe('$1,190.00');
    });
  });

  // ── Access: what each status actually grants ─────────────────────────────

  describe('feature access follows the status', () => {
    /**
     * A failed renewal does *not* cut the account off, and that is a decision
     * rather than an omission: `SERVED_SUBSCRIPTION_STATUSES` includes
     * `past_due` because dunning exists to recover an expired card, and locking
     * the customer out is what makes that unrecoverable. Pinned here because
     * "a failed payment limits access" is the intuitive reading and the code
     * says the opposite on purpose — the limit that does apply is the plan's
     * quota, which the failed renewal has not reset.
     */
    it('keeps serving a subscriber whose renewal was declined', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const stripeSubId = `sub_pastdue_${uniq()}`;
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'active',
        stripeSubscriptionId: stripeSubId,
      });
      await deliver({
        id: `evt_${uniq()}`,
        type: 'invoice.payment_failed',
        data: { object: { id: `in_${uniq()}`, subscription: stripeSubId, amount_due: 2_000_000 } },
      });

      const view = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/subscription',
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(view.json().subscription.status).toBe('past_due');
      expect(view.json().usage).toMatchObject({ limit: 12, exhausted: false });

      const create = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: { authorization: `Bearer ${user.token}` },
        payload: { kind: '409a', company_name: 'Past Due Co' },
      });
      expect(create.statusCode).toBe(201);
    });

    /**
     * ...and says which period the quota it is showing belongs to.
     *
     * Stripe advances `current_period_start` when it *raises* the renewal
     * invoice, not when the invoice settles, so the declined renewal above
     * moves the period and R240's gate leaves the counter on the last period
     * that was paid for. The two are then figures about different periods, and
     * `/me/subscription` puts them side by side: the used count, and the date
     * the subscription renews. A subscriber with none left reads a plan spent
     * inside a period they cannot have spent it in, and nothing on the payload
     * said that settling the renewal is what brings the allowance back.
     *
     * The data export was given `quota_period_start` when the column was added
     * and this payload was not, so the fact was exportable and unstated on the
     * screen the customer actually reads.
     */
    it('says when the usage it reports is counted against an earlier period', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const stripeSubId = `sub_quota_period_${uniq()}`;
      const start = Math.floor(Date.now() / 1000) - 2_592_000;
      const renewal = (periodStart: number, status: string) =>
        deliver({
          id: `evt_${uniq()}`,
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: stripeSubId,
              status,
              current_period_start: periodStart,
              current_period_end: periodStart + 2_592_000,
              metadata: { user_id: user.id, plan_tier: 'annual_retainer' },
            },
          },
        });
      const view = async () =>
        (
          await ctx.app.inject({
            method: 'GET',
            url: '/api/v1/me/subscription',
            headers: { authorization: `Bearer ${user.token}` },
          })
        ).json();

      await renewal(start, 'active');
      // The ordinary case: one period, one counter, nothing to explain.
      expect((await view()).quota_awaiting_renewal).toBe(false);

      await ctx.pool.query(
        'UPDATE subscriptions SET valuations_used = 12 WHERE stripe_subscription_id = $1',
        [stripeSubId],
      );
      // The renewal is raised and declined: the period moves, the money does not.
      await renewal(start + 2_592_000, 'past_due');
      const lapsed = await view();
      expect(lapsed.subscription.status).toBe('past_due');
      expect(lapsed.usage).toMatchObject({ used: 12, remaining: 0, exhausted: true });
      expect(lapsed.quota_awaiting_renewal).toBe(true);

      // The card is replaced. The same period, now paid for, grants the quota —
      // and there is nothing left to explain.
      await renewal(start + 2_592_000, 'active');
      const recovered = await view();
      expect(recovered.usage).toMatchObject({ used: 0, remaining: 12 });
      expect(recovered.quota_awaiting_renewal).toBe(false);
    });

    /**
     * The quota is spent before the valuation exists, and the two are separate
     * statements.
     *
     * The gate has to answer before any work is done, and `createValuation` is
     * its own transaction — so anything that makes the insert fail leaves the
     * subscriber one valuation poorer with nothing to show for it, and there is
     * no way back from the product: the counter is only ever reset by a
     * renewal. On an annual retainer the twelfth valuation could be spent on a
     * 500 and the customer would wait a year to get it.
     */
    it('gives the quota back when the valuation it was charged for is never created', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'active',
        stripeSubscriptionId: `sub_release_${uniq()}`,
      });
      const used = async () =>
        (
          await ctx.pool.query<{ valuations_used: number }>(
            'SELECT valuations_used FROM subscriptions WHERE user_id = $1',
            [user.id],
          )
        ).rows[0]?.valuations_used;

      const create = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: { authorization: `Bearer ${user.token}` },
          payload: { kind: '409a', company_name: 'Rolled Back Co' },
        });

      expect((await create()).statusCode).toBe(201);
      expect(await used()).toBe(1);

      const restore = interceptPoolQueries(ctx.pool, (sql) => {
        if (sql.includes('INSERT INTO valuations')) throw new Error('connection terminated');
        return undefined;
      });
      try {
        expect((await create()).statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        restore();
      }
      // Not 2: the valuation that second request paid for does not exist.
      expect(await used()).toBe(1);

      // And the allowance is genuinely spendable again rather than merely
      // decremented — the gate reads the same counter.
      expect((await create()).statusCode).toBe(201);
      expect(await used()).toBe(2);
    });

    /**
     * And the other end of it. Cancellation is terminal on the row, so coming
     * back is a *new* subscription with a new Stripe id — the quota that comes
     * with it has to be the new plan's, counted from zero, and the resubscribe
     * has to be allowed at all (the route refuses a second one while any served
     * subscription exists, and a canceled row must not count).
     */
    it('restores access, and a fresh quota, when a canceled subscriber comes back', async () => {
      const user = await seedUser(ctx, { roles: ['valuation_user'] });
      const first = `sub_gone_${uniq()}`;
      await upsertSubscription(ctx.pool, {
        userId: user.id,
        planTier: 'annual_retainer',
        status: 'active',
        stripeSubscriptionId: first,
        stripeCustomerId: `cus_${uniq()}`,
      });
      await ctx.pool.query(
        'UPDATE subscriptions SET valuations_used = 12 WHERE stripe_subscription_id = $1',
        [first],
      );
      await deliver({
        id: `evt_${uniq()}`,
        type: 'customer.subscription.deleted',
        data: { object: { id: first } },
      });

      const second = `sub_back_${uniq()}`;
      await deliver({
        id: `evt_${uniq()}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_${uniq()}`,
            mode: 'subscription',
            payment_status: 'paid',
            subscription: second,
            customer: `cus_${uniq()}`,
            metadata: { user_id: user.id, plan_tier: 'enterprise' },
          },
        },
      });

      const view = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/subscription',
        headers: { authorization: `Bearer ${user.token}` },
      });
      const body = view.json();
      expect(body.subscription.stripe_subscription_id).toBe(second);
      expect(body.subscription.status).toBe('active');
      expect(body.plan.tier).toBe('enterprise');
      // Not the 12 the cancelled row was carrying.
      expect(body.usage).toMatchObject({ used: 0, unlimited: true, exhausted: false });

      // The cancelled row is still on file, and still cancelled.
      const { rows } = await ctx.pool.query<{ status: string; canceled_at: Date | null }>(
        'SELECT status, canceled_at FROM subscriptions WHERE stripe_subscription_id = $1',
        [first],
      );
      expect(rows[0]?.status).toBe('canceled');
      expect(rows[0]?.canceled_at).toBeTruthy();
    });
  });

  // ── The amount, end to end ───────────────────────────────────────────────

  /**
   * The trace the rest of this file is about, followed once without incident:
   * `amount_paid` on the Stripe event, the `amount_cents` column, and the
   * figure `/me/subscription` hands the invoice table. Integer minor units at
   * every step, and the same integer at every step — a conversion anywhere in
   * that chain is a hundredfold error that reads as a formatting choice.
   */
  it('carries a settled amount from the Stripe event to the customer’s invoice list unchanged', async () => {
    const user = await seedUser(ctx, { roles: ['valuation_user'] });
    const stripeSubId = `sub_trace_${uniq()}`;
    const stripeInvoiceId = `in_trace_${uniq()}`;
    await upsertSubscription(ctx.pool, {
      userId: user.id,
      planTier: 'annual_retainer',
      status: 'active',
      stripeSubscriptionId: stripeSubId,
    });

    expect(
      (
        await deliver(
          invoiceEvent(stripeInvoiceId, {
            subscription: stripeSubId,
            amount_paid: 2_000_000,
            description: 'Annual retainer',
          }),
        )
      ).statusCode,
    ).toBe(200);

    const stored = await findInvoiceByStripeId(ctx.pool, stripeInvoiceId);
    expect(stored?.amount_cents).toBe(2_000_000);
    expect(Number.isInteger(stored!.amount_cents)).toBe(true);
    expect(stored!.line_items[0]!.amount_cents).toBe(2_000_000);

    const view = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/subscription',
      headers: { authorization: `Bearer ${user.token}` },
    });
    const shown = (view.json().invoices as Array<{ amount_cents: number; currency: string }>)[0]!;
    expect(shown.amount_cents).toBe(2_000_000);
    expect(shown.currency).toBe('usd');
    // What the reader sees, from the figure that was stored.
    expect(formatMoneyCents(shown.amount_cents, shown.currency)).toBe('$20,000.00');
  });
});
