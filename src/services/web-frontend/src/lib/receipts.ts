/**
 * What a payment row is rendered as: which ones have a receipt, where it lives,
 * and what a chargeback verdict is called.
 *
 * Two documents exist for one charge and they are not interchangeable. Stripe's
 * `receipt_url` proves the card was charged and states a single gross figure;
 * ours states what the figure was made of and what is left after anything that
 * went back. The engagement's payment panel has always offered both side by
 * side, and the account-level billing page offered only Stripe's — so a client
 * reading their whole payment history could not reach the itemised document at
 * all, and saw a bare dash on any row whose `receipt_url` had not been resolved.
 *
 * Stated here rather than inline at each table so the two surfaces cannot
 * disagree about which rows have one. This service has no dependency on
 * `@n409/shared`, so the status list is a duplicate of the server's
 * `PAYMENT_SETTLED_STATUSES` — pinned from both sides by the receipt-affordance
 * cases in test/BillingPage.test.tsx and test/PaymentSection.test.tsx and by
 * the route's own refusals in the valuation service's payments integration
 * test.
 */

/**
 * The statuses that mean the money arrived. `refunded` is a settled payment
 * whose money went back, not an unsettled one: it is precisely the row whose
 * receipt has to say so, and the server issues one for it.
 */
export const SETTLED_PAYMENT_STATUSES = ['succeeded', 'refunded'] as const;

export function hasSettled(status: string): boolean {
  return (SETTLED_PAYMENT_STATUSES as readonly string[]).includes(status);
}

/** Where the itemised receipt for a settled payment is served from. */
export function itemisedReceiptHref(payment: { id: string; valuation_id: string }): string {
  return `/api/v1/valuations/${payment.valuation_id}/payments/${payment.id}/receipt.pdf`;
}

/**
 * What each chargeback verdict is called, in the tense it happened in.
 *
 * `dispute_status` is written once per verdict and never cleared, so all three
 * are permanent properties of the row and each needs its own wording — a case
 * we won is not a case that is running.
 *
 * Lifted out of PaymentSection because the account billing page rendered only
 * `=== 'open'`, which left a *lost* chargeback indistinguishable from a
 * voluntary refund: the row's status is 'refunded' either way, and the refund
 * annotation beside it is suppressed for a fully refunded row. So the page that
 * lists every payment — the one an operator scans across accounts — could not
 * tell money we chose to return from money a bank took back.
 */
export const DISPUTE_STATUS_LABELS: Record<string, string> = {
  open: 'Chargeback under review',
  won: 'Chargeback resolved in our favour',
  lost: 'Chargeback upheld',
};

/**
 * The label for a verdict, or the raw value for one this build has no wording
 * for. `dispute_status` is a text column fed from Stripe's own vocabulary,
 * which is wider than ours, and an unnamed verdict is still a fact about the
 * money that the reader has to be told.
 */
export function disputeLabel(status: string): string {
  return DISPUTE_STATUS_LABELS[status] ?? status;
}
