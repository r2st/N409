import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { openSecret, sealSecret } from '../crypto/connectionSecrets.js';
import { deliveryLeaseMs, WEBHOOK_MAX_ATTEMPTS } from '../domain/partnerWebhooks.js';
import { type Cursor, cursorAtSql, encodeCursor, keysetAfterSql, pageFrom } from '../domain/pagination.js';

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

/**
 * Unseals the signing secret on any row shaped like one that carries it —
 * `PartnerWebhookRow` and the `ClaimedDelivery` the retry sweep joins it onto.
 *
 * Every read goes through here rather than the delivery site, because the
 * secret has two consumers with opposite needs: `signWebhookBody` must have the
 * plaintext HMAC key, and the create response shows it to the partner once and
 * never again. Sealing at the column and opening at the repo boundary keeps
 * both of those unchanged while the column stops being readable from a dump.
 */
function openWebhookSecret<T extends { secret: string }>(row: T): T {
  return { ...row, secret: openSecret(row.secret) };
}

export async function createWebhook(
  pool: pg.Pool,
  args: { partnerId: string; url: string; secret: string; events: string[]; createdBy: string },
): Promise<PartnerWebhookRow> {
  const { rows } = await pool.query<PartnerWebhookRow>(
    `INSERT INTO partner_webhooks (id, partner_id, url, secret, events, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newUlid(), args.partnerId, args.url, sealSecret(args.secret), args.events, args.createdBy],
  );
  return openWebhookSecret(rows[0]!);
}

export async function listWebhooks(pool: pg.Pool, partnerId: string): Promise<PartnerWebhookRow[]> {
  const { rows } = await pool.query<PartnerWebhookRow>(
    'SELECT * FROM partner_webhooks WHERE partner_id = $1 ORDER BY created_at',
    [partnerId],
  );
  return rows.map(openWebhookSecret);
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
  return rows[0] ? openWebhookSecret(rows[0]) : null;
}

export async function deleteWebhook(pool: pg.Pool, partnerId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM partner_webhooks WHERE id = $1 AND partner_id = $2', [
    id,
    partnerId,
  ]);
  return (rowCount ?? 0) > 0;
}

/**
 * Enabled webhooks for a partner — what a delivery run fans out over.
 *
 * `enabled` was the whole test, and it is the firm's own switch. Whether the
 * *firm* is still on this platform was never asked (round 342, methodology M3).
 * `partners.archived_at` is the platform's soft delete for a firm — the flag
 * that takes its user assignments, its branding edits and its outstanding
 * client intake links away — and every one of those was closed as somebody
 * noticed the door. This is the door that runs by itself: three single-row
 * callers on every transition of a partner engagement plus the retention
 * sweep's batch, each POSTing an engagement's number, company name and state to
 * a URL belonging to a firm the platform has withdrawn, for as long as the
 * engagements go on moving. The firm cannot stop it either — the console it
 * would delete the hook from is behind a partner API key, and an archived
 * firm's key is now refused.
 *
 * Here rather than at the four call sites, for the reason `LIVE_LINK_SQL` in
 * `repos/clientIntake.ts` gives about the same flag: a predicate copied into
 * each caller is one that eventually differs between them.
 *
 * ONLY THE FAN-OUT. Deliveries already queued keep their retry ladder, and that
 * is deliberate: the disclosure was made when the row was written, the ladder
 * is what ends the row, and a claim query taught to skip them would leave
 * `pending` rows nothing ever settles — the failure the exhaustion reaper
 * exists to prevent. Un-archiving restores the fan-out; the events in between
 * are not replayed, exactly as an intake link reopened after a restore does not
 * recover the visits it refused.
 */
export async function enabledWebhooks(pool: pg.Pool, partnerId: string): Promise<PartnerWebhookRow[]> {
  const { rows } = await pool.query<PartnerWebhookRow>(
    `SELECT * FROM partner_webhooks w
      WHERE w.partner_id = $1 AND w.enabled
        AND EXISTS (SELECT 1 FROM partners p WHERE p.id = w.partner_id AND p.archived_at IS NULL)`,
    [partnerId],
  );
  return rows.map(openWebhookSecret);
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
 *
 * ## Why the write is conditional
 *
 * `expectAttempts` is the attempt count the caller's copy of the row carried
 * when it took it — from the INSERT for a first delivery, from the claim for a
 * retry — and the UPDATE applies only while the table still agrees with it.
 * Returns false when it does not, which means somebody else has since owned
 * this row and this outcome is stale.
 *
 * That is not a hypothetical. The claim's lease and the sweep's batch are two
 * different quantities (see `deliveryLeaseMs`), so a sweeper working through a
 * long batch can still be holding a row whose lease has lapsed, and a second
 * sweeper — the ops retry route runs outside the scheduler that keeps the
 * interval from overlapping itself — will re-claim it. Both then settle the
 * same row.
 *
 * Written unconditionally, the loser's write lands last and lands wrong twice
 * over. It puts back a status the winner had already settled — a 'delivered'
 * row flipped to 'pending', with `delivered_at` still set, which the sweep
 * then delivers to the partner *again* and the partner's own delivery log
 * describes as owed. And it stamps `next_attempt_at` computed from the attempt
 * count the loser read, which is one or more steps behind the row's real one,
 * so the ladder walks backwards.
 *
 * `settleClaimedEmail` avoids the second half by recomputing the schedule in
 * SQL from the row's own `attempts`. That is not available here — the schedule
 * carries jitter and an honoured `Retry-After`, both decided in JS — so the
 * guard is the other way round: rather than making a stale schedule correct,
 * refuse to write one. `status = 'pending'` is in the predicate as well as the
 * attempt count, so a row a replay has reopened (which resets attempts to 0)
 * and a row already settled are both refused for the same reason.
 */
export async function settleDelivery(
  pool: pg.Pool,
  id: string,
  outcome: { status: 'delivered' } | { status: 'failed'; error: string; nextAttemptAt: Date | null },
  expectAttempts: number,
): Promise<boolean> {
  if (outcome.status === 'delivered') {
    const { rowCount } = await pool.query(
      `UPDATE partner_webhook_deliveries
          SET status = 'delivered', claimed_at = NULL, last_error = NULL, delivered_at = now()
        WHERE id = $1 AND status = 'pending' AND attempts = $2`,
      [id, expectAttempts],
    );
    return (rowCount ?? 0) > 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE partner_webhook_deliveries
        SET status = CASE WHEN $3::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
            claimed_at = NULL,
            last_error = $2,
            next_attempt_at = coalesce($3::timestamptz, next_attempt_at)
      WHERE id = $1 AND status = 'pending' AND attempts = $4`,
    [id, outcome.error, outcome.nextAttemptAt, expectAttempts],
  );
  return (rowCount ?? 0) > 0;
}

