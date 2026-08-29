import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { ValuationScope } from '../auth/rbac.js';
import { PAYMENT_REVERSIBLE_STATUSES, type DisputeStatus, type PaymentStatus } from '../domain/payments.js';
import type { QuoteLine } from '../domain/pricing.js';

// Declared in domain/payments.ts alongside the transitions between them, and
// re-exported because every caller in this service knows this module as the
// place a payment's shape comes from.
export type { PaymentStatus } from '../domain/payments.js';

export interface PaymentRow {
  id: string;
  valuation_id: string;
  provider: string;
  session_id: string;
  payment_intent_id: string | null;
  amount_cents: string | number;
  currency: string;
  status: PaymentStatus;
  checkout_url: string | null;
  charge_id: string | null;
  receipt_url: string | null;
  refunded_cents: string | number;
  refunded_at: Date | null;
  dispute_status: DisputeStatus | null;
  disputed_at: Date | null;
  /** Bought next-business-day delivery. Moves the SLA, so it is a column. */
  express: boolean;
  /** Bought the standalone QSBS attestation letter. */
  qsbs_letter: boolean;
  /** The quote as sold — entry price, band uplift and each add-on (0108). */
  price_breakdown: QuoteLine[] | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createPayment(
  pool: pg.Pool,
  input: {
    valuationId: string;
    sessionId: string;
    amountCents: number;
    currency: string;
    checkoutUrl?: string | null;
    createdBy?: string | null;
    express?: boolean;
    qsbsLetter?: boolean;
    /** Persisted verbatim: a dispute is about the ladder in force on the day. */
    priceBreakdown?: QuoteLine[] | null;
  },
): Promise<PaymentRow> {
  const { rows } = await pool.query<PaymentRow>(
    `INSERT INTO payments
       (id, valuation_id, session_id, amount_cents, currency, checkout_url, created_by,
        express, qsbs_letter, price_breakdown)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      newUlid(),
      input.valuationId,
      input.sessionId,
      input.amountCents,
      input.currency.toUpperCase(),
      input.checkoutUrl ?? null,
      input.createdBy ?? null,
      input.express ?? false,
      input.qsbsLetter ?? false,
      input.priceBreakdown ? JSON.stringify(input.priceBreakdown) : null,
    ],
  );
  return rows[0]!;
}

export async function findPaymentBySessionId(pool: pg.Pool, sessionId: string): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>('SELECT * FROM payments WHERE session_id = $1', [sessionId]);
  return rows[0] ?? null;
}

/**
 * Stripe's default Checkout Session lifetime. A session's URL stays payable
 * until it completes or reaches this, and nothing tells us which — so a row
 * younger than this with a URL on it is treated as a live way to be charged.
 */
export const CHECKOUT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The still-payable checkout already open against this engagement, if there is
 * one.
 *
 * Nothing used to ask. Every POST to the checkout route minted a new Session,
 * so a client who double-clicked Pay, or opened the engagement in two tabs, or
 * came back to a tab left open that morning, held two live Stripe URLs for one
 * piece of work — and paying both charges them twice. The second webhook finds
 * the valuation already paid and skips it, so the duplicate does not even show
 * up as a second paid engagement: it is just a charge on a card statement with
 * no counterpart here.
 *
 * Newest first, because that is the one whose URL was most recently handed out.
 */
export async function findLiveCheckout(pool: pg.Pool, valuationId: string): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>(
    `SELECT * FROM payments
      WHERE valuation_id = $1
        AND status = 'pending'
        AND checkout_url IS NOT NULL
        AND created_at > now() - ($2::bigint * interval '1 millisecond')
      ORDER BY created_at DESC
      LIMIT 1`,
    [valuationId, CHECKOUT_SESSION_TTL_MS],
  );
  return rows[0] ?? null;
}

/**
 * One payment, keyed on its own id *and* the valuation it belongs to.
 *
 * The valuation is part of the key rather than checked afterwards because the
 * caller has already established the principal may read that valuation. A
 * lookup by payment id alone would hand back a row from someone else's
 * engagement for the route to notice, and "notice" is the step that gets
 * forgotten. A mismatched pair is simply not found.
 */
export async function findPaymentForValuation(
  pool: pg.Pool,
  valuationId: string,
  paymentId: string,
): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>(
    'SELECT * FROM payments WHERE id = $1 AND valuation_id = $2',
    [paymentId, valuationId],
  );
  return rows[0] ?? null;
}

/**
 * Another payment on this engagement that is still holding money.
 *
 * One valuation can carry several settled payments. The checkout route refuses
 * a second one while the engagement is already paid, but that guard is a read
 * with a webhook between it and the write: two POSTs that both find the
 * engagement unpaid — a double-click, a second tab — each open a Session and
 * each leave a row, and a client who pays both leaves two `succeeded` rows.
 *
 * Which makes "was this payment refunded in full" the wrong question to revoke
 * an engagement on, and it was the only one asked. The remedy for a double
 * charge is to refund one of the two, and doing that took the report away from
 * a client who had paid for it twice and been given one refund.
 *
 * `amount_cents > refunded_cents` rather than a status test, because a
 * partially refunded row is still 'succeeded' and still holds the rest — and a
 * row under an open dispute is too: the money is held, not lost, which is
 * exactly why `handleDispute` does not revoke on `created`.
 */
export async function findOtherFundedPayment(
  pool: pg.Pool,
  valuationId: string,
  excludePaymentId: string,
): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>(
    `SELECT * FROM payments
      WHERE valuation_id = $1
        AND id <> $2
        AND status = 'succeeded'
        AND amount_cents > refunded_cents
      ORDER BY created_at DESC
      LIMIT 1`,
    [valuationId, excludePaymentId],
  );
  return rows[0] ?? null;
}

/**
 * The payment a refund or dispute event names.
 *
 * Those events carry a charge and a payment intent, never the Checkout Session
 * id the row is keyed on, so both are tried. Charge first: it is the more
 * specific of the two and the only one present on a dispute raised against a
 * charge whose intent we never stored. Newest-first with a LIMIT because
 * neither column is unique — a resumed checkout can produce a second row
 * against the same intent — and the latest is the one that settled.
 */
export async function findPaymentByChargeOrIntent(
  pool: pg.Pool,
  ref: { chargeId?: string | null; paymentIntentId?: string | null },
): Promise<PaymentRow | null> {
  if (ref.chargeId) {
    const { rows } = await pool.query<PaymentRow>(
      'SELECT * FROM payments WHERE charge_id = $1 ORDER BY created_at DESC LIMIT 1',
      [ref.chargeId],
    );
    if (rows[0]) return rows[0];
  }
  if (ref.paymentIntentId) {
    const { rows } = await pool.query<PaymentRow>(
      'SELECT * FROM payments WHERE payment_intent_id = $1 ORDER BY created_at DESC LIMIT 1',
      [ref.paymentIntentId],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

/**
 * Records a refund total against a payment.
 *
 * Assignment, not accumulation: Stripe sends the charge's running
 * `amount_refunded`, so a redelivered event writes the same value again. The
 * row only becomes 'refunded' when everything went back — a partial refund
 * leaves it 'succeeded', because the client still bought and still holds the
 * report. `refunded_at` is stamped once and never moved, so it means "when the
 * money first started coming back" even across several partial refunds.
 *
 * The status test is the other half of the compare-and-set, and it is the
 * transition rule rather than a redelivery guard: `refunded` follows `succeeded`
 * and nothing else (domain/payments.PAYMENT_TRANSITIONS). Without it the write
 * was legal only by construction — a `pending`, `failed` or `expired` row has
 * no charge id and no payment intent, so `findPaymentByChargeOrIntent` cannot
 * normally reach one — and that function's own comment says the intent column
 * is not unique and a resumed checkout can leave a second row against it. One
 * such row returned newest-first is a charge we never recorded as settled being
 * marked given back.
 *
 * `refunded_cents < $2` makes it a compare-and-set, and the null it returns is
 * the caller's signal that this figure is not news. The handler used to decide
 * that with a read — `payment.refunded_cents >= state.refundedCents` — which
 * answers a *sequential* redelivery correctly and cannot answer a concurrent
 * one at all. Stripe sends one `charge.refunded` per refund, so a partial
 * refund and the rest of it are two events about one charge that can be in
 * flight together: both read the old total, both decided theirs was news, and
 * whichever UPDATE landed last won. That is how the smaller figure ends up
 * stored under an already-'refunded' status — an engagement showing a part
 * refund of money that all came back, and a revenue line netting off too
 * little. It is the same guard `recordInvoiceRefund` has always had on the
 * subscription side; the payment side did it in the wrong place.
 */
export async function recordRefund(
  pool: pg.Pool,
  id: string,
  args: { refundedCents: number; fullyRefunded: boolean },
): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>(
    `UPDATE payments
     SET refunded_cents = $2,
         refunded_at = COALESCE(refunded_at, now()),
         status = CASE WHEN $3 THEN 'refunded'::payment_status ELSE status END,
         updated_at = now()
     WHERE id = $1 AND refunded_cents < $2 AND status::text = ANY($4::text[])
     RETURNING *`,
    [id, args.refundedCents, args.fullyRefunded, [...PAYMENT_REVERSIBLE_STATUSES]],
  );
  return rows[0] ?? null;
}

/**
 * Records where a chargeback stands.
 *
 * A lost dispute is money Stripe has already pulled back, so it lands the row
 * in the same terminal state as a full refund and records the whole charge as
 * returned. An open or won one leaves `status` alone: during an open dispute we
 * still hold the money, and a won one we keep.
 *
 * Bounded to the settled statuses like `recordRefund` above, and for the same
 * reason: a lost chargeback promotes the row to 'refunded', which is a
 * transition out of 'succeeded' and out of nothing else.
 *
 * `dispute_status IS DISTINCT FROM $2` makes it a compare-and-set, for the
 * reason `recordRefund` above gained one: the handler decided whether the
 * verdict was news by reading the row first, and a read cannot exclude a
 * concurrent writer. `charge.dispute.created` and `charge.dispute.closed` are
 * fanned out by Stripe and retried independently, so two of them about one
 * charge do arrive together — and both then alerted the billing group, once to
 * work a case and once to say it was already decided.
 *
 * What this deliberately does *not* do is order them. Two events about one
 * dispute are two readings of one state, so of them the later is simply right;
 * but nothing on this row identifies which dispute, and the pair that looks
 * out-of-order is also what a genuine second case looks like — an early-warning
 * enquiry closed (`warning_closed`, recorded 'won') and a real chargeback
 * raised on the same charge afterwards reads exactly like a stale 'open'
 * landing after a verdict. Guessing would either drop a live case or reopen a
 * settled one. So a redelivered `created` arriving after a `closed` still
 * writes 'open' over the verdict, and the money side is what stays right:
 * `status` and `refunded_cents` are only ever set by a loss and are never
 * unset, so a lost dispute stays lost and revoked whatever the verdict column
 * later says.
 */
export async function recordDispute(
  pool: pg.Pool,
  id: string,
  status: DisputeStatus,
): Promise<PaymentRow | null> {
  const lost = status === 'lost';
  const { rows } = await pool.query<PaymentRow>(
    `UPDATE payments
     SET dispute_status = $2,
         disputed_at = COALESCE(disputed_at, now()),
         status = CASE WHEN $3 THEN 'refunded'::payment_status ELSE status END,
         refunded_cents = CASE WHEN $3 THEN amount_cents ELSE refunded_cents END,
         refunded_at = CASE WHEN $3 THEN COALESCE(refunded_at, now()) ELSE refunded_at END,
         updated_at = now()
     WHERE id = $1 AND dispute_status IS DISTINCT FROM $2 AND status::text = ANY($4::text[])
     RETURNING *`,
    [id, status, lost, [...PAYMENT_REVERSIBLE_STATUSES]],
  );
  return rows[0] ?? null;
}

/**
 * Moves a payment to a terminal status, optionally only from an expected one.
 *
 * `from` makes the write a compare-and-set, and the null it returns when the
 * row was not in one of those statuses is the caller's signal that somebody
 * else got there first. Two things need that.
 *
 * The first is redelivery. Stripe retries a `checkout.session.completed` for up
 * to three days and an operator can resend one by hand at any point, and by
 * then the charge may have been refunded or lost to a chargeback — both of
 * which land the row on 'refunded'. Fulfilment read `status === 'succeeded'` to
 * decide whether the event was news, so a row sitting on 'refunded' looked like
 * one that had never been fulfilled: the replay marked it succeeded again and
 * put the engagement back to paid. The client had every cent back and kept the
 * published 409A.
 *
 * The second is parallelism. Two concurrent deliveries of the same event both
 * read 'pending', both decided to fulfil, and both went on to patch the
 * valuation — two audit entries for one transition and two "your valuation is
 * paid" emails. A read cannot exclude a writer; only the UPDATE can, so the
 * status test belongs in it.
 */
export async function markPayment(
  pool: pg.Pool,
  id: string,
  status: Exclude<PaymentStatus, 'pending'>,
  extra: {
    paymentIntentId?: string | null;
    chargeId?: string | null;
    receiptUrl?: string | null;
    /** Statuses the row must currently hold. Omitted means "whatever it holds". */
    from?: readonly PaymentStatus[];
  } = {},
): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>(
    `UPDATE payments
     SET status = $2,
         payment_intent_id = COALESCE($3, payment_intent_id),
         charge_id = COALESCE($4, charge_id),
         receipt_url = COALESCE($5, receipt_url),
         updated_at = now()
     WHERE id = $1
       AND ($6::text[] IS NULL OR status::text = ANY($6::text[]))
     RETURNING *`,
    [
      id,
      status,
      extra.paymentIntentId ?? null,
      extra.chargeId ?? null,
      extra.receiptUrl ?? null,
      extra.from ? [...extra.from] : null,
    ],
  );
  return rows[0] ?? null;
}

/** Attaches receipt details after the fact (webhook receipt resolution). */
export async function setPaymentReceipt(
  pool: pg.Pool,
  id: string,
  receipt: { chargeId: string | null; receiptUrl: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE payments
     SET charge_id = COALESCE($2, charge_id), receipt_url = COALESCE($3, receipt_url), updated_at = now()
     WHERE id = $1`,
    [id, receipt.chargeId, receipt.receiptUrl],
  );
}

/**
 * Ceiling on one page of an engagement's payment attempts.
 *
 * A row per checkout session, kept whether it completed or not — a client who
 * abandons the card form three times leaves three rows — plus refunds and
 * disputes. Nothing prunes them, so the list grows with attempts rather than
 * with payments. Shares the ledger page size with the billing screen below.
 */
export async function listPayments(
  pool: pg.Pool,
  valuationId: string,
): Promise<{ payments: PaymentRow[]; truncated: boolean }> {
  const { rows } = await pool.query<PaymentRow>(
    'SELECT * FROM payments WHERE valuation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [valuationId, BILLING_PAYMENT_PAGE_LIMIT + 1],
  );
  return {
    payments: rows.slice(0, BILLING_PAYMENT_PAGE_LIMIT),
    truncated: rows.length > BILLING_PAYMENT_PAGE_LIMIT,
  };
}

// ── Account-level billing rollup (P2 #13) ────────────────────────────────────

/** Payment row + enough valuation context to render the billing table. */
export interface BillingPaymentRow extends PaymentRow {
  valuation_number: string;
  company_name: string;
  kind: string;
}

export interface UnpaidValuationRow {
  id: string;
  number: string;
  company_name: string;
  kind: string;
  currency: string;
  /** Selected so the billing page can quote the band, not just the entry price. */
  amount_raised_cents: string | null;
}

function scopeWhere(scope: ValuationScope, params: unknown[]): string {
  switch (scope.kind) {
    case 'all':
      return 'TRUE';
    case 'partner':
      params.push(scope.partnerId);
      return `v.partner_id = $${params.length}`;
    case 'own':
      params.push(scope.userId);
      return `v.user_id = $${params.length}`;
    case 'none':
      return 'FALSE';
  }
}

/**
 * Ceiling on one page of the payment ledger.
 *
 * Five hundred was already the cap; what it lacked was a way to say so. This
 * list is not only drawn as a table — `collectedTotals` sums it into the
 * "collected to date" figure on the billing page — so past the cap the page
 * did not merely show a short history, it stated a total that was less money
 * than the customer has actually paid us, with no indication anything was
 * missing. An ops principal's scope is every payment on the platform, which is
 * the scope that reaches five hundred first.
 */
export const BILLING_PAYMENT_PAGE_LIMIT = 500;

/** Every payment across the scope's valuations, newest first. */
export async function listPaymentsForScope(
  pool: pg.Pool,
  scope: ValuationScope,
  opts: { limit?: number } = {},
): Promise<{ payments: BillingPaymentRow[]; truncated: boolean }> {
  const params: unknown[] = [];
  const where = scopeWhere(scope, params);
  const limit = Math.min(Math.max(opts.limit ?? BILLING_PAYMENT_PAGE_LIMIT, 1), BILLING_PAYMENT_PAGE_LIMIT);
  params.push(limit + 1);
  const { rows } = await pool.query<BillingPaymentRow>(
    `SELECT p.*, v.number::text AS valuation_number, v.company_name, v.kind::text AS kind
     FROM payments p
     JOIN valuations v ON v.id = p.valuation_id
     WHERE ${where}
     ORDER BY p.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return { payments: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * Unpaid, still-active engagements — the billing page's pay-now CTA.
 *
 * Archived engagements are excluded. This list is not a report, it is a demand
 * for money with a button beside it, and a retired engagement has already been
 * withdrawn from every list the payer can see — so the invoice named an
 * engagement they could not open. `state NOT IN ('cancelled','timeout')` was
 * already filtering finished work for the same reason; archiving is the other
 * way an engagement stops being collectable.
 *
 * {@link listPaymentsForScope} deliberately does *not* filter it. That is the
 * ledger: those payments were really taken, and money that left a customer's
 * account does not stop having done so because the engagement was later
 * retired. Dropping settled payments from their own history to match this list
 * would be the more serious bug of the two.
 */
/**
 * Ceiling on one page of the pay-now list.
 *
 * A hundred, and worth saying out loud because of what falls off it: an unpaid
 * engagement past the cap has no button anywhere in the product that starts
 * its checkout, and reads to the payer as work that has already been settled.
 */
export const UNPAID_VALUATION_PAGE_LIMIT = 100;

export async function listUnpaidValuationsForScope(
  pool: pg.Pool,
  scope: ValuationScope,
  opts: { limit?: number } = {},
): Promise<{ unpaid: UnpaidValuationRow[]; truncated: boolean }> {
  const params: unknown[] = [];
  const where = scopeWhere(scope, params);
  const limit = Math.min(Math.max(opts.limit ?? UNPAID_VALUATION_PAGE_LIMIT, 1), UNPAID_VALUATION_PAGE_LIMIT);
  params.push(limit + 1);
  const { rows } = await pool.query<UnpaidValuationRow>(
    `SELECT v.id, v.number::text AS number, v.company_name, v.kind::text AS kind, v.currency,
            v.amount_raised_cents::text AS amount_raised_cents
     FROM valuations v
     WHERE ${where} AND v.archived_at IS NULL
       AND v.paid_status = 'unpaid' AND v.state NOT IN ('cancelled', 'timeout')
     ORDER BY v.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return { unpaid: rows.slice(0, limit), truncated: rows.length > limit };
}
