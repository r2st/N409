/**
 * Order lifecycle rules.
 *
 * The `orders` table was added in migration 0209 for the self-serve pricing
 * flow and had no transition table — `updateOrderStatus` accepted any of the
 * four statuses from any other, and neither of its two writers was ever called.
 * An order created at checkout stayed `pending` forever: the billing webhook
 * recorded the subscription and never touched the order row, so `/me/orders`
 * showed every purchase as pending regardless of what Stripe had done with it.
 *
 * This file is the machine the table needs, following the same pattern as
 * `domain/payments.ts` and `domain/billing.ts`.
 */

export const ORDER_STATUSES = ['pending', 'active', 'completed', 'canceled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Legal onward moves. An empty list is terminal.
 *
 * `pending` is where every order starts (a Checkout Session was opened).
 * `active` is a subscription that Stripe confirmed — it stays active until
 * the subscription ends. `completed` is a one-time purchase that settled.
 * `canceled` is a checkout that was never completed, or a subscription that
 * was later cancelled.
 *
 * `active → canceled` is the subscription ending (cancellation, expiry,
 * chargeback). `active → completed` is not an edge: a subscription does not
 * "complete", it runs until it is cancelled.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['active', 'completed', 'canceled'],
  active: ['canceled'],
  completed: [],
  canceled: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}
