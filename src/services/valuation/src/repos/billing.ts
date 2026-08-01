import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { PlanLimit, InvoiceLineItem } from '../domain/billing.js';

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

export const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'] as const;

export async function findActiveSubscription(pool: pg.Pool, userId: string): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<SubscriptionRow>(
    `SELECT * FROM subscriptions
      WHERE user_id = $1 AND status IN ('active', 'trialing', 'past_due')
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** Create or reactivate the user's subscription for a plan (webhook-driven). */
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
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         -- New billing period resets usage.
         valuations_used = CASE
           WHEN EXCLUDED.current_period_start IS DISTINCT FROM subscriptions.current_period_start
           THEN 0 ELSE subscriptions.valuations_used END,
         canceled_at = CASE WHEN EXCLUDED.status = 'canceled' THEN now() ELSE NULL END
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
    return rows[0]!;
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

export async function cancelSubscription(pool: pg.Pool, stripeSubscriptionId: string): Promise<void> {
  await pool.query(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = now()
      WHERE stripe_subscription_id = $1`,
    [stripeSubscriptionId],
  );
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
        AND s.status IN ('active', 'trialing', 'past_due')
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

export async function listAllSubscriptions(pool: pg.Pool): Promise<AdminSubscription[]> {
  const { rows } = await pool.query(
    `SELECT s.*, u.email, p.name AS plan_name, p.valuation_limit, p.price_cents, p.interval
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN plan_limits p ON p.tier = s.plan_tier
      ORDER BY s.created_at DESC`,
  );
  return rows as AdminSubscription[];
}

// ── Invoices ──────────────────────────────────────────────────────────────────

export interface InvoiceRow {
  id: string;
  number: string;
  user_id: string;
  subscription_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'draft' | 'open' | 'paid' | 'void';
  period_start: Date | null;
  period_end: Date | null;
  line_items: InvoiceLineItem[];
  stripe_invoice_id: string | null;
  issued_at: Date;
  paid_at: Date | null;
  created_at: Date;
}

/** Next monotonic invoice sequence for the issue month (for the number). */
export async function nextInvoiceSequence(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM invoices
      WHERE date_trunc('month', issued_at) = date_trunc('month', now())`,
  );
  return Number(rows[0]?.n ?? 0) + 1;
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
      input.status ?? 'open',
      input.periodStart ?? null,
      input.periodEnd ?? null,
      JSON.stringify(input.lineItems),
      input.stripeInvoiceId ?? null,
      input.paidAt ?? null,
    ],
  );
  return rows[0]!;
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

export async function listAllInvoices(
  pool: pg.Pool,
  limit = 200,
): Promise<Array<InvoiceRow & { email: string }>> {
  const { rows } = await pool.query(
    `SELECT i.*, u.email FROM invoices i JOIN users u ON u.id = i.user_id
      ORDER BY i.issued_at DESC LIMIT $1`,
    [limit],
  );
  return rows as Array<InvoiceRow & { email: string }>;
}
