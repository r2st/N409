import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { EMAIL_JITTER_FLOOR, EMAIL_MAX_ATTEMPTS, EMAIL_RETRY_BACKOFF_MINUTES } from '../domain/emailRetry.js';
import { isSuppressed } from './emailDelivery.js';
import { SUPPRESSION_EXEMPT_TEMPLATES, type BounceKind } from '../domain/emailDelivery.js';

export type EmailStatus = 'queued' | 'sent' | 'failed' | 'skipped';

export interface EmailOutboxRow {
  id: string;
  valuation_id: string | null;
  to_user_id: string | null;
  /** Destination address — an email, or a phone number when channel = 'sms'. */
  to_email: string;
  channel: 'email' | 'sms';
  template_key: string;
  subject: string;
  body: string;
  /**
   * Marketing rather than transactional (migration 0138). Decides whether the
   * transport attaches `List-Unsubscribe`; see `email/mime`.
   */
  promotional: boolean;
  status: EmailStatus;
  error: string | null;
  attempts: number;
  created_at: Date;
  sent_at: Date | null;
  /** When a retry sweeper last took this row; null when free. See claimRetryableEmails. */
  claimed_at: Date | null;
  /**
   * Earliest time a sweep may claim this row again (migration 0159). Null means
   * no wait — a fresh row, or one whose ladder is spent and which the attempt
   * ceiling now holds. See domain/emailRetry.ts.
   */
  next_attempt_at: Date | null;
  /**
   * Delivery ledger (migration 0163). Every read of this table is `SELECT *`
   * or `RETURNING *`, so these seven columns have been on the rows since 0163
   * shipped — the interface simply never learned about them, and a type that
   * denies a column makes the column unreadable to anything downstream.
   *
   * `status` says what the platform did with the message; these say what
   * happened to it afterwards. Conflating the two is the defect the whole
   * subsystem exists to remove — see `deliveryStateOf`, which folds them into
   * the one state an operator should be shown.
   */
  delivered_at: Date | null;
  bounced_at: Date | null;
  bounce_kind: BounceKind | null;
  bounce_detail: string | null;
  first_opened_at: Date | null;
  last_opened_at: Date | null;
  open_count: number;
}

export async function enqueueEmail(
  db: pg.Pool | pg.PoolClient,
  input: {
    valuationId?: string | null;
    toUserId?: string | null;
    toEmail: string;
    channel?: 'email' | 'sms';
    templateKey: string;
    subject: string;
    body: string;
    /** Marketing send. Defaults to transactional — see migration 0138. */
    promotional?: boolean;
    /**
     * Enqueue even if the address is suppressed. For the one class of message
     * a suppression must not block: an address-verification mail the user has
     * just asked for is how a previously-bouncing address gets proven good
     * again, and refusing to send it would make a suppression unrecoverable
     * from the user's side.
     */
    ignoreSuppression?: boolean;
  },
): Promise<EmailOutboxRow> {
  // A suppressed address yields a row, not a send (0163). Recording it as
  // 'skipped' rather than dropping it keeps the outbox an honest account of
  // what the platform decided to do — an operator asking "why did the client
  // not get this" gets an answer, and the row names the suppression.
  const suppression =
    input.channel === 'sms' || input.ignoreSuppression || SUPPRESSION_EXEMPT_TEMPLATES.has(input.templateKey)
      ? null
      : await isSuppressed(db, input.toEmail);

  const { rows } = await db.query<EmailOutboxRow>(
    `INSERT INTO email_outbox (id, valuation_id, to_user_id, to_email, channel, template_key, subject, body, promotional, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::email_status, $11)
     RETURNING *`,
    [
      newUlid(),
      input.valuationId ?? null,
      input.toUserId ?? null,
      input.toEmail,
      input.channel ?? 'email',
      input.templateKey,
      input.subject,
      input.body,
      input.promotional ?? false,
      suppression ? 'skipped' : 'queued',
      suppression
        ? `address suppressed (${suppression.reason}) since ${suppression.created_at.toISOString()}`
        : null,
    ],
  );
  return rows[0]!;
}

