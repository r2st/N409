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

/** What the reaper stamps on a row it settles. */
export const DELIVERY_ABANDONED_ERROR =
  'abandoned: the final attempt never reported back (process lost mid-delivery)';

/**
 * Settles the one wedged state 0103 said could not exist.
 *
 * That migration's argument is that `claimed_at` is a lease rather than a
 * status, so a sweeper that dies mid-POST leaves a stamp that simply expires
 * and the row becomes claimable again — "no wedged state needing its own
 * reaper". It holds for every attempt but the last one. The claim counts the
 * attempt, so a process lost between claiming the *final* attempt and settling
 * it leaves `attempts = max_attempts` on a row still reading 'pending', and the
 * claim's own `d.attempts < d.max_attempts` then excludes it forever. Nothing
 * else writes that row: it is never retried, and it never reaches 'failed'.
 *
 * The cost is not a lost event — that attempt was the last one either way — it
 * is that nothing ever says so. The row sits in `deliveryBacklogStats` as
 * pending *and* due for the life of the table, so the backlog gauge ops watch
 * only ever climbs; and `GET /webhooks/{id}/deliveries` tells the partner an
 * event is still owed a retry that will never be tried. Both are the delivery
 * log stating something untrue, which is the one thing it exists not to do.
 *
 * 0139 papered over the instances that existed at the time — raising
 * `max_attempts` from 4 to 6 on every pending row made the wedged ones
 * claimable again as a side effect of a change about something else. That is
 * why the shape is worth a reaper rather than another one-off UPDATE.
 *
 * The lease must have expired before a row is taken. A row claimed a moment ago
 * on its final attempt has `attempts = max_attempts` and is in flight, not
 * wedged: its POST is still running and `settle` will write the true outcome. A
 * reaper without the lease check would race it and mark a delivery failed while
 * it was succeeding — the same wrong statement in the other direction.
 */
export async function failExhaustedDeliveries(
  pool: pg.Pool,
  opts: { leaseMs?: number; limit?: number } = {},
): Promise<WebhookDeliveryRow[]> {
  const leaseSeconds = Math.max(1, Math.floor((opts.leaseMs ?? DELIVERY_CLAIM_LEASE_MS) / 1000));
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `UPDATE partner_webhook_deliveries d
        SET status = 'failed',
            claimed_at = NULL,
            -- The error from the attempt before the lost one is more useful
            -- than this note, so it only fills a blank.
            last_error = coalesce(d.last_error, $3)
      WHERE d.id IN (
        SELECT id FROM partner_webhook_deliveries
         WHERE status = 'pending'
           AND attempts >= max_attempts
           -- A NULL lease is nobody holding the row, which for a row already
           -- out of attempts is the same wedge with the stamp cleared.
           AND (claimed_at IS NULL OR claimed_at < now() - ($1 || ' seconds')::interval)
         LIMIT $2
         -- Same discipline as the claim: two reapers split the set rather than
         -- both returning the rows the other already settled.
         FOR UPDATE SKIP LOCKED
      )
      RETURNING d.*`,
    [String(leaseSeconds), Math.min(opts.limit ?? 100, 500), DELIVERY_ABANDONED_ERROR],
  );
  return rows;
}

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

/**
 * One delivery, scoped to the partner that owns its webhook.
 *
 * A read, so it decides nothing — `requeueDelivery` is still the statement that
 * moves the row. It exists so the replay endpoint can answer "no such delivery"
 * *before* it claims an Idempotency-Key: a 404 raised after the claim holds
 * that key for the whole takeover window, so a partner correcting a mistyped id
 * and retrying under the same key would be told their first attempt is still in
 * flight for five minutes.
 */
export async function findDeliveryForPartner(
  pool: pg.Pool,
  partnerId: string,
  deliveryId: string,
): Promise<WebhookDeliveryRow | null> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `SELECT d.* FROM partner_webhook_deliveries d
       JOIN partner_webhooks w ON w.id = d.webhook_id
      WHERE d.id = $1 AND w.partner_id = $2`,
    [deliveryId, partnerId],
  );
  return rows[0] ?? null;
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

/** What 0103 stamped on the rows it retired when retries were introduced. */
export const DELIVERY_PREDATES_RETRIES_ERROR = 'abandoned: predates delivery retries';

/**
 * The oldest a failed delivery may be and still be worth replaying.
 *
 * A payload is a snapshot of a transition, not a pointer to current state — it
 * carries the state the valuation was in when the event fired. Replaying a
 * week-old `valuation.state_changed` therefore tells a partner about a
 * transition that has since been superseded, and because nothing orders
 * deliveries, it can land *after* the newer events that overtook it while it
 * sat in the queue. A partner tracking state from the stream is then walked
 * backwards, which is worse than the event they never got.
 *
 * Twenty-four hours is the window in which a payload is still broadly true and
 * comfortably longer than the full ladder (1+5+30+120+360 minutes ≈ 8.6h), so a
 * delivery that exhausted every attempt is still replayable for about as long
 * again. Beyond that the honest remedy is the partner re-reading the resource,
 * not us re-sending a stale description of it.
 */
export const DELIVERY_REPLAY_MAX_AGE_HOURS = 24;

/** A failed delivery with the partner and endpoint it belongs to. */
export interface FailedDeliveryRow {
  id: string;
  webhook_id: string;
  partner_id: string;
  url: string;
  enabled: boolean;
  event_type: string;
  valuation_id: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
  /** True while {@link DELIVERY_REPLAY_MAX_AGE_HOURS} has not elapsed. */
  replayable: boolean;
}