/** Rows one sweeper takes in a pass, and the ceiling on what a caller may ask. */
export const DELIVERY_CLAIM_BATCH_DEFAULT = 100;
export const DELIVERY_CLAIM_BATCH_MAX = 500;

/**
 * The batch a caller actually gets, and the lease that batch needs.
 *
 * One function because the two are not independent: the sweep POSTs its batch
 * one row at a time, so a lease shorter than the batch takes to work through
 * lapses on rows a live sweeper is still going to deliver, and a second sweeper
 * re-claims and re-delivers them. See `deliveryLeaseMs` for the arithmetic and
 * what it trades away. An explicit `leaseMs` from the caller wins — that is the
 * seam the tests use to make a takeover happen on purpose.
 */
function claimWindow(opts: { limit?: number; leaseMs?: number }): { limit: number; leaseSeconds: string } {
  const limit = Math.min(opts.limit ?? DELIVERY_CLAIM_BATCH_DEFAULT, DELIVERY_CLAIM_BATCH_MAX);
  const leaseMs = opts.leaseMs ?? deliveryLeaseMs(limit);
  return { limit, leaseSeconds: String(Math.max(1, Math.floor(leaseMs / 1000))) };
}

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
  // The same window the claim uses, and it has to be: this reads an expired
  // lease as "nobody is holding this row", so a shorter one here would reap
  // rows a sweeper is still mid-attempt on and mark a live delivery failed.
  const { limit, leaseSeconds } = claimWindow(opts);
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
    [leaseSeconds, limit, DELIVERY_ABANDONED_ERROR],
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
  const { limit, leaseSeconds } = claimWindow(opts);
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
    [leaseSeconds, limit],
  );
  return rows.map(openWebhookSecret);
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

