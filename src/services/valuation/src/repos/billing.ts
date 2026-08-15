import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { invoicePeriod, type PlanLimit, type InvoiceLineItem } from '../domain/billing.js';

// ── Plans ────────────────────────────────────────────────────────────────────

export async function listPlans(pool: pg.Pool): Promise<PlanLimit[]> {
  const { rows } = await pool.query<PlanLimit>(
    `SELECT tier, name, valuation_limit, price_cents, currency, interval
       FROM plan_limits WHERE active = true ORDER BY sort_order ASC`,
  );
  return rows;
}

export async function findPlan(pool: pg.Pool, tier: string): Promise<PlanLimit | null> {
  const { rows } = await pool.query<PlanLimit>(
    `SELECT tier, name, valuation_limit, price_cents, currency, interval
       FROM plan_limits WHERE tier = $1 AND active = true`,
    [tier],
  );
  return rows[0] ?? null;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_tier: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  valuations_used: number;
  created_at: Date;
  canceled_at: Date | null;
}

export async function findActiveSubscription(pool: pg.Pool, userId: string): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<SubscriptionRow>(
    `SELECT * FROM subscriptions
      WHERE user_id = $1 AND status IN ('active', 'trialing', 'past_due')
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Create or update the user's subscription for a plan (webhook-driven).
 *
 * A cancellation is never undone here. Stripe does not guarantee the order it
 * delivers events in, and a `customer.subscription.updated` generated before
 * the cancellation can land after it — a retry after a failed delivery is the
 * ordinary way that happens. This wrote `status = EXCLUDED.status`
 * unconditionally, so that one stale event flipped a cancelled row back to
 * 'active' and cleared `canceled_at`. `findActiveSubscription` then returned it
 * and `consumeValuation` charged against its quota: a subscriber who cancelled
 * kept the plan, and nothing in the product said otherwise until the next
 * Stripe event happened to correct it.
 *
 * Cancellation is terminal in Stripe too — a cancelled subscription cannot be
 * reactivated, a resubscribe issues a new subscription id — so "already
 * cancelled" is never stale information, whatever order events arrive in. That
 * is the same invariant {@link markSubscriptionPastDue} already enforces on its
 * own path; it just did not hold on this one.
 */
export async function upsertSubscription(
  pool: pg.Pool,
  input: {
    userId: string;
    planTier: string;
    status?: SubscriptionRow['status'];
    stripeSubscriptionId?: string | null;
    stripeCustomerId?: string | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
  },
): Promise<SubscriptionRow> {
  // Stripe subscription id is the natural key when present; otherwise upsert on
  // the user's single active row.
  if (input.stripeSubscriptionId) {
    const { rows } = await pool.query<SubscriptionRow>(
      `INSERT INTO subscriptions
         (id, user_id, plan_tier, status, stripe_subscription_id, stripe_customer_id,
          current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         plan_tier = EXCLUDED.plan_tier,
         status = EXCLUDED.status,
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
         -- COALESCE for the same reason as the customer id above, and it is
         -- load-bearing here rather than tidy. Not every caller knows the
         -- billing period: a Checkout Session object carries no period fields
         -- at all, and Stripe guarantees nothing about whether
         -- checkout.session.completed is delivered before or after the
         -- customer.subscription.created for the same checkout. Assigning
         -- EXCLUDED unconditionally let the session event blank a period the
         -- subscription event had already written — and then, because the
         -- usage reset below keys off the period having changed, hand the
         -- subscriber a fresh quota for free. A subscription's period never
         -- becomes unknown, so "no period in this event" always means "leave
         -- the one on file alone".
         current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
         current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
         -- New billing period resets usage — compared against the value that
         -- is actually being written, not the one that was passed in.
         valuations_used = CASE
           WHEN COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start)
                IS DISTINCT FROM subscriptions.current_period_start
           THEN 0 ELSE subscriptions.valuations_used END,
         canceled_at = CASE WHEN EXCLUDED.status = 'canceled' THEN now() ELSE NULL END
       WHERE subscriptions.status <> 'canceled'
       RETURNING *`,
      [
        newUlid(),
        input.userId,
        input.planTier,
        input.status ?? 'active',
        input.stripeSubscriptionId,
        input.stripeCustomerId ?? null,
        input.periodStart ?? null,
        input.periodEnd ?? null,
      ],
    );
    if (rows[0]) return rows[0];

    // No row came back, so the DO UPDATE's WHERE declined it: the subscription
    // on file is cancelled and stays that way. The caller still asked for the
    // row, and it exists — returning it unchanged keeps this a no-op rather
    // than an error, which is what a stale event deserves.
    const existing = await findSubscriptionByStripeId(pool, input.stripeSubscriptionId);
    if (existing) return existing;

    // Neither inserted, nor updated, nor found. The only other UNIQUE on the
    // table is the one we conflicted on, so this means the row was deleted
    // between the two statements — not recoverable here, and not something to
    // hide behind a non-null assertion.
    throw new Error(
      `upsertSubscription: no row written or found for stripe_subscription_id=${input.stripeSubscriptionId}`,
    );
  }
  const { rows } = await pool.query<SubscriptionRow>(
    `INSERT INTO subscriptions (id, user_id, plan_tier, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      newUlid(),
      input.userId,
      input.planTier,
      input.status ?? 'active',
      input.periodStart ?? null,
      input.periodEnd ?? null,
    ],
  );
  return rows[0]!;
}

