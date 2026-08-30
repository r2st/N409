/**
 * Payment lifecycle rules for money moving back out — refunds and disputes.
 *
 * Pure, so the decisions that revoke a paid engagement (and therefore un-bill a
 * client) are unit-testable without Stripe, the DB, or a webhook. The webhook
 * in routes/payments.ts does the I/O; everything it *decides* lives here.
 */

/**
 * Every status a `payments` row can hold — the five the `payment_status` enum
 * names (migrations 0041 and 0099), written here so the repo, the routes and
 * the browser read one list rather than each restating it.
 *
 * {@link PAYMENT_TRANSITIONS} is the other half, and it is the half that was
 * stated nowhere. The set of statuses was in the schema; which of them may
 * follow which was spread across four `markPayment` call sites, two UPDATEs
 * whose WHERE clauses are the real guard, and the reasoning in their comments.
 * R203 fixed a replayed settlement that marked a refunded row succeeded again,
 * and it was fixed by adding a `from` to one call — a machine nobody could read
 * is a machine nobody can check.
 */
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'expired', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Legal onward moves, per status. An empty list is terminal.
 *
 * A row is born `pending` when a Checkout Session is opened and leaves that
 * state exactly once: the money lands (`succeeded`), the delayed debit bounces
 * (`failed`), or the session is closed without paying (`expired`, either by
 * Stripe's 24-hour clock or by the checkout route reopening at a new price).
 *
 * `refunded` follows `succeeded` and nothing else, by both routes money leaves:
 * a `charge.refunded` returning the whole charge, and a chargeback decided
 * against us. It is not reachable from `failed` or `expired` — there is no
 * money on those rows to return — and not from `pending`, which is the
 * transition that would say a charge we never recorded as settled had been
 * given back.
 *
 * A partial refund is *not* an edge. The row stays `succeeded` and the amount
 * goes to `refunded_cents`, for the same reason a refunded Stripe invoice stays
 * `paid`: the client still bought the report and still holds it. An open
 * chargeback is not an edge either — the money is held, not lost, and the case
 * is answerable — which is why it lives in `dispute_status` beside the status
 * rather than inside it.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ['succeeded', 'failed', 'expired'],
  succeeded: ['refunded'],
  failed: [],
  expired: [],
  refunded: [],
};

/**
 * The status a row may be *created* in. One: a payment row exists because a
 * Checkout Session was opened, and every other status is something that
 * happened to it afterwards.
 */
export const PAYMENT_INITIAL_STATUSES = ['pending'] as const;

/** May a payment in `from` be moved to `to`? Same-status is not a move. */
export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Nothing legally follows this status. */
export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[status].length === 0;
}

/**
 * The statuses a refund or a chargeback may be recorded against.
 *
 * Money coming back is a fact about money that arrived, so the two writers of
 * `refunded` only ever act on a row that already settled — `refunded` included,
 * because a second partial refund and a chargeback lost after a part refund
 * both land on a row that is already there. Stated here so the WHERE clauses in
 * repos/payments.ts and the machine above cannot drift apart.
 */
export const PAYMENT_REVERSIBLE_STATUSES = ['succeeded', 'refunded'] as const;

/** Stripe's dispute lifecycle, narrowed to the three outcomes we act on. */
export type DisputeStatus = 'open' | 'won' | 'lost';

/**
 * Stripe dispute status → ours.
 *
 * `won` and `lost` are the only terminal values; `warning_closed` closes an
 * early-warning enquiry that never became a chargeback, so the money was never
 * taken and the case is effectively won. Everything else — `needs_response`,
 * `under_review`, `warning_needs_response`, `warning_under_review` — is still
 * live and maps to 'open'. Unknown values are treated as open rather than won,
 * because the damaging way to guess wrong is to quietly close a case that is
 * still running against a deadline.
 */
export function disputeStatusOf(stripeStatus: unknown): DisputeStatus {
  if (stripeStatus === 'lost') return 'lost';
  if (stripeStatus === 'won' || stripeStatus === 'warning_closed') return 'won';
  return 'open';
}

export interface RefundState {
  /** Cumulative cents refunded against the charge, clamped to [0, amount]. */
  refundedCents: number;
  /** Cents we still hold. */
  remainingCents: number;
  /** Nothing left — the engagement is no longer paid for. */
  fullyRefunded: boolean;
  /** Some, but not all, was returned. Recorded; does not revoke. */
  partiallyRefunded: boolean;
}

/**
 * What a `charge.refunded` event means for the payment it names.
 *
 * Stripe sends the charge's *running* `amount_refunded`, so this takes a total
 * and not a delta — a redelivered event recomputes the same state instead of
 * double-counting. A partial refund (a goodwill credit, a corrected fee) leaves
 * the engagement paid: the client still bought the report and still has it.
 * Only a refund that returns everything takes the paid status back.
 *
 * `amountRefunded` is clamped rather than trusted: a non-finite or negative
 * value would otherwise flow into a bigint column, and one greater than the
 * charge should still just mean "all of it".
 */
