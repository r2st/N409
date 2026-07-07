import type pg from 'pg';
import { newUlid } from '@n409/shared';

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

export async function findPaymentBySessionId(
  pool: pg.Pool,
  sessionId: string,
): Promise<PaymentRow | null> {
  const { rows } = await pool.query<PaymentRow>('SELECT * FROM payments WHERE session_id = $1', [
    sessionId,
  ]);
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
