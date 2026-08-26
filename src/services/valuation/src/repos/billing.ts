import type pg from 'pg';
import { newUlid } from '@n409/shared';
import {
  BILLING_SUBSCRIPTION_STATUSES,
  INVOICE_INITIAL_STATUSES,
  invoicePeriod,
  SERVED_SUBSCRIPTION_STATUSES,
  type InvoiceStatus,
  type PlanLimit,
  type InvoiceLineItem,
} from '../domain/billing.js';

/** The status sets as a SQL array literal, so the queries below cannot restate them. */
const sqlList = (statuses: readonly string[]) => statuses.map((s) => `'${s}'`).join(', ');
const SERVED_SQL = sqlList(SERVED_SUBSCRIPTION_STATUSES);
const BILLING_SQL = sqlList(BILLING_SUBSCRIPTION_STATUSES);

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
      WHERE user_id = $1 AND status IN (${SERVED_SQL})
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

/**
 * The terminal transition, from wherever the subscription was.
 *
 * `canceled_at` is stamped once and never moved. It was assigned `now()`
 * unconditionally, and cancellation has two writers: this one, from
 * `customer.subscription.deleted`, and {@link upsertSubscription}, from a
 * `customer.subscription.updated` carrying `status: 'canceled'`. Stripe sends
 * both for one cancellation and orders neither, so the ordinary sequence —
 * update first, deleted second — moved the recorded cancellation date forward
 * to whenever the second delivery happened to land. A redelivery of `deleted`
 * days later moved it again. That date is the answer to "when did this
 * customer leave", it is read off the row by the data export and by anyone
 * reconciling a final period, and a transition into a state the row is already
 * in must not restate when it happened.
 *
 * The status write stays unconditional: 'canceled' over 'canceled' is the same
 * value, and narrowing the WHERE would only make the statement's terminality
 * depend on a read. Returns the row so a caller can tell a cancellation from a
 * subscription id we have never seen.
 */
export async function cancelSubscription(
  pool: pg.Pool,
  stripeSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<SubscriptionRow>(
    `UPDATE subscriptions
        SET status = 'canceled', canceled_at = COALESCE(canceled_at, now())
      WHERE stripe_subscription_id = $1
      RETURNING *`,
    [stripeSubscriptionId],
  );
  return rows[0] ?? null;
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
        AND s.status IN (${SERVED_SQL})
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
  /** One of {@link INVOICE_STATUSES}; the column's CHECK names the same four. */
  status: InvoiceStatus;
  period_start: Date | null;
  period_end: Date | null;
  line_items: InvoiceLineItem[];
  stripe_invoice_id: string | null;
  issued_at: Date;
  paid_at: Date | null;
  /** Running total refunded (migration 0169). Assigned, never incremented. */
  refunded_cents: number;
  refunded_at: Date | null;
  created_at: Date;
}

/**
 * Record money returned against an invoice, from the running total Stripe puts
 * on the charge.
 *
 * Assigned rather than incremented, which is what makes a redelivered
 * `charge.refunded` free: the charge object always carries `amount_refunded` as
 * a total, so writing it twice writes the same number. The guard is
 * `refunded_cents < $2` rather than `<>`, so an out-of-order redelivery
 * carrying a *smaller* total — an earlier partial refund arriving after a later
 * one — cannot walk the figure backwards.
 *
 * Returns null when there was nothing to update: no such invoice, or the
 * refund is not news. Callers use that to decide whether to say anything.
 */
