/**
 * Payment lifecycle rules for money moving back out — refunds and disputes.
 *
 * Pure, so the decisions that revoke a paid engagement (and therefore un-bill a
 * client) are unit-testable without Stripe, the DB, or a webhook. The webhook
 * in routes/payments.ts does the I/O; everything it *decides* lives here.
 */

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
    }
  }
  return {
    gross_cents: gross,
    refunded_cents: refunded,
    paid_cents: Math.max(0, gross - refunded),
    succeeded_count: succeeded,
    refunded_count: refundedCount,
    payment_count: payments.length,
  };
}