/** The subscription a Stripe subscription id names, whatever state it is in. */
export async function findSubscriptionByStripeId(
  pool: pg.Pool,
  stripeSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<SubscriptionRow>(
    'SELECT * FROM subscriptions WHERE stripe_subscription_id = $1',
    [stripeSubscriptionId],
  );
  return rows[0] ?? null;
}

export async function cancelSubscription(pool: pg.Pool, stripeSubscriptionId: string): Promise<void> {
  await pool.query(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = now()
      WHERE stripe_subscription_id = $1`,
    [stripeSubscriptionId],
  );
}

/**
 * A renewal that did not go through.
 *
 * Written from `invoice.payment_failed` rather than left to
 * `customer.subscription.updated`, because that handler can only act when the
 * Stripe subscription carries our metadata — and a subscription created before
 * that metadata was attached, or through the Stripe dashboard, carries none. A
 * lapsed card should mark the account past due either way.
 *
 * Never touches an already-canceled row: a failed invoice arriving after the
 * subscription ended must not resurrect it into a billable state.
 */
export async function markSubscriptionPastDue(
  pool: pg.Pool,
  stripeSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<SubscriptionRow>(
    `UPDATE subscriptions SET status = 'past_due'
      WHERE stripe_subscription_id = $1 AND status <> 'canceled'
      RETURNING *`,
    [stripeSubscriptionId],
  );
  return rows[0] ?? null;
}

/**
 * The Stripe customer to open the billing portal for.
 *
 * Not restricted to an *active* subscription: someone who has just cancelled
 * still needs the portal to pull their invoices, and someone whose card lapsed
 * is by definition not in good standing but is exactly who needs to reach it.
 * Most recent first, since a resubscribe creates a new row.
 */
export async function findStripeCustomerId(pool: pg.Pool, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ stripe_customer_id: string }>(
    `SELECT stripe_customer_id FROM subscriptions
      WHERE user_id = $1 AND stripe_customer_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0]?.stripe_customer_id ?? null;
}

/**
 * Atomically consume one valuation against the active subscription's limit.
 * Returns false (and consumes nothing) when the limit is already exhausted.
 * Unlimited plans always succeed.
 */
export async function consumeValuation(pool: pg.Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `UPDATE subscriptions s
        SET valuations_used = valuations_used + 1
       FROM plan_limits p
      WHERE s.user_id = $1
        AND s.status IN ('active', 'trialing', 'past_due')
        AND p.tier = s.plan_tier
        AND (p.valuation_limit IS NULL OR s.valuations_used < p.valuation_limit)
      RETURNING true AS ok`,
    [userId],
  );
  return rows.length > 0;
}

export type AdminSubscription = SubscriptionRow & {
  email: string;
  plan_name: string;
  valuation_limit: number | null;
  price_cents: number;
  interval: 'one_time' | 'month' | 'year';
};

export const SUBSCRIPTION_PAGE_LIMIT = 500;

