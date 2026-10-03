import type pg from 'pg';
import { newUlid } from '@n409/shared';

export interface OrderRow {
  id: string;
  user_id: string;
  plan_tier: string;
  company_name: string;
  company_url: string | null;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'active' | 'completed' | 'canceled';
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

export async function updateOrderStatus(
  pool: pg.Pool,
  id: string,
  status: OrderRow['status'],
): Promise<void> {
  await pool.query(`UPDATE orders SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}

export async function updateOrderStripeSubscription(
  pool: pg.Pool,
  stripeCheckoutId: string,
  stripeSubscriptionId: string,
  status: OrderRow['status'],
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