/**
 * The dead letter queue: which deliveries gave up, for whom, and why.
 *
 * `deliveryBacklogStats` answers "is anything not getting through" with a
 * count, and that was the whole operator view — the route that serves it says
 * of `failed` that "a failed row is terminal and nothing else will ever come
 * back for it". True, and it left ops holding a number with no next step. The
 * only replay in the service is `requeueDelivery`, which is partner-scoped and
 * takes one id at a time, so a receiver-side outage was a partner's problem to
 * notice and ours to be unable to help with — and an outage on *our* side, a
 * bad deploy that 500ed every POST for ten minutes, had no remedy at all: every
 * affected partner would have to find their own delivery ids and replay them
 * one by one, having never been told there was anything to replay.
 *
 * Ordered newest-first because that is the set an incident is about. The
 * endpoint URL is included and the route is ops-only: a partner's callback
 * address is their infrastructure, not something to widen access to.
 *
 * `payload` is deliberately not selected. The rows can be large, the listing is
 * a triage view, and a payload carries the valuation's company name and state.
 */
export async function listFailedDeliveries(
  pool: pg.Pool,
  opts: { limit?: number; partnerId?: string; maxAgeHours?: number } = {},
): Promise<FailedDeliveryRow[]> {
  const maxAgeHours = opts.maxAgeHours ?? DELIVERY_REPLAY_MAX_AGE_HOURS;
  const { rows } = await pool.query<FailedDeliveryRow>(
    `SELECT d.id, d.webhook_id, w.partner_id, w.url, w.enabled, d.event_type,
            d.valuation_id, d.attempts, d.max_attempts, d.last_error, d.created_at,
            (d.created_at > now() - ($3 || ' hours')::interval
             AND d.last_error IS DISTINCT FROM $4
             AND w.enabled) AS replayable
       FROM partner_webhook_deliveries d
       JOIN partner_webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'failed'
        AND ($2::text IS NULL OR w.partner_id = $2)
      ORDER BY d.created_at DESC
      LIMIT $1`,
    [
      Math.min(Math.max(opts.limit ?? 100, 1), 500),
      opts.partnerId ?? null,
      String(maxAgeHours),
      DELIVERY_PREDATES_RETRIES_ERROR,
    ],
  );
  return rows;
}

/**
 * Re-opens terminal deliveries in bulk, for an operator rather than a partner.
 *
 * The remedy for the case the partner-scoped replay cannot serve: our own
 * outage, where the deliveries that failed belong to many partners and none of
 * them did anything wrong. Attempts are reset for the same reason
 * {@link requeueDelivery} resets them — a receiver reachable again deserves the
 * ladder a new event would get.
 *
 * Three rows are refused rather than replayed, and each refusal is a payload
 * that would mislead the partner who received it:
 *
 *   * **Older than `maxAgeHours`.** See {@link DELIVERY_REPLAY_MAX_AGE_HOURS} —
 *     a stale transition arriving after the ones that superseded it.
 *   * **Retired by 0103.** Those rows predate retries entirely; the migration
 *     retired rather than replayed them for exactly this reason, and a bulk
 *     replay must not undo that decision by accident.
 *   * **On a disabled webhook.** `claimRetryableDeliveries` already declines to
 *     sweep these — a partner who turned an endpoint off should not have its
 *     backlog arrive when they turn it back on — and a replay that ignored the
 *     flag would deliver through the sweep a moment later anyway.
 *
 * `ids` scopes it to a reviewed set; omitting it replays everything eligible,
 * which is what an operator wants after confirming the cause was ours. Either
 * way the age and eligibility rules above apply — there is no override, because
 * the bound exists to protect the partner rather than to protect the operator
 * from a mistake.
 */
export async function replayFailedDeliveries(
  pool: pg.Pool,
  opts: { ids?: string[]; partnerId?: string; maxAgeHours?: number; limit?: number } = {},
): Promise<WebhookDeliveryRow[]> {
  // An explicit empty list means "replay these none", not "replay everything".
  if (opts.ids && opts.ids.length === 0) return [];
  const maxAgeHours = opts.maxAgeHours ?? DELIVERY_REPLAY_MAX_AGE_HOURS;
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `UPDATE partner_webhook_deliveries d
        SET status = 'pending', attempts = 0, claimed_at = NULL, next_attempt_at = now(),
            last_error = NULL
      WHERE d.id IN (
        SELECT dd.id FROM partner_webhook_deliveries dd
          JOIN partner_webhooks w ON w.id = dd.webhook_id
         WHERE dd.status = 'failed'
           AND w.enabled
           AND dd.created_at > now() - ($1 || ' hours')::interval
           AND dd.last_error IS DISTINCT FROM $2
           AND ($3::text[] IS NULL OR dd.id = ANY($3))
           AND ($4::text IS NULL OR w.partner_id = $4)
         LIMIT $5
         -- Same discipline as the claim and the reaper: a concurrent sweep
         -- takes the next batch rather than blocking on this one.
         FOR UPDATE SKIP LOCKED
      )
      RETURNING d.*`,
    [
      String(maxAgeHours),
      DELIVERY_PREDATES_RETRIES_ERROR,
      opts.ids ?? null,
      opts.partnerId ?? null,
      Math.min(Math.max(opts.limit ?? 500, 1), 1000),
    ],
  );
  return rows;
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