/**
 * Every subscription on the platform, newest first — a page of it.
 *
 * One row per paying account and never deleted, so this table's size is the
 * business's own growth curve; the admin billing screen was reading all of it,
 * joined to `users` and `plan_limits`, on every load. Truncation is reported
 * rather than hidden, because "how many customers do we have" is a question
 * somebody asks of this screen and a silently short list answers it wrongly.
 * The page is not the ledger: {@link listAllInvoices} and the counters the
 * screen shows beside it are their own queries.
 */
export async function listAllSubscriptions(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ subscriptions: AdminSubscription[]; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? SUBSCRIPTION_PAGE_LIMIT, 1), SUBSCRIPTION_PAGE_LIMIT);
  const { rows } = await pool.query(
    `SELECT s.*, u.email, p.name AS plan_name, p.valuation_limit, p.price_cents, p.interval
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN plan_limits p ON p.tier = s.plan_tier
      ORDER BY s.created_at DESC
      LIMIT $1`,
    [limit + 1],
  );
  const subscriptions = rows as AdminSubscription[];
  return { subscriptions: subscriptions.slice(0, limit), truncated: subscriptions.length > limit };
}

// ── Invoices ──────────────────────────────────────────────────────────────────

export interface InvoiceRow {
  id: string;
  number: string;
  user_id: string;
  subscription_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'draft' | 'open' | 'paid' | 'void';
  period_start: Date | null;
  period_end: Date | null;
  line_items: InvoiceLineItem[];
  stripe_invoice_id: string | null;
  issued_at: Date;
  paid_at: Date | null;
  created_at: Date;
}

/**
 * Next monotonic invoice sequence for the issue month (for the number).
 *
 * Allocated by incrementing a counter row rather than counting the month's
 * invoices, because `invoices.number` is UNIQUE and count-then-insert is not
 * atomic: concurrent renewals all counted the same N and collided on the number
 * built from it (migration 0096). `ON CONFLICT DO UPDATE` locks the row, so
 * concurrent allocators serialise and each leaves with its own value.
 *
 * The period defaults to the current UTC month, matching the segment
 * {@link invoiceNumber} puts in the number — pass the issuing date's period
 * explicitly when the two must agree across a month boundary.
 */
export async function nextInvoiceSequence(
  pool: pg.Pool,
  period: string = invoicePeriod(new Date().toISOString()),
): Promise<number> {
  const { rows } = await pool.query<{ seq: number }>(
    `INSERT INTO invoice_sequences (period, seq) VALUES ($1, 1)
     ON CONFLICT (period) DO UPDATE SET seq = invoice_sequences.seq + 1
     RETURNING seq`,
    [period],
  );
  return rows[0]!.seq;
}

export async function createInvoice(
  pool: pg.Pool,
  input: {
    number: string;
    userId: string;
    subscriptionId?: string | null;
    amountCents: number;
    currency: string;
    status?: InvoiceRow['status'];
    periodStart?: Date | null;
    periodEnd?: Date | null;
    lineItems: InvoiceLineItem[];
    stripeInvoiceId?: string | null;
    paidAt?: Date | null;
  },
): Promise<InvoiceRow> {
  const { rows } = await pool.query<InvoiceRow>(
    `INSERT INTO invoices
       (id, number, user_id, subscription_id, amount_cents, currency, status,
        period_start, period_end, line_items, stripe_invoice_id, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stripe_invoice_id) DO NOTHING
     RETURNING *`,
    [
      newUlid(),
      input.number,
      input.userId,
      input.subscriptionId ?? null,
      input.amountCents,
      input.currency,
      input.status ?? 'open',
      input.periodStart ?? null,
      input.periodEnd ?? null,
      JSON.stringify(input.lineItems),
      input.stripeInvoiceId ?? null,
      input.paidAt ?? null,
    ],
  );
  if (rows[0]) return rows[0];

  // DO NOTHING returns no row, so the insert was a no-op: this Stripe invoice
  // is already recorded. Stripe delivers at least once, so that is an expected
  // redelivery rather than an error — return what is already there, which makes
  // this idempotent and keeps the signature honest. It previously returned
  // `rows[0]!`, i.e. undefined behind a non-null assertion, so a caller reading
  // the result got a TypeError on the redelivery path only.
  const existing = await findInvoiceByStripeId(pool, input.stripeInvoiceId);
  if (existing) return existing;

  // No row inserted and none to find: the conflict was on something other than
  // stripe_invoice_id (only `number` is otherwise UNIQUE) or the row vanished
  // between the two statements. Neither is recoverable here, and returning
  // undefined is what hid this in the first place.
  throw new Error(
    `createInvoice: insert affected no row and no existing invoice for stripe_invoice_id=${String(
      input.stripeInvoiceId,
    )}`,
  );
}