/** Page size when the caller does not ask, and the ceiling on what it may. */
export const DELIVERIES_PAGE_DEFAULT = 50;
export const DELIVERIES_PAGE_MAX = 200;

/** A delivery row plus the opaque cursor that resumes the walk after it. */
export interface DeliveryPage {
  items: Array<WebhookDeliveryRow & { cursor: string }>;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * A partner's delivery history, newest first, walkable to the end.
 *
 * This used to be `LIMIT 50` with no way to ask for the fifty-first, which made
 * the endpoint's own documented purpose — "your audit trail for missed events" —
 * unserveable in the case that produces missed events. An incident that takes a
 * receiver down for an afternoon generates far more than fifty deliveries, and
 * the partner reconciling afterwards could see only the newest fifty of them:
 * the tail of the outage, never its start. The rows were there; nothing could
 * reach them.
 *
 * Keyset rather than OFFSET because this table is append-only and written to
 * while it is being read — see `domain/pagination.ts` for why that combination
 * makes OFFSET drop rows silently. The delivery log is precisely where a
 * silently dropped row is worst: it is what the partner is checking *against*.
 *
 * The ORDER BY gained `id` as well, and not only for the cursor. `created_at`
 * defaults to `now()` — the transaction timestamp — and the retry sweep settles
 * deliveries in batches, so rows sharing an instant to the microsecond are the
 * normal case here rather than a corner. Without a unique tiebreaker their
 * relative order was undefined between two queries, which is the same
 * skip-and-repeat this function exists to stop.
 */
export async function listDeliveries(
  pool: pg.Pool,
  webhookId: string,
  opts: { limit?: number; cursor?: Cursor | null } = {},
): Promise<DeliveryPage> {
  const limit = Math.min(Math.max(opts.limit ?? DELIVERIES_PAGE_DEFAULT, 1), DELIVERIES_PAGE_MAX);
  const cursor = opts.cursor ?? null;
  const params: unknown[] = [webhookId, cursor?.at ?? null, cursor?.id ?? null, limit + 1];
  const { rows } = await pool.query<WebhookDeliveryRow & { cursor_at: string }>(
    `SELECT *, ${cursorAtSql('created_at')} AS cursor_at
       FROM partner_webhook_deliveries
      WHERE webhook_id = $1
        AND ($2::text IS NULL OR ${keysetAfterSql('created_at', 'id', '$2', '$3')})
      ORDER BY created_at DESC, id ASC
      LIMIT $4`,
    params,
  );
  const page = pageFrom(rows, limit, (row) => ({ at: row.cursor_at, id: row.id }));
  return {
    // `cursor_at` is renamed rather than dropped: a client that wants to resume
    // from a specific row it has already seen needs that row's cursor, and
    // handing back only the page's last one makes "start again from here"
    // impossible without re-walking.
    items: page.items.map(({ cursor_at, ...row }) => ({
      ...row,
      cursor: encodeCursor({ at: cursor_at, id: row.id }),
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/**
 * How far back the settled halves of the backlog view look.
 *
 * `pending` and `due` are a live set and are not windowed — the ladder's reach
 * bounds how long a row can stay in it, and the reaper settles the ones that
 * outlive it. `failed` and `delivered` are history, and history here is
 * append-only: nothing purges `partner_webhook_deliveries`, unlike the outbox
 * that retention drains.
 *
 * Twenty-four hours because of what the number is *for*. This is an ops gauge
 * read during an incident to answer "is anything not getting through **now**",
 * and an all-time failure count cannot answer it: after a year of successful
 * sends "412,000 delivered, 3,190 failed" is a fact about the platform's
 * history and says nothing about the last hour. It also matches
 * {@link DELIVERY_REPLAY_MAX_AGE_HOURS}, so the count and the set an operator
 * can actually act on through the dead letter queue describe the same rows.
 */
export const BACKLOG_WINDOW_HOURS = 24;

export interface DeliveryBacklog {
  pending: number;
  due: number;
  /** Gave up inside {@link BACKLOG_WINDOW_HOURS}. */
  failed: number;
  /** Landed inside {@link BACKLOG_WINDOW_HOURS}. */
  delivered: number;
  /** Reported rather than assumed, so the two counts above cannot be misread. */
  window_hours: number;
}

/**
 * Ops view: how much of the delivery backlog is owed, stuck or gone terminal.
 *
 * Three statements rather than one, and the reason is the plan rather than the
 * prose. This was a single pass with four `FILTER` aggregates over the whole
 * table, which is one access path for four different questions: the planner can
 * only pick one, and with an unfiltered `count(*) FILTER (WHERE status =
 * 'failed')` in the list the only path that answers all four is a sequential
 * scan of every delivery the platform has ever recorded. The partial index 0103
 * added for the claim was right there and unusable, because the query was not
 * asking a question it could answer.
 *
 * Split, each statement asks for one region and gets its own index: the live
 * pair off `partner_webhook_deliveries_claim_idx`, and the two settled counts
 * off the partial indexes on `created_at`/`delivered_at` added in 0180. Issued
 * together, so the round trips overlap and the cost is one of them.
 *
 * This matters more than a triage endpoint usually would because of where it is
 * read from: `GET /admin/system/metrics` composes it, and that endpoint is
 * deliberately uncached and is opened during an incident — which is exactly
 * when a full scan of the largest append-only table in the schema is the last
 * thing the database needs to be doing.
 */
export async function deliveryBacklogStats(
  pool: pg.Pool,
  opts: { windowHours?: number } = {},
): Promise<DeliveryBacklog> {
  const windowHours = opts.windowHours ?? BACKLOG_WINDOW_HOURS;
  const [live, failed, delivered] = await Promise.all([
    pool.query<{ pending: string; due: string }>(
      // Both counts are over the same small region, so one statement covers
      // them and the partial index is still the path.
      `SELECT count(*)                                          AS pending,
              count(*) FILTER (WHERE next_attempt_at <= now())  AS due
         FROM partner_webhook_deliveries
        WHERE status = 'pending'`,
    ),
    pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM partner_webhook_deliveries
        WHERE status = 'failed' AND created_at > now() - ($1 || ' hours')::interval`,
      [String(windowHours)],
    ),
    pool.query<{ n: string }>(
      // On `delivered_at`, not `created_at`: an event that spent six hours in
      // the ladder was delivered today and created yesterday, and "delivered in
      // the last day" is a claim about when it landed.
      `SELECT count(*) AS n FROM partner_webhook_deliveries
        WHERE status = 'delivered' AND delivered_at > now() - ($1 || ' hours')::interval`,
      [String(windowHours)],
    ),
  ]);
  return {
    pending: Number(live.rows[0]!.pending),
    due: Number(live.rows[0]!.due),
    failed: Number(failed.rows[0]!.n),
    delivered: Number(delivered.rows[0]!.n),
    window_hours: windowHours,
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
