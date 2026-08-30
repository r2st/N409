/**
 * Which payments have a receipt, and where it lives.
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