/**
 * The retry schedule, as the two failure-recording statements below stamp it.
 *
 * In SQL rather than in JavaScript because it has to land in the *same*
 * statement that records the failure. Split across two round trips, a process
 * that died between them would leave a row 'failed' with no schedule — which is
 * claimable immediately, i.e. exactly the unbounded-cadence behaviour migration
 * 0159 exists to remove, reintroduced by the crash window.
 *
 * The ladder's figures are not restated here: `ladder` is
 * `EMAIL_RETRY_BACKOFF_MINUTES` passed in, and the index into it is the number
 * of attempts *made* including the one being recorded. That count is spelled by
 * the caller rather than assumed, because the two writers differ on it:
 * `markEmail` increments in the same statement, so its count is `attempts + 1`,
 * while `settleClaimedEmail` settles a row the claim already incremented, so
 * its count is `attempts`. Getting that wrong is an off-by-one that shifts the
 * whole ladder a step and is invisible in any single test.
 *
 * Past the end of the array it holds at the longest step, which is what lets a
 * raised `EMAIL_RETRY_MAX_ATTEMPTS` add attempts rather than silently do
 * nothing.
 *
 * `random()` is per row, not per statement, which is the point of the jitter:
 * an outage fails the whole backlog at one moment and a fixed ladder would give
 * every row the same next-attempt time, serving a just-recovered relay its
 * entire outage in one sweep.
 *
 * NULL when the ladder is spent, so terminality is expressed once — by
 * `attempts >= maxAttempts` in the claim — and raising the ceiling later can
 * still pick an old row up.
 */
function retryScheduleSql(status: string, made: string, max: string, ladder: string): string {
  return `CASE
    WHEN ${status}::text = 'failed' AND (${made}) < ${max}::int
      THEN now() + make_interval(mins => COALESCE(
             (${ladder}::int[])[${made}],
             (${ladder}::int[])[array_length(${ladder}::int[], 1)]
           )) * (${EMAIL_JITTER_FLOOR} + ${1 - EMAIL_JITTER_FLOOR} * random())
    ELSE NULL
  END`;
}

export async function markEmail(
  db: pg.Pool | pg.PoolClient,
  id: string,
  status: Exclude<EmailStatus, 'queued'>,
  error?: string,
  opts: { maxAttempts?: number } = {},
): Promise<void> {
  await db.query(
    `UPDATE email_outbox
     SET status = $2::email_status, error = $3, attempts = attempts + 1,
         sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END,
         next_attempt_at = ${retryScheduleSql('$2', 'email_outbox.attempts + 1', '$4', '$5')}
     WHERE id = $1`,
    [id, status, error ?? null, opts.maxAttempts ?? EMAIL_MAX_ATTEMPTS, EMAIL_RETRY_BACKOFF_MINUTES],
  );
}

/** Default lease: comfortably longer than any single transport attempt. */
export const CLAIM_LEASE_MS = 15 * 60_000;

/**
 * Atomically takes a batch of retryable rows for one sweeper.
 *
 * Selecting candidates and then sending them are two steps, so without a claim
 * two overlapping sweepers deliver the same backlog twice — and there are three
 * ways to get two sweepers: the interval and the ops retry route call the same
 * function, an ops double-click fires it twice, and a deployment can run more
 * than one instance. SKIP LOCKED makes a concurrent sweeper take the next batch
 * instead of blocking on this one.
 *
 * `claimed_at` is a lease, not a state: a sweeper that dies mid-send leaves the
 * stamp behind, and the row simply becomes claimable again once it expires,
 * with no stuck status needing its own reaper.
 *
 * The attempt is counted here rather than on settlement, so a send that never
 * reports back still burns one — otherwise a transport that hangs every time
 * would be retried forever.
 *
 * Only channels the caller can actually deliver are claimed; claiming an SMS row
 * with no SMS transport configured would burn its attempts on every sweep until
 * it hit the cap without one delivery ever being tried.
 *
 * "Retryable" is 'failed' *and* 'queued'-past-the-lease. A row is written to the
 * outbox before it is handed to the transport precisely so that a crash cannot
 * lose the mail — but until now nothing ever came back for a row the crash left
 * behind. Every send path (state-change workflow, transactional must-sends,
 * auto emails) enqueues then sends in the same process, so a SIGTERM during a
 * deploy, an OOM kill, or a pod eviction in that window stranded the row on
 * 'queued' permanently: the sweep only looked at 'failed', and nothing else in
 * the service reads the outbox at all. A password reset or an invitation simply
 * never arrived, with a row in the table swearing it had been enqueued.
 *
 * The lease is the grace period for that, not just a claim window. It is defined
 * as longer than any single transport attempt, which is exactly the condition
 * for "no in-flight send can still be holding this row" — so reusing it here
 * cannot double-deliver a slow-but-live attempt.
 *
 * `next_attempt_at` is the retry ladder (0159), and it is deliberately *not*
 * applied to a stranded 'queued' row: that row has never been attempted, so
 * there is nothing to back off from, and its own wait is the lease. A NULL is
 * due now — which is what a fresh row carries, what the migration left on the
 * whole existing backlog, and what a row whose ladder is spent carries once the
 * attempt ceiling above is the thing holding it.
 */
