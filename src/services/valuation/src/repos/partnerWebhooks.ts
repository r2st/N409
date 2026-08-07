import type pg from 'pg';
import { newUlid } from '@n409/shared';

export interface PartnerWebhookRow {
  id: string;
  partner_id: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  event_type: string;
  valuation_id: string | null;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
}

export async function createWebhook(
  pool: pg.Pool,
  args: { partnerId: string; url: string; secret: string; events: string[]; createdBy: string },
): Promise<PartnerWebhookRow> {
  const { rows } = await pool.query<PartnerWebhookRow>(
    `INSERT INTO partner_webhooks (id, partner_id, url, secret, events, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newUlid(), args.partnerId, args.url, args.secret, args.events, args.createdBy],
  );
  return rows[0]!;
}

export async function listWebhooks(pool: pg.Pool, partnerId: string): Promise<PartnerWebhookRow[]> {
  const { rows } = await pool.query<PartnerWebhookRow>(
    'SELECT * FROM partner_webhooks WHERE partner_id = $1 ORDER BY created_at',
    [partnerId],
  );
  return rows;
}

export async function findWebhook(
  pool: pg.Pool,
  partnerId: string,
  id: string,
): Promise<PartnerWebhookRow | null> {
  const { rows } = await pool.query<PartnerWebhookRow>(
    'SELECT * FROM partner_webhooks WHERE id = $1 AND partner_id = $2',
    [id, partnerId],
  );
  return rows[0] ?? null;
}

export async function deleteWebhook(pool: pg.Pool, partnerId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM partner_webhooks WHERE id = $1 AND partner_id = $2', [
    id,
    partnerId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Enabled webhooks for a partner — what a delivery run fans out over. */
export async function enabledWebhooks(pool: pg.Pool, partnerId: string): Promise<PartnerWebhookRow[]> {
  const { rows } = await pool.query<PartnerWebhookRow>(
    'SELECT * FROM partner_webhooks WHERE partner_id = $1 AND enabled',
    [partnerId],
  );
  return rows;
}

/** Written before the attempt: a crash leaves 'pending', never a silent gap. */
export async function recordDelivery(
  pool: pg.Pool,
  args: {
    webhookId: string;
    eventType: string;
    valuationId?: string | null;
    payload: Record<string, unknown>;
  },
): Promise<WebhookDeliveryRow> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `INSERT INTO partner_webhook_deliveries (id, webhook_id, event_type, valuation_id, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [newUlid(), args.webhookId, args.eventType, args.valuationId ?? null, JSON.stringify(args.payload)],
  );
  return rows[0]!;
}

export async function markDelivery(
  pool: pg.Pool,
  id: string,
  status: 'delivered' | 'failed',
  error?: string,
): Promise<void> {
  await pool.query(
    `UPDATE partner_webhook_deliveries
     SET status = $2, attempts = attempts + 1, last_error = $3,
         delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END
     WHERE id = $1`,
    [id, status, error ?? null],
  );
}

export async function listDeliveries(
  pool: pg.Pool,
  webhookId: string,
  limit = 50,
): Promise<WebhookDeliveryRow[]> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `SELECT * FROM partner_webhook_deliveries WHERE webhook_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [webhookId, limit],
  );
  return rows;
}

// ── Idempotency ───────────────────────────────────────────────────────────────

export interface IdempotencyRow {
  partner_id: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_body: Record<string, unknown>;
  created_at: Date;
}

export async function findIdempotentResponse(
  pool: pg.Pool,
  partnerId: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const { rows } = await pool.query<IdempotencyRow>(
    'SELECT * FROM partner_api_idempotency WHERE partner_id = $1 AND idempotency_key = $2',
    [partnerId, key],
  );
  return rows[0] ?? null;
}

/**
 * First writer wins; a concurrent duplicate leaves the original response in
 * place, which is exactly what a replay should see.
 */
export async function storeIdempotentResponse(
  pool: pg.Pool,
  args: {
    partnerId: string;
    key: string;
    requestHash: string;
    status: number;
    body: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO partner_api_idempotency
       (partner_id, idempotency_key, request_hash, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (partner_id, idempotency_key) DO NOTHING`,
    [args.partnerId, args.key, args.requestHash, args.status, JSON.stringify(args.body)],
  );
}
