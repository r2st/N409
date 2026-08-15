import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { WEBHOOK_MAX_ATTEMPTS } from '../domain/partnerWebhooks.js';

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
  /** 'pending' = another attempt is owed; 'failed' = terminal. See 0103. */
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
  /** When the retry sweep may next take this row. */
  next_attempt_at: Date;
  /** Lease held by the sweeper currently attempting this row; null when free. */
  claimed_at: Date | null;
  max_attempts: number;
}

/** A claimed delivery joined to the endpoint it must be POSTed to. */
export interface ClaimedDelivery extends WebhookDeliveryRow {
  url: string;
  secret: string;
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

/**
 * Written before the attempt: a crash leaves a row behind, never a silent gap.
 *
 * The row is born claimed with one attempt already counted, because the caller
 * POSTs it immediately — exactly what `claimRetryableDeliveries` does for a
 * retry. Inserting it free would let a sweep running at that moment take the
 * same row and deliver the event twice.
 */
export async function recordDelivery(
  pool: pg.Pool,
  args: {
    webhookId: string;
    eventType: string;
    valuationId?: string | null;
    payload: Record<string, unknown>;
    maxAttempts?: number;
  },
): Promise<WebhookDeliveryRow> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `INSERT INTO partner_webhook_deliveries
       (id, webhook_id, event_type, valuation_id, payload, attempts, claimed_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5, 1, now(), $6) RETURNING *`,
    [
      newUlid(),
      args.webhookId,
      args.eventType,
      args.valuationId ?? null,
      JSON.stringify(args.payload),
      // From the domain constant, not a literal. This read `coalesce($6, 4)`,
      // which was a second copy of the ceiling in a place no migration could
      // reach: extending the backoff ladder and raising the column default did
      // nothing at all, because every row inserted here already carried the 4
      // and `retryDelayMinutes` stops at the row's own max_attempts.
      args.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS,
    ],
  );
  return rows[0]!;
}

/**
 * Settles an attempt. Unlike the pre-0103 `markDelivery` this does not count an
 * attempt — the insert or the claim already did — and it releases the lease.
 *
 * `nextAttemptAt` null means terminal: out of attempts, or a response the
 * receiver told us not to repeat (see isPermanentDeliveryFailure). Anything
 * else stays 'pending' with its backoff stamped on, invisible to the sweep
 * until that time passes.
 */
export async function settleDelivery(
  pool: pg.Pool,
  id: string,
  outcome: { status: 'delivered' } | { status: 'failed'; error: string; nextAttemptAt: Date | null },
): Promise<void> {
  if (outcome.status === 'delivered') {
    await pool.query(
      `UPDATE partner_webhook_deliveries
          SET status = 'delivered', claimed_at = NULL, last_error = NULL, delivered_at = now()
        WHERE id = $1`,
      [id],
    );
    return;
  }
  await pool.query(
    `UPDATE partner_webhook_deliveries
        SET status = CASE WHEN $3::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
            claimed_at = NULL,
            last_error = $2,
            next_attempt_at = coalesce($3::timestamptz, next_attempt_at)
      WHERE id = $1`,
    [id, outcome.error, outcome.nextAttemptAt],
  );
}

/** Default lease: comfortably longer than any single delivery attempt. */
export const DELIVERY_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Atomically takes a batch of due deliveries for one sweeper.
 *
 * The same three ways to get two sweepers the email outbox has (the interval,
 * the ops-triggered route, and more than one instance against one database)
 * apply here, and delivering a partner's `report_ready` twice is a duplicated
 * downstream workflow on their side. SKIP LOCKED sends a concurrent sweeper to
 * the next batch instead of blocking on this one.
 *
 * The attempt is counted here rather than on settlement, so a POST that hangs
 * past the lease and never reports back still burns one; otherwise a receiver
 * that always times out would be retried forever.
 *
 * Only enabled webhooks are swept — a partner who turned an endpoint off should
 * not have its backlog arrive when they turn it back on.
 */
