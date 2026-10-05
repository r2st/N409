import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { type OrderStatus, canTransitionOrder } from '../domain/orderLifecycle.js';

export interface OrderRow {
  id: string;
  user_id: string;
  plan_tier: string;
  company_name: string;
  company_url: string | null;
  amount_cents: number;
  currency: string;
  status: OrderStatus;
  stripe_checkout_id: string | null;
  stripe_subscription_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateOrderParams {
  userId: string;
  planTier: string;
  companyName: string;
  companyUrl: string | null;
  amountCents: number;
  currency: string;
  stripeCheckoutId: string | null;
}

export async function createOrder(pool: pg.Pool, params: CreateOrderParams): Promise<OrderRow> {
  const id = newUlid();
  const { rows } = await pool.query<OrderRow>(
    `INSERT INTO orders (id, user_id, plan_tier, company_name, company_url, amount_cents, currency, stripe_checkout_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      params.userId,
      params.planTier,
      params.companyName,
      params.companyUrl,
      params.amountCents,
      params.currency,
      params.stripeCheckoutId,
    ],
  );
  return rows[0]!;
}

export async function listOrdersForUser(pool: pg.Pool, userId: string): Promise<OrderRow[]> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );
  return rows;
}

/**
 * Move an order to a new status, only from a status the lifecycle permits.
 *
 * Returns the updated row, or null when the WHERE declined: either the row
 * does not exist, or it is already in a state from which the requested
 * transition is illegal (terminal, or wrong direction). The caller can tell
 * which by having looked the row up beforehand.
 *
 * The `from` guard is the whole fix: `updateOrderStatus` previously accepted
 * any status and wrote it unconditionally, so a completed or canceled order
 * could be moved back to pending — and more importantly, nothing called it at
 * all, so every order stayed pending forever.
 */
export async function updateOrderStatus(
  pool: pg.Pool,
  id: string,
  status: OrderStatus,
  opts: { from?: readonly OrderStatus[] } = {},
): Promise<OrderRow | null> {
  const from = opts.from ?? (ORDER_STATUSES_FROM[status] as readonly OrderStatus[] | undefined);
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET status = $2, updated_at = now()
     WHERE id = $1 AND ($3::text[] IS NULL OR status::text = ANY($3::text[]))
     RETURNING *`,
    [id, status, from ? [...from] : null],
  );
  return rows[0] ?? null;
}

/**
 * The statuses each target may be reached from, derived from the transition
 * table so the WHERE clause and the domain rule cannot disagree.
 */
const ORDER_STATUSES_FROM: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: [],
  active: (['pending', 'active', 'completed', 'canceled'] as const).filter((f) => canTransitionOrder(f, 'active')),
  completed: (['pending', 'active', 'completed', 'canceled'] as const).filter((f) => canTransitionOrder(f, 'completed')),
  canceled: (['pending', 'active', 'completed', 'canceled'] as const).filter((f) => canTransitionOrder(f, 'canceled')),
};

/**
 * Fulfil a subscription order: record the Stripe subscription id and move the
 * order to `active`. Guarded: only a `pending` order can be activated.
 *
 * Returns the updated row, or null when no pending order matched that checkout
 * session — either the order does not exist, or it was already fulfilled by an
 * earlier delivery of the same event.
 */
export async function fulfillSubscriptionOrder(
  pool: pg.Pool,
  stripeCheckoutId: string,
  stripeSubscriptionId: string,
): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET stripe_subscription_id = $2, status = 'active', updated_at = now()
     WHERE stripe_checkout_id = $1 AND status = 'pending'
     RETURNING *`,
    [stripeCheckoutId, stripeSubscriptionId],
  );
  return rows[0] ?? null;
}

/**
 * Fulfil a one-time order: move to `completed`. Guarded the same way.
 */
export async function fulfillOneTimeOrder(
  pool: pg.Pool,
  stripeCheckoutId: string,
): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET status = 'completed', updated_at = now()
     WHERE stripe_checkout_id = $1 AND status = 'pending'
     RETURNING *`,
    [stripeCheckoutId],
  );
  return rows[0] ?? null;
}

/**
 * Cancel the order for a subscription that has ended.
 */
export async function cancelOrderBySubscription(
  pool: pg.Pool,
  stripeSubscriptionId: string,
): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET status = 'canceled', updated_at = now()
     WHERE stripe_subscription_id = $1 AND status = 'active'
     RETURNING *`,
    [stripeSubscriptionId],
  );
  return rows[0] ?? null;
}

/** @deprecated Use {@link fulfillSubscriptionOrder} instead. */
export async function updateOrderStripeSubscription(
  pool: pg.Pool,
  stripeCheckoutId: string,
  stripeSubscriptionId: string,
  status: OrderStatus,
): Promise<void> {
  await pool.query(
    `UPDATE orders SET stripe_subscription_id = $2, status = $3, updated_at = now()
     WHERE stripe_checkout_id = $1`,
    [stripeCheckoutId, stripeSubscriptionId, status],
  );
}

export async function findOrderByCheckoutId(
  pool: pg.Pool,
  stripeCheckoutId: string,
): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT * FROM orders WHERE stripe_checkout_id = $1`,
    [stripeCheckoutId],
  );
  return rows[0] ?? null;
}