export function refundState(args: { amountCents: number; amountRefunded: unknown }): RefundState {
  const amount = Number(args.amountCents);
  const raw = Number(args.amountRefunded);
  const total = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const refunded = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), total) : 0;
  const remaining = total - refunded;
  return {
    refundedCents: refunded,
    remainingCents: remaining,
    fullyRefunded: total > 0 && remaining === 0,
    partiallyRefunded: refunded > 0 && remaining > 0,
  };
}

/**
 * A dispute lost is a refund we did not choose: Stripe has already pulled the
 * money (plus a fee we never see here). Treating it as a full refund is what
 * makes the two paths converge on the same revocation.
 */
export function disputeRevokesPayment(status: DisputeStatus): boolean {
  return status === 'lost';
}

export interface MoneyRow {
  status: string;
  amount_cents: string | number;
  refunded_cents?: string | number | null;
  /**
   * The engagement's own currency (`valuations.currency`, copied onto the
   * payment at checkout). Optional because a caller that only wants the counts
   * has nothing to say about it, and a row with none is read as the platform
   * default — which is what the column defaults to.
   */
  currency?: string | null;
}

export interface CollectedTotals {
  /** Gross of every succeeded payment, before anything went back. */
  gross_cents: number;
  /** Everything returned, whether by refund or by a lost chargeback. */
  refunded_cents: number;
  /** What we actually kept. This is the number a client's billing page shows. */
  paid_cents: number;
  succeeded_count: number;
  refunded_count: number;
  payment_count: number;
  /**
   * The currency the three money figures above are in.
   *
   * They are sums of integer minor units, and minor units are only comparable
   * inside one currency — ¥100,000 and $1,000.00 both arrive as `100000`. The
   * billing page rendered them through a formatter with no currency at all, so
   * they were printed as dollars whatever they were made of, while the rows
   * beneath them were each rendered in their own currency and visibly did not
   * add up to the card above.
   *
   * `valuations.currency` is chosen per engagement and copied onto the payment
   * at checkout, so a client holding a dollar engagement and a euro one is an
   * ordinary account rather than an exotic one.
   *
   * Falls back to the platform default when there is no single answer — nothing
   * collected, or more than one currency. {@link CollectedTotals.mixed_currency}
   * is what says which, and this is only a claim about the denomination when
   * that flag is false.
   */
  currency: string;
  /** The figures span more than one currency, and are a running number rather
   * than an amount. Reported, not resolved: the per-row table below them is the
   * honest breakdown, and refusing to label a mixed sum is the part that has to
   * be true first. */
  mixed_currency: boolean;
}

const cents = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Billing-page totals, net of money returned.
 *
 * `paid_cents` used to be the sum of every 'succeeded' row, which after a
 * refund or a chargeback was a number the client could disprove from their own
 * card statement. A fully refunded row is no longer 'succeeded' (it is
 * 'refunded'), and a partially refunded one still is — so both the status and
 * the refunded column have to be read to get this right.
 */
export function collectedTotals(payments: readonly MoneyRow[]): CollectedTotals {
  let gross = 0;
  let refunded = 0;
  let succeeded = 0;
  let refundedCount = 0;
  // Only the rows the figures are actually made of. A pending or expired
  // checkout in another currency is not inside any of the three sums, so
  // calling the totals mixed on its account would be a warning about nothing.
  const currencies = new Set<string>();
  for (const p of payments) {
    const amount = cents(p.amount_cents);
    const back = Math.min(cents(p.refunded_cents), amount);
    if (p.status === 'succeeded') {
      gross += amount;
      refunded += back;
      succeeded += 1;
    } else if (p.status === 'refunded') {
      gross += amount;
      // A row reaching 'refunded' without a recorded amount (a lost dispute
      // predating this column, say) still returned the whole charge.
      refunded += back > 0 ? back : amount;
      refundedCount += 1;
    } else {
      continue;
    }
    currencies.add((p.currency ?? DEFAULT_PAYMENT_CURRENCY).trim().toLowerCase());
  }
  const only = currencies.size === 1 ? [...currencies][0]! : DEFAULT_PAYMENT_CURRENCY;
  return {
    gross_cents: gross,
    refunded_cents: refunded,
    paid_cents: Math.max(0, gross - refunded),
    succeeded_count: succeeded,
    refunded_count: refundedCount,
    payment_count: payments.length,
    currency: only,
    mixed_currency: currencies.size > 1,
  };
}

/**
 * What a money figure over nothing is denominated in — the same default
 * `valuations.currency` carries and both money formatters fall back to, so a
 * zero on the billing page is labelled the way the first payment will be.
 */
const DEFAULT_PAYMENT_CURRENCY = 'usd';