export async function recordInvoiceRefund(
  pool: pg.Pool,
  stripeInvoiceId: string,
  refundedCents: number,
): Promise<InvoiceRow | null> {
  const { rows } = await pool.query<InvoiceRow>(
    `UPDATE invoices
        SET refunded_cents = $2,
            refunded_at = CASE WHEN $2 > 0 THEN now() ELSE refunded_at END
      WHERE stripe_invoice_id = $1 AND refunded_cents < $2
      RETURNING *`,
    [stripeInvoiceId, refundedCents],
  );
  return rows[0] ?? null;
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
  // The CHECK constraint can see the value but not where it came from, so the
  // one status that is only ever *reached* is refused here instead. An invoice
  // created `void` is not a record of anything, and it would be indexed,
  // numbered and rendered exactly like one that is.
  const status = input.status ?? 'open';
  if (!(INVOICE_INITIAL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`createInvoice: ${status} is not a status an invoice can be created in`);
  }
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
      status,
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

/** The figures the admin billing screen states above its two tables. */
export interface BillingSummary {
  /** Paying and current. */
  active: number;
  /** Paying-to-be: in a trial that has not billed yet. */
  trialing: number;
  /** Being served on a renewal that has not cleared — what dunning is chasing. */
  past_due: number;
  /** The three above: every account consuming a plan's quota. */
  served: number;
  /** Over {@link BILLING_SUBSCRIPTION_STATUSES} — `active` + `trialing`. */
  mrr_cents: number;
  /** Billed on paid invoices, before anything was returned. */
  gross_cents: number;
  /** Returned against those invoices (migration 0169). */
  refunded_cents: number;
  /** What we actually kept: `gross_cents` − `refunded_cents`. */
  collected_cents: number;
  /** First day of the current UTC month, `YYYY-MM-DD` — what the two below mean. */
  month_start: string;
  /** {@link collected_cents} restricted to invoices paid in the current month. */
  month_collected_cents: number;
  /** The same figure for the month before it, so the number has a direction. */
  prev_month_collected_cents: number;
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
 *
 * The month figures are the lifetime one windowed, and deliberately not a
 * second definition of revenue. Summing `month_collected_cents` over every
 * month equals `collected_cents` exactly, which is the property that lets the
 * two sit on one screen — the mistake this function has already made once was
 * printing a count and a total, side by side, over different sets.
 *
 * That fixes what a late refund does: it comes off the month the invoice was
 * *paid* in, not the month the money went back, so a prior month can restate
 * downwards. The alternative — attributing refunds to when they happened —
 * cannot be computed from this table anyway. `refunded_cents` is a running
 * total and `refunded_at` is only the latest one, so a partial refund in July
 * followed by another in August would put July's share in August.
 *
 * The month boundary is stated in UTC rather than taken from the session's
 * timezone. `date_trunc` alone would silently mean a different month on a
 * database configured differently from the one this was written against — and
 * for a revenue line, "which month" is not something to leave to a server
 * setting. `coalesce(paid_at, issued_at)` for the same reason: a paid invoice
 * with no `paid_at` would otherwise count toward the lifetime figure and no
 * month at all, which is exactly the reconciliation this claims to have.
 *
 * The counts are broken out per status rather than collapsed into one, because
 * collapsing them is what made the screen unreadable: a single "active" figure
 * counted `status = 'active'` while the MRR beside it summed
 * `('active','trialing')`, so the two could not be reconciled and the
 * `past_due` accounts — the ones being served without paying, which dunning
 * exists to chase — appeared in neither. `served` is the sum of the three and
 * is exactly the set `findActiveSubscription` and `consumeValuation` grant
 * quota to; `mrr_cents` covers `active` + `trialing`, and now says so.
 */
export async function billingSummary(pool: pg.Pool): Promise<BillingSummary> {
  const { rows } = await pool.query<{
    active: string;
    trialing: string;
    past_due: string;
    mrr_cents: string;
    gross_cents: string;
    refunded_cents: string;
    month_start: string;
    month_collected_cents: string;
    prev_month_collected_cents: string;
  }>(
    `WITH bounds AS (
       SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AS this_month,
              date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month' AS prev_month
     ),
     -- Every paid invoice, netted once, with the instant it was collected.
     -- Written once so the lifetime figures and the month windows cannot drift
     -- into two definitions of the same word.
     collected AS (
       SELECT amount_cents,
              least(refunded_cents, amount_cents) AS refunded,
              coalesce(paid_at, issued_at) AT TIME ZONE 'UTC' AS at
         FROM invoices WHERE status = 'paid'
     )
     SELECT
       (SELECT count(*) FROM subscriptions WHERE status = 'active')   AS active,
       (SELECT count(*) FROM subscriptions WHERE status = 'trialing') AS trialing,
       (SELECT count(*) FROM subscriptions WHERE status = 'past_due') AS past_due,
       (SELECT coalesce(sum(CASE p.interval
                              WHEN 'year'  THEN round(p.price_cents / 12.0)
                              WHEN 'month' THEN p.price_cents
                              ELSE 0
                            END), 0)
          FROM subscriptions s
          JOIN plan_limits p ON p.tier = s.plan_tier
         WHERE s.status IN (${BILLING_SQL})) AS mrr_cents,
       (SELECT coalesce(sum(amount_cents), 0) FROM collected) AS gross_cents,
       -- Netted, not gross. A refund does not move a Stripe invoice's status,
       -- so 'paid' is still the right set to sum over; what changed is that the
       -- money returned comes off it. least() bounds a refund total that
       -- exceeds the invoice: Stripe's figure is authoritative and this is a
       -- revenue line, not a reconciliation.
       (SELECT coalesce(sum(refunded), 0) FROM collected) AS refunded_cents,
       (SELECT to_char(this_month, 'YYYY-MM-DD') FROM bounds) AS month_start,
       (SELECT coalesce(sum(amount_cents - refunded), 0)
          FROM collected, bounds WHERE collected.at >= bounds.this_month)
         AS month_collected_cents,
       (SELECT coalesce(sum(amount_cents - refunded), 0)
          FROM collected, bounds
         WHERE collected.at >= bounds.prev_month AND collected.at < bounds.this_month)
         AS prev_month_collected_cents`,
  );
  const row = rows[0];
  const active = Number(row?.active ?? 0);
  const trialing = Number(row?.trialing ?? 0);
  const pastDue = Number(row?.past_due ?? 0);
  const gross = Number(row?.gross_cents ?? 0);
  const refunded = Number(row?.refunded_cents ?? 0);
  return {
    active,
    trialing,
    past_due: pastDue,
    served: active + trialing + pastDue,
    mrr_cents: Number(row?.mrr_cents ?? 0),
    gross_cents: gross,
    refunded_cents: refunded,
    collected_cents: Math.max(0, gross - refunded),
    month_start: row?.month_start ?? '',
    month_collected_cents: Number(row?.month_collected_cents ?? 0),
    prev_month_collected_cents: Number(row?.prev_month_collected_cents ?? 0),
  };
}