export async function claimRetryableDeliveries(
  pool: pg.Pool,
  opts: { limit?: number; leaseMs?: number } = {},
): Promise<ClaimedDelivery[]> {
  const leaseSeconds = Math.max(1, Math.floor((opts.leaseMs ?? DELIVERY_CLAIM_LEASE_MS) / 1000));
  const { rows } = await pool.query<ClaimedDelivery>(
    `WITH claimable AS (
       SELECT d.id FROM partner_webhook_deliveries d
         JOIN partner_webhooks w ON w.id = d.webhook_id
        WHERE d.status = 'pending'
          AND d.next_attempt_at <= now()
          AND d.attempts < d.max_attempts
          AND w.enabled
          AND (d.claimed_at IS NULL OR d.claimed_at < now() - ($1 || ' seconds')::interval)
        -- Oldest first: a backlog larger than one batch must not leave the
        -- earliest events permanently behind the newest ones.
        ORDER BY d.next_attempt_at ASC
        LIMIT $2
        FOR UPDATE OF d SKIP LOCKED
     )
     UPDATE partner_webhook_deliveries d
        SET claimed_at = now(), attempts = d.attempts + 1
       FROM claimable c, partner_webhooks w2
      WHERE d.id = c.id AND w2.id = d.webhook_id
      RETURNING d.*, w2.url AS url, w2.secret AS secret`,
    [String(leaseSeconds), Math.min(opts.limit ?? 100, 500)],
  );
  return rows;
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

/** Ops view: how much of the delivery backlog is owed, stuck or gone terminal. */
export async function deliveryBacklogStats(pool: pg.Pool): Promise<{
  pending: number;
  due: number;
  failed: number;
  delivered_24h: number;
}> {
  const { rows } = await pool.query<{
    pending: string;
    due: string;
    failed: string;
    delivered_24h: string;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')                              AS pending,
            count(*) FILTER (WHERE status = 'pending' AND next_attempt_at <= now()) AS due,
            count(*) FILTER (WHERE status = 'failed')                               AS failed,
            count(*) FILTER (WHERE status = 'delivered'
                              AND delivered_at > now() - interval '24 hours')       AS delivered_24h
       FROM partner_webhook_deliveries`,
  );
  const r = rows[0]!;
  return {
    pending: Number(r.pending),
    due: Number(r.due),
    failed: Number(r.failed),
    delivered_24h: Number(r.delivered_24h),
  };
}

/**
 * Re-opens a terminal delivery for one more round, used by the partner-facing
 * replay button. Attempts are reset so the full backoff ladder is available
 * again; a receiver that has been fixed deserves the same patience as a new
 * event, and the attempt history stays in the audit log either way.
 */
export async function requeueDelivery(
  pool: pg.Pool,
  partnerId: string,
  deliveryId: string,
): Promise<WebhookDeliveryRow | null> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `UPDATE partner_webhook_deliveries d
        SET status = 'pending', attempts = 0, claimed_at = NULL, next_attempt_at = now(),
            last_error = NULL
       FROM partner_webhooks w
      WHERE d.id = $1 AND w.id = d.webhook_id AND w.partner_id = $2
        AND d.status <> 'delivered'
      RETURNING d.*`,
    [deliveryId, partnerId],
  );
  return rows[0] ?? null;
}

// ── Idempotency ───────────────────────────────────────────────────────────────

export interface IdempotencyRow {
  partner_id: string;
  idempotency_key: string;
  request_hash: string;
  /** NULL while the claim is held and the request has not answered yet. */
  response_status: number | null;
  response_body: Record<string, unknown> | null;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * How long an unfinished claim holds its key before a later request may take
 * it over.
 *
 * The bound on a process dying between claiming a key and answering: until the
 * window passes, that key is unusable, and the partner sees "still in flight"
 * for a request that is not. Longer than any partner POST can legitimately run
 * — these create one row and return — and short enough that a crash is an
 * inconvenience rather than a support ticket.
 */
export const PARTNER_IDEMPOTENCY_STALE = '5 minutes';

export type IdempotencyClaim =
  /** The caller holds the key and must run the request. */
  | { kind: 'claimed' }
  /** A finished request already answered under this key; replay it. */
  | { kind: 'replay'; row: IdempotencyRow }
  /** The original is still running. The caller must not run a second one. */
  | { kind: 'in_flight' }
  /** This key was used for a different request body. */
  | { kind: 'mismatch' };

/**
 * Take the key, or find out who has it.
 *
 * The whole point is that this decides rather than reads (migration 0160). The
 * previous shape — look up, miss, run, record — cannot serialise two requests
 * that arrive together, because both look up before either records, and the
 * `ON CONFLICT DO NOTHING` that followed discarded the one piece of evidence
 * that they had collided.
 *
 * Here the insert *is* the arbitration. Exactly one of two concurrent claims
 * can insert the row; the other conflicts, and `DO UPDATE` gives it a row lock
 * so it blocks until the winner commits rather than racing it. The `WHERE` on
 * the update is what decides whether the loser gets to take over: it may only
 * do so when the row is unfinished *and* older than the takeover window, which
 * is the crashed-process case. A live claim, or a completed one, falls through
 * to the empty-result branch and is read back for what it is.
 *
 * `created_at` is when the claim was taken and a takeover resets it, so the
 * window is measured from the current holder rather than from the first one.
 */
export async function claimIdempotencyKey(
  pool: pg.Pool,
  args: { partnerId: string; key: string; requestHash: string },
): Promise<IdempotencyClaim> {
  const { rows: claimed } = await pool.query(
    `INSERT INTO partner_api_idempotency (partner_id, idempotency_key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (partner_id, idempotency_key) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            created_at = now()
      WHERE partner_api_idempotency.completed_at IS NULL
        AND partner_api_idempotency.created_at <= now() - $4::interval
     RETURNING partner_id`,
    [args.partnerId, args.key, args.requestHash, PARTNER_IDEMPOTENCY_STALE],
  );
  if (claimed.length > 0) return { kind: 'claimed' };

  const existing = await findIdempotentResponse(pool, args.partnerId, args.key);
  // The row was there a statement ago and the only thing that removes one is a
  // release by its own holder — so this is a request that failed, freeing the
  // key, between the two statements. Retrying the claim would be the honest
  // answer and a loop; reporting it in flight costs the caller one retry and
  // cannot double-create.
  if (!existing) return { kind: 'in_flight' };
  // Checked before completion, so a replay of a *different* body is refused
  // whether the original has answered yet or not.
  if (existing.request_hash !== args.requestHash) return { kind: 'mismatch' };
  return existing.completed_at === null ? { kind: 'in_flight' } : { kind: 'replay', row: existing };
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

/** Fill in the response the claim was taken for; every later replay sees this. */
export async function completeIdempotentResponse(
  pool: pg.Pool,
  args: {
    partnerId: string;
    key: string;
    status: number;
    body: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `UPDATE partner_api_idempotency
        SET response_status = $3, response_body = $4, completed_at = now()
      WHERE partner_id = $1 AND idempotency_key = $2 AND completed_at IS NULL`,
    [args.partnerId, args.key, args.status, JSON.stringify(args.body)],
  );
}

/**
 * Give the key back, for a request that refused before doing anything.
 *
 * Only for a clean refusal — a 4xx from validation, where nothing was written
 * and the partner is expected to correct the body and send it again under the
 * same key, which was the original code's stated intent. A request that *threw*
 * deliberately does not come through here: a throw is the one case where we do
 * not know whether the write landed, and handing the key back there would let
 * the retry create the second engagement this whole mechanism exists to
 * prevent. Those claims are released by the takeover window instead.
 */
export async function releaseIdempotencyClaim(pool: pg.Pool, partnerId: string, key: string): Promise<void> {
  await pool.query(
    `DELETE FROM partner_api_idempotency
      WHERE partner_id = $1 AND idempotency_key = $2 AND completed_at IS NULL`,
    [partnerId, key],
  );
}