export async function claimRetryableEmails(
  pool: pg.Pool,
  opts: {
    channels: ReadonlyArray<'email' | 'sms'>;
    maxAttempts: number;
    limit?: number;
    leaseMs?: number;
  },
): Promise<EmailOutboxRow[]> {
  if (opts.channels.length === 0) return [];
  const leaseSeconds = Math.max(1, Math.floor((opts.leaseMs ?? CLAIM_LEASE_MS) / 1000));
  const { rows } = await pool.query<EmailOutboxRow>(
    `WITH claimable AS (
       SELECT id FROM email_outbox
        -- Spelled as an IN over the leading index column, then narrowed, so
        -- email_outbox_claim_idx (status, created_at, claimed_at) still drives
        -- the scan rather than the planner falling back to a seq scan.
        WHERE status IN ('failed', 'queued')
          AND (status = 'failed' OR created_at < now() - ($3 || ' seconds')::interval)
          AND attempts < $1
          -- Terminally bounced rows are out (0163). A hard rejection of the
          -- recipient, or a complaint, is the one thing the ladder cannot
          -- learn from repetition: the address will reject it again in a
          -- minute, in an hour, and in six hours, and the only effect of
          -- trying is more traffic to a relay that has already refused us.
          -- A soft bounce stays claimable — a full mailbox is precisely the
          -- case the ladder exists for.
          AND (bounce_kind IS NULL OR bounce_kind = 'soft')
          AND channel = ANY($2::comm_channel[])
          -- The engagement the message is about must still exist. R89 stopped
          -- POST /remind-documents from sending "we still need your cap
          -- table" about withdrawn work, and this is the same message arriving
          -- by the other door: a reminder queued the day before the firm
          -- withdrew, whose first send failed, is delivered by the ladder
          -- afterwards. Mail cannot be un-sent, which is what made this class
          -- the worst of R56.
          --
          -- Skipped, not settled: retirement is reversible (R90), and a row
          -- marked failed here could not be un-failed by a restore. It simply
          -- stops being claimable until the engagement comes back — and rows
          -- with no valuation (password resets, verification) are untouched,
          -- because they are about a person and not about a piece of work.
          AND NOT EXISTS (
            SELECT 1 FROM valuations v
             WHERE v.id = email_outbox.valuation_id AND v.archived_at IS NOT NULL
          )
          AND (status = 'queued' OR next_attempt_at IS NULL OR next_attempt_at <= now())
          AND (claimed_at IS NULL OR claimed_at < now() - ($3 || ' seconds')::interval)
        -- Oldest first: a backlog larger than the batch must not leave the
        -- earliest failures permanently behind the newest ones.
        ORDER BY created_at ASC
        LIMIT $4
        FOR UPDATE SKIP LOCKED
     )
     UPDATE email_outbox e
        SET claimed_at = now(), attempts = e.attempts + 1
       FROM claimable c
      WHERE e.id = c.id
      RETURNING e.*`,
    [opts.maxAttempts, opts.channels, String(leaseSeconds), Math.min(opts.limit ?? 100, 500)],
  );
  return rows;
}

/**
 * Settles a row taken by claimRetryableEmails. Unlike markEmail this does not
 * count an attempt — the claim already did — and it releases the lease.
 *
 * Releasing the lease used to be the whole of it, with a comment arguing that a
 * failed row should be "picked up by the next sweep instead of waiting one
 * out". Nothing else spaced the attempts, so the retry schedule was the sweep
 * interval and every attempt a message had was spent inside one outage. The
 * lease is still released — it is a lease, and holding it would only make the
 * row wait twice — and `next_attempt_at` now carries the schedule (0159).
 *
 * The attempt count in the ladder's index is the row's own, not the claimed
 * copy's: `attempts` here is read fresh by the UPDATE, so a row another sweeper
 * has since touched is scheduled off what the table says rather than off what
 * this sweeper read.
 */
export async function settleClaimedEmail(
  pool: pg.Pool,
  id: string,
  status: Exclude<EmailStatus, 'queued'>,
  error?: string,
  opts: { maxAttempts?: number } = {},
): Promise<void> {
  await pool.query(
    `UPDATE email_outbox
     SET status = $2::email_status, error = $3, claimed_at = NULL,
         sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END,
         next_attempt_at = ${retryScheduleSql('$2', 'email_outbox.attempts', '$4', '$5')}
     WHERE id = $1`,
    [id, status, error ?? null, opts.maxAttempts ?? EMAIL_MAX_ATTEMPTS, EMAIL_RETRY_BACKOFF_MINUTES],
  );
}

export async function listOutbox(
  pool: pg.Pool,
  filters: { status?: EmailStatus; valuationId?: string; maxAttempts?: number; limit?: number } = {},
): Promise<EmailOutboxRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.valuationId) {
    params.push(filters.valuationId);
    where.push(`valuation_id = $${params.length}`);
  }
  if (filters.maxAttempts !== undefined) {
    params.push(filters.maxAttempts);
    where.push(`attempts < $${params.length}`);
  }
  params.push(Math.min(filters.limit ?? 100, 500));
  const { rows } = await pool.query<EmailOutboxRow>(
    `SELECT * FROM email_outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}
