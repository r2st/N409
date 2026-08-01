import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { ValuationScope } from '../auth/rbac.js';

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'expired';

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
  },
): Promise<PaymentRow> {
  const { rows } = await pool.query<PaymentRow>(
    `INSERT INTO payments (id, valuation_id, session_id, amount_cents, currency, checkout_url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      newUlid(),
      input.valuationId,
      input.sessionId,
      input.amountCents,
      input.currency.toUpperCase(),
      input.checkoutUrl ?? null,
      input.createdBy ?? null,
    ],
  );
  return rows[0]!;
}

export async function findPaymentBySessionId(pool: pg.Pool, sessionId: string): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>('SELECT * FROM payments WHERE session_id = $1', [sessionId]);
  return rows[0] ?? null;
}

export async function markPayment(
  pool: pg.Pool,
  id: string,
  status: Exclude<PaymentStatus, 'pending'>,
  extra: { paymentIntentId?: string | null; chargeId?: string | null; receiptUrl?: string | null } = {},
): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>(
    `UPDATE payments
     SET status = $2,
         payment_intent_id = COALESCE($3, payment_intent_id),
         charge_id = COALESCE($4, charge_id),
         receipt_url = COALESCE($5, receipt_url),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, status, extra.paymentIntentId ?? null, extra.chargeId ?? null, extra.receiptUrl ?? null],
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

export async function listPayments(pool: pg.Pool, valuationId: string): Promise<PaymentRow[]> {
  const { rows } = await pool.query<PaymentRow>(
    'SELECT * FROM payments WHERE valuation_id = $1 ORDER BY created_at DESC',
    [valuationId],
  );
  return rows;
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

/** Every payment across the scope's valuations, newest first. */
export async function listPaymentsForScope(
  pool: pg.Pool,
  scope: ValuationScope,
): Promise<BillingPaymentRow[]> {
  const params: unknown[] = [];
  const where = scopeWhere(scope, params);
  const { rows } = await pool.query<BillingPaymentRow>(
    `SELECT p.*, v.number::text AS valuation_number, v.company_name, v.kind::text AS kind
     FROM payments p
     JOIN valuations v ON v.id = p.valuation_id
     WHERE ${where}
     ORDER BY p.created_at DESC
     LIMIT 500`,
    params,
  );
  return rows;
}

/** Unpaid, still-active engagements — the billing page's pay-now CTA. */
export async function listUnpaidValuationsForScope(
  pool: pg.Pool,
  scope: ValuationScope,
): Promise<UnpaidValuationRow[]> {
  const params: unknown[] = [];
  const where = scopeWhere(scope, params);
  const { rows } = await pool.query<UnpaidValuationRow>(
    `SELECT v.id, v.number::text AS number, v.company_name, v.kind::text AS kind, v.currency
     FROM valuations v
     WHERE ${where} AND v.paid_status = 'unpaid' AND v.state NOT IN ('cancelled', 'timeout')
     ORDER BY v.created_at DESC
     LIMIT 100`,
    params,
  );
  return rows;
}
