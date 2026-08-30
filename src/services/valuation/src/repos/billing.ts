import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { fitsInt4 } from '../domain/int4.js';
import {
  BILLING_SUBSCRIPTION_STATUSES,
  INVOICE_INITIAL_STATUSES,
  invoiceNumber,
  invoicePeriod,
  SERVED_SUBSCRIPTION_STATUSES,
  type InvoiceStatus,
  type PlanLimit,
  type SubscriptionPrice,
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

/**
 * The plan a subscription is *on*, as opposed to one that may still be bought.
 *
 * The same row without the `active` filter, and the distinction is the whole
 * point of having two functions. `active` is a catalogue flag: it says a tier
 * is still on sale, not that the accounts already on it have stopped being on
 * it. Retiring a tier while its subscribers see out their term is the ordinary
 * way a price list changes, and `subscriptions.plan_tier` has a foreign key to
 * `plan_limits.tier`, so the row is still there to be read.
 *
 * Read through {@link findPlan}, it was not. `/me/subscription` looked the
 * subscriber's own plan up in the catalogue, got null the moment the tier was
 * deactivated, and passed `valuation_limit: null` to `usageView` — where null
 * means *unlimited*. So the screen told a retainer subscriber they had
 * unlimited valuations and `remaining: null`, while `consumeValuation` — which
 * joins `plan_limits` with no `active` filter, as does the ops dashboard —
 * went on refusing the thirteenth with a 402 they had just been told could not
 * happen. Nothing had changed for that customer except a flag on a row they
 * cannot see.
 *
 * An absent plan meaning "no limit" is the permissive reading of missing data,
 * and it is the reading that makes this class of bug silent; the fix is to stop
 * the plan going missing, since the foreign key guarantees it cannot.
 */
export async function findPlanForSubscription(pool: pg.Pool, tier: string): Promise<PlanLimit | null> {
  const { rows } = await pool.query<PlanLimit>(
    `SELECT tier, name, valuation_limit, price_cents, currency, interval
       FROM plan_limits WHERE tier = $1`,
    [tier],
  );
  return rows[0] ?? null;
}

/**
 * The plan a live subscription price names — or nothing, if it names none
 * unambiguously.
 *
 * The reverse of {@link findPlan}: not "what does this tier cost" but "which
 * tier is this what we charge for". Read when a `customer.subscription.*` event
 * reports an item whose price is not the one the subscription's metadata was
 * stamped with — i.e. after a plan change in Stripe's hosted portal, which
 * swaps the item and never touches the metadata. See `subscriptionPrice`.
 *
 * Two refusals, both deliberate:
 *
 * `active` is not filtered, for the reason {@link findPlanForSubscription}
 * spells out — a tier retired from the catalogue still has subscribers on it,
 * and a downgrade *onto* a retired tier is not a thing Stripe can do, but a
 * renewal of one already there is.
 *
 * Uncapped, like {@link listPlans}: `plan_limits` is the price list, a handful
 * of rows an operator maintains by hand, and a cap on a read of it would only
 * be able to hide the ambiguity the next paragraph exists to detect.
 *
 * More than one tier at the same price, currency and interval resolves to
 * nothing rather than to whichever sorts first. Two rows priced identically is
 * a legitimate catalogue (a rename, a grandfathered tier), and picking between
 * them by row order would move a subscriber's quota on the strength of an
 * ordering nobody chose.
 */
export async function findPlanByPrice(pool: pg.Pool, price: SubscriptionPrice): Promise<PlanLimit | null> {
  const { rows } = await pool.query<PlanLimit>(
    `SELECT tier, name, valuation_limit, price_cents, currency, interval
       FROM plan_limits
      WHERE price_cents = $1 AND lower(currency) = $2 AND interval = $3`,
    [price.amount_cents, price.currency, price.interval],
  );
  return rows.length === 1 ? rows[0]! : null;
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
  /**
   * The period {@link SubscriptionRow.valuations_used} is counting (migration
   * 0190) — which is not always `current_period_start`, and the difference is
   * the whole point of the column. Stripe advances the period when it *raises*
   * the renewal invoice, so a declined renewal moves `current_period_start`
   * forward while no money has arrived; the counter stays where the last paid
   * period left it until a paying status says otherwise.
   */
  quota_period_start: Date | null;
  created_at: Date;
  canceled_at: Date | null;
  /**
   * A cancellation scheduled for the end of the current period (migration
   * 0187). Every self-serve cancellation passes through this: Stripe's portal
   * sets it and leaves the subscription 'active' until the period runs out.
   */
  cancel_at_period_end: boolean;
}

/**
 * A subscription row, plus whether the statement that returned it is the one
 * that ended the subscription.
 *
 * Cancellation has two writers — {@link cancelSubscription} from
 * `customer.subscription.deleted`, and {@link upsertSubscription} from a
 * `customer.subscription.updated` carrying `status: 'canceled'` — and Stripe
 * sends both for one cancellation without ordering them. Anything that has to
 * happen *once* when a subscription ends therefore cannot be gated on the
 * status it reads back, which is 'canceled' on both deliveries. It has to be
 * gated on which write made it so, and that is a fact only the write itself
 * holds. Both writers now answer it, by the same rule: true exactly when this
 * statement moved a row that was not already cancelled.
 */
export interface SubscriptionWrite extends SubscriptionRow {
  newly_canceled: boolean;
  /**
   * Whether this statement created the row rather than moving one that was
   * already there — `xmax = 0`, the same signal `newly_canceled` is derived
   * from, and authoritative for the same reason: which arm the upsert took is
   * a fact only the write holds.
   *
   * The billing audit spine needs it to tell a subscription *starting* from a
   * subscription *changing*, and the two Stripe events that describe one new
   * subscription (`checkout.session.completed` and
   * `customer.subscription.created`) both arrive here with the row absent on
   * whichever lands first. Deciding from a read before the call would call the
   * second one a start too.
   *
   * The no-stripe-id insert arm below always creates, so it reports `true`;
   * the stale-event path that returns an untouched existing row reports
   * `false`, because it wrote nothing at all.
   */
  inserted: boolean;
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
    /**
     * Whether Stripe says this subscription is set to end at the period's
     * close. `undefined` from a caller that cannot know — a Checkout Session
     * object carries no such field — and left alone in that case, for the same
     * reason the period is: an event that does not mention it is not an event
     * reporting that no cancellation is scheduled.
     */
    cancelAtPeriodEnd?: boolean;
  },
): Promise<SubscriptionWrite> {
  // Stripe subscription id is the natural key when present; otherwise upsert on
  // the user's single active row.
  if (input.stripeSubscriptionId) {
    const { rows } = await pool.query<SubscriptionWrite>(
      `INSERT INTO subscriptions
         (id, user_id, plan_tier, status, stripe_subscription_id, stripe_customer_id,
          current_period_start, current_period_end, cancel_at_period_end, quota_period_start,
          canceled_at)
       -- A row may be *born* cancelled — see SUBSCRIPTION_INITIAL_STATUSES —
       -- and it was born without a date, because only the update arm below
       -- stamped one. So the one state the whole machine treats as terminal
       -- could exist with nothing saying when it was reached, and canceled_at
       -- is what the personal data export and any final-period reconciliation
       -- read for "when did this customer leave". Reached whenever a
       -- customer.subscription.updated carrying status 'canceled' is the first
       -- event about a subscription this platform holds no row for.
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, false), $7,
               CASE WHEN $4 = 'canceled' THEN now() END)
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
         -- Same rule, and the NULL is doing the same work: the Checkout Session
         -- object has no cancel_at_period_end field, so writing EXCLUDED
         -- unconditionally would have that event clear a scheduled cancellation
         -- the subscription event had just recorded.
         cancel_at_period_end = COALESCE($9, subscriptions.cancel_at_period_end),
         -- A new billing period resets usage — but only one that has been paid
         -- for, and compared against the period the counter is actually
         -- counting rather than the one the row happens to be showing.
         --
         -- Stripe advances current_period_start when it *raises* the renewal
         -- invoice, not when the invoice settles, so a declined renewal arrives
         -- as a single event carrying both the next period and 'past_due'.
         -- Keyed on the period alone, that event handed an exhausted annual
         -- retainer twelve more valuations for a period nobody had paid for,
         -- and 'past_due' is a served status with no end (see
         -- SERVED_SUBSCRIPTION_STATUSES), so it kept them. So the reset is
         -- gated on the money as well as the date: BILLING_SUBSCRIPTION_STATUSES
         -- is the set that means a renewal cleared.
         --
         -- quota_period_start (migration 0190) is what makes the recovery work.
         -- The past_due event moves current_period_start and leaves the counter
         -- and its period alone; the 'active' that follows when the customer
         -- replaces their card carries that same new period, which still differs
         -- from quota_period_start, so the grant happens then — on the event
         -- that says the money arrived — rather than never.
         valuations_used = CASE
           WHEN EXCLUDED.status IN (${BILLING_SQL})
            AND COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start)
                IS DISTINCT FROM subscriptions.quota_period_start
           THEN 0 ELSE subscriptions.valuations_used END,
         quota_period_start = CASE
           WHEN EXCLUDED.status IN (${BILLING_SQL})
            AND COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start)
                IS DISTINCT FROM subscriptions.quota_period_start
           THEN COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start)
           ELSE subscriptions.quota_period_start END,
         canceled_at = CASE WHEN EXCLUDED.status = 'canceled' THEN now() ELSE NULL END
       WHERE subscriptions.status <> 'canceled'
       -- xmax is this statement saying which arm it took: zero on the row it
       -- inserted, the updating transaction on the row it updated. A row
       -- *created* cancelled is a subscription this platform never carried,
       -- not an account that just ended, so only the update arm is news. The
       -- WHERE above already guarantees the updated row was not cancelled
       -- before, so an update to 'canceled' is always a transition into it.
       RETURNING *, (NOT (xmax = 0) AND status = 'canceled') AS newly_canceled, (xmax = 0) AS inserted`,
      [
        newUlid(),
        input.userId,
        input.planTier,
        input.status ?? 'active',
        input.stripeSubscriptionId,
        input.stripeCustomerId ?? null,
        input.periodStart ?? null,
        input.periodEnd ?? null,
        input.cancelAtPeriodEnd ?? null,
      ],
    );
    if (rows[0]) return rows[0];

    // No row came back, so the DO UPDATE's WHERE declined it: the subscription
    // on file is cancelled and stays that way. The caller still asked for the
    // row, and it exists — returning it unchanged keeps this a no-op rather
    // than an error, which is what a stale event deserves.
    const existing = await findSubscriptionByStripeId(pool, input.stripeSubscriptionId);
    if (existing) return { ...existing, newly_canceled: false, inserted: false };

    // Neither inserted, nor updated, nor found. The only other UNIQUE on the
    // table is the one we conflicted on, so this means the row was deleted
    // between the two statements — not recoverable here, and not something to
    // hide behind a non-null assertion.
    throw new Error(
      `upsertSubscription: no row written or found for stripe_subscription_id=${input.stripeSubscriptionId}`,
    );
  }
  const { rows } = await pool.query<SubscriptionRow>(
    `INSERT INTO subscriptions
       (id, user_id, plan_tier, status, current_period_start, current_period_end, quota_period_start,
        canceled_at)
     -- Same rule as the arm above: the terminal state never exists without the
     -- date it was reached.
     VALUES ($1, $2, $3, $4, $5, $6, $5, CASE WHEN $4 = 'canceled' THEN now() END) RETURNING *`,
    [
      newUlid(),
      input.userId,
      input.planTier,
      input.status ?? 'active',
      input.periodStart ?? null,
      input.periodEnd ?? null,
    ],
  );
  // A fresh row, so nothing transitioned.
  return { ...rows[0]!, newly_canceled: false, inserted: true };
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
): Promise<SubscriptionWrite | null> {
  const { rows } = await pool.query<SubscriptionWrite>(
    // The prior status is read in the same statement, under the lock the update
    // is about to take, so `newly_canceled` is decided by the write rather than
    // by a read a competing delivery can slip past. `FOR UPDATE` makes the
    // second of two concurrent deliveries wait and then re-read the winner's
    // row, which is exactly the reading that has to say "already cancelled".
    `WITH prev AS (
       SELECT id, status FROM subscriptions WHERE stripe_subscription_id = $1 FOR UPDATE
     )
     UPDATE subscriptions s
        SET status = 'canceled', canceled_at = COALESCE(s.canceled_at, now())
       FROM prev
      WHERE s.id = prev.id
      RETURNING s.*, (prev.status <> 'canceled') AS newly_canceled, false AS inserted`,
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
 * Is this Stripe customer one of ours?
 *
 * The reverse of {@link findStripeCustomerId}, and it answers a different
 * question: not "where do I send this subscriber" but "is this charge our
 * money". A `charge.refunded` names a charge, an invoice and a customer, and
 * when the invoice is not on file the customer is the only thing left on the
 * event that can tell a renewal of ours from one of the many that a shared
 * Stripe account carries.
 *
 * Whatever state the subscription is in, deliberately. A refund most often
 * follows a cancellation, so filtering to the served statuses would answer "not
 * ours" for exactly the case this exists to catch. Newest first, since a
 * resubscribe leaves the old row behind.
 */
export async function findSubscriptionByStripeCustomerId(
  pool: pg.Pool,
  stripeCustomerId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<SubscriptionRow>(
    `SELECT * FROM subscriptions
      WHERE stripe_customer_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [stripeCustomerId],
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

/**
 * Give back the valuation {@link consumeValuation} charged for, when the
 * valuation it was charged for was never created.
 *
 * The create route spends the quota and then inserts the row, in that order and
 * as two statements: the gate has to answer before any work is done, and
 * `createValuation` is its own transaction. So anything that made the insert
 * fail — a pool blip, a `partner_id` that no longer resolves, a deadline — left
 * the subscriber one valuation poorer with nothing to show for it. There is no
 * way back from the product side either: the counter is only ever reset by a
 * renewal, so on an annual retainer the twelfth valuation could be spent on a
 * 500 and the customer would wait a year to get it back.
 *
 * A compensation rather than a shared transaction, because the two halves are
 * owned by different modules and the alternative is threading a client through
 * the whole create path for a failure that is rare by construction. The refund
 * is bounded — `valuations_used > 0`, so it can never drive the counter
 * negative — and is deliberately not conditioned on the counter still being the
 * one this request incremented: if a renewal has reset it in the meantime the
 * decrement lands on the new period and costs us at most the one valuation we
 * already failed to deliver. Erring toward the customer is the right side of
 * that to be wrong on.
 *
 * Returns whether anything was given back, so a caller can log the case where
 * it could not be.
 */
export async function releaseValuation(pool: pg.Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `UPDATE subscriptions s
        SET valuations_used = s.valuations_used - 1
      WHERE s.user_id = $1
        AND s.status IN (${SERVED_SQL})
        AND s.valuations_used > 0
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
  // Storable whole minor units, checked here as well as at the webhook. The
  // column is `integer` and the figure is *assigned* rather than derived, so
  // anything the driver refuses — a fraction, a total past int4 — is a 500 on a
  // Stripe delivery rather than a validation failure. Stated as a precondition
  // for the reason `recordPaidInvoice` states its own: the caller cannot see
  // the column from where it stands.
  if (!fitsInt4(refundedCents)) {
    throw new Error(
      `recordInvoiceRefund: refunded_cents must be storable whole minor units, got ${refundedCents}`,
    );
  }
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

/** The insert lost to a writer that did not take the lock; see below. */
class InvoiceAlreadyRecorded extends Error {}

/**
 * Record a settled Stripe invoice, numbering it, in one transaction.
 *
 * Replaces the check → allocate → insert the billing webhook did with three
 * separate round trips. Each step was individually right and the sequence was
 * not, because the number an invoice carries is allocated from a counter that
 * only ever goes up, and the two ways out of that sequence without an invoice
 * both leave the counter moved:
 *
 *   * **A failure after allocation.** Anything that made the insert throw — an
 *     amount Stripe reported as something other than whole minor units, a
 *     `user_id` no longer on file, a pool blip — burned a number and answered
 *     Stripe with a 5xx. The 5xx is deliberate, it is how a transient failure
 *     gets redelivered; but a *permanent* one is then redelivered for days, and
 *     each attempt burns another number. One malformed event walked the
 *     sequence forward indefinitely.
 *
 *   * **The duplicate that lost.** Stripe sends `invoice.paid` *and*
 *     `invoice.payment_succeeded` for one payment, with different event ids the
 *     ledger cannot collapse, and fans them out together. The route's
 *     `findInvoiceByStripeId` guard is a read with a write after it, so both
 *     deliveries routinely saw no invoice, both allocated, and the `ON CONFLICT`
 *     declined the loser's insert — a burned number on the ordinary path, for
 *     every renewal that arrived concurrently.
 *
 * A gap is not cosmetic. The numbering is what an auditor reads as a count of
 * what was billed, and INV-202608-0004 following INV-202608-0002 is a question
 * with no answer in this system: the invoice it names was never issued and
 * nothing records that it was not.
 *
 * Both are closed by the same two things. The advisory lock is taken on the
 * Stripe invoice id, so concurrent deliveries about one invoice serialise and
 * the second sees the first's row rather than allocating against it — the
 * counter's own row lock cannot do this, since it is only taken *at* allocation,
 * after the point where the loser has already decided to allocate. And the
 * allocation now shares a transaction with the insert, so a failure rolls the
 * counter back with it: the number is spent only by the row that carries it.
 *
 * `created` says whether this call is the one that wrote the row, which is what
 * the caller announces on — the write itself saying so, rather than a read
 * taken before it.
 */
export async function recordPaidInvoice(
  pool: pg.Pool,
  input: {
    userId: string;
    subscriptionId: string | null;
    amountCents: number;
    currency: string;
    periodStart: Date | null;
    periodEnd: Date | null;
    lineItems: InvoiceLineItem[];
    stripeInvoiceId: string | null;
    issuedAt?: Date;
    paidAt?: Date | null;
  },
): Promise<{ invoice: InvoiceRow; created: boolean }> {
  // Whole minor units, checked here as well as at the route. The column is
  // `integer`, so a fraction or a NaN is refused by the driver rather than
  // rounded — and refused *after* the number has been allocated, which is the
  // gap above. Stated as a precondition so no future caller has to rediscover
  // that the two facts are connected.
  if (!Number.isInteger(input.amountCents)) {
    throw new Error(`recordPaidInvoice: amount_cents must be whole minor units, got ${input.amountCents}`);
  }
  return withTransaction(pool, async (tx) => {
    if (input.stripeInvoiceId) {
      // Keyed on the Stripe invoice, so two deliveries about one payment
      // serialise and unrelated renewals do not. Transaction-scoped, so it is
      // released by the COMMIT or the ROLLBACK either way.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.stripeInvoiceId]);
      const { rows } = await tx.query<InvoiceRow>('SELECT * FROM invoices WHERE stripe_invoice_id = $1', [
        input.stripeInvoiceId,
      ]);
      if (rows[0]) return { invoice: rows[0], created: false };
    }

    const issuedAt = input.issuedAt ?? new Date();
    const issuedIso = issuedAt.toISOString();
    const period = invoicePeriod(issuedIso);
    const { rows: seqRows } = await tx.query<{ seq: number }>(
      `INSERT INTO invoice_sequences (period, seq) VALUES ($1, 1)
       ON CONFLICT (period) DO UPDATE SET seq = invoice_sequences.seq + 1
       RETURNING seq`,
      [period],
    );
    const number = invoiceNumber(issuedIso, seqRows[0]!.seq);

    // `issued_at` is written rather than defaulted, so the month in the number
    // and the month the row says it was issued in are the same instant — the
    // column's `now()` is the database's clock at COMMIT and could fall on the
    // other side of a month boundary from the period allocated above.
    //
    // `ON CONFLICT DO NOTHING` behind the lock, which is belt and braces rather
    // than the mechanism: the lock is what makes two of *these* calls order
    // themselves, and it cannot bind a writer that does not take it — a
    // backfill, a fixture, an older process mid-deploy. Losing that way must
    // still not burn a number, so the conflict aborts the transaction and the
    // allocation rolls back with it; the row already on file is read afterwards
    // and returned as somebody else's.
    const { rows } = await tx.query<InvoiceRow>(
      `INSERT INTO invoices
         (id, number, user_id, subscription_id, amount_cents, currency, status,
          period_start, period_end, line_items, stripe_invoice_id, issued_at, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,$8,$9,$10,$11,$12)
       ON CONFLICT (stripe_invoice_id) DO NOTHING
       RETURNING *`,
      [
        newUlid(),
        number,
        input.userId,
        input.subscriptionId,
        input.amountCents,
        input.currency,
        input.periodStart,
        input.periodEnd,
        JSON.stringify(input.lineItems),
        input.stripeInvoiceId,
        issuedAt,
        input.paidAt ?? issuedAt,
      ],
    );
    if (!rows[0]) throw new InvoiceAlreadyRecorded();
    return { invoice: rows[0], created: true };
  }).catch(async (err: unknown) => {
    if (!(err instanceof InvoiceAlreadyRecorded)) throw err;
    const existing = await findInvoiceByStripeId(pool, input.stripeInvoiceId);
    if (existing) return { invoice: existing, created: false };
    // The conflict fired and the row it conflicted with is gone. Only
    // `stripe_invoice_id` and `number` are UNIQUE here and the number was
    // freshly allocated under a counter nothing else writes, so this is not a
    // state the schema admits — and returning something would mean inventing
    // an invoice.
    throw new Error(
      `recordPaidInvoice: insert conflicted but no invoice exists for stripe_invoice_id=${String(
        input.stripeInvoiceId,
      )}`,
    );
  });
}

export async function findInvoice(pool: pg.Pool, id: string): Promise<InvoiceRow | null> {
  const { rows } = await pool.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * One page of a user's own invoice ledger, newest first.
 *
 * Append-only, and appended to on a clock: a subscriber accrues a row a month
 * for as long as they subscribe, so this list is the one on the account page
 * whose length is a function of tenure rather than of anything the user did.
 * It shares {@link INVOICE_PAGE_LIMIT} with the admin ledger below — the same
 * rows, the same page size, one number to reason about.
 */
export async function listInvoicesForUser(
  pool: pg.Pool,
  userId: string,
): Promise<{ invoices: InvoiceRow[]; truncated: boolean }> {
  const { rows } = await pool.query<InvoiceRow>(
    'SELECT * FROM invoices WHERE user_id = $1 ORDER BY issued_at DESC LIMIT $2',
    [userId, INVOICE_PAGE_LIMIT + 1],
  );
  return {
    invoices: rows.slice(0, INVOICE_PAGE_LIMIT),
    truncated: rows.length > INVOICE_PAGE_LIMIT,
  };
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