/** The invoice recorded for a Stripe invoice id, if this one has been seen. */
export async function findInvoiceByStripeId(
  pool: pg.Pool,
  stripeInvoiceId: string | null | undefined,
): Promise<InvoiceRow | null> {
  if (!stripeInvoiceId) return null;
  const { rows } = await pool.query<InvoiceRow>('SELECT * FROM invoices WHERE stripe_invoice_id = $1', [
    stripeInvoiceId,
  ]);
  return rows[0] ?? null;
}

export async function findInvoice(pool: pg.Pool, id: string): Promise<InvoiceRow | null> {
  const { rows } = await pool.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function listInvoicesForUser(pool: pg.Pool, userId: string): Promise<InvoiceRow[]> {
  const { rows } = await pool.query<InvoiceRow>(
    'SELECT * FROM invoices WHERE user_id = $1 ORDER BY issued_at DESC',
    [userId],
  );
  return rows;
}

export const INVOICE_PAGE_LIMIT = 200;

/**
 * The invoice ledger, newest first — a page of it.
 *
 * Already capped, but at a number the caller passed and nothing checked, and
 * without saying when the cap bit. Both matter now that the admin screen states
 * how much has been collected: that figure comes from {@link billingSummary},
 * which counts in SQL, so the page can be short without the total being wrong.
 */
export async function listAllInvoices(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<{ invoices: Array<InvoiceRow & { email: string }>; truncated: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? INVOICE_PAGE_LIMIT, 1), INVOICE_PAGE_LIMIT);
  const { rows } = await pool.query(
    `SELECT i.*, u.email FROM invoices i JOIN users u ON u.id = i.user_id
      ORDER BY i.issued_at DESC LIMIT $1`,
    [limit + 1],
  );
  const invoices = rows as Array<InvoiceRow & { email: string }>;
  return { invoices: invoices.slice(0, limit), truncated: invoices.length > limit };
}

/** The three figures the admin billing screen states above its two tables. */
export interface BillingSummary {
  active: number;
  mrr_cents: number;
  collected_cents: number;
}

/**
 * Counted in SQL, over every row, rather than reduced over the page.
 *
 * The screen's two tables are pages now, and MRR summed over a page is not MRR
 * — it is "MRR of the 500 newest subscriptions", which is the same number right
 * up until the day it quietly is not. Each figure is an aggregate over the
 * whole table, so the cap on what is *displayed* can never move what is
 * *stated*.
 *
 * The annual → monthly conversion rounds per subscription and then sums, which
 * is what the reduce it replaces did; rounding the sum instead would move the
 * total by a few cents against every figure ops has already reconciled.
 */
export async function billingSummary(pool: pg.Pool): Promise<BillingSummary> {
  const { rows } = await pool.query<{ active: string; mrr_cents: string; collected_cents: string }>(
    `SELECT
       (SELECT count(*) FROM subscriptions WHERE status = 'active') AS active,
       (SELECT coalesce(sum(CASE p.interval
                              WHEN 'year'  THEN round(p.price_cents / 12.0)
                              WHEN 'month' THEN p.price_cents
                              ELSE 0
                            END), 0)
          FROM subscriptions s
          JOIN plan_limits p ON p.tier = s.plan_tier
         WHERE s.status IN ('active', 'trialing')) AS mrr_cents,
       (SELECT coalesce(sum(amount_cents), 0) FROM invoices WHERE status = 'paid') AS collected_cents`,
  );
  const row = rows[0];
  return {
    active: Number(row?.active ?? 0),
    mrr_cents: Number(row?.mrr_cents ?? 0),
    collected_cents: Number(row?.collected_cents ?? 0),
  };
}
