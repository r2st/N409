import type pg from 'pg';
import { newUlid } from '@n409/shared';

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
  status: EmailStatus;
  error: string | null;
  attempts: number;
  created_at: Date;
  sent_at: Date | null;
  /** When a retry sweeper last took this row; null when free. See claimFailedEmails. */
  claimed_at: Date | null;
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
  },
): Promise<EmailOutboxRow> {
  const { rows } = await db.query<EmailOutboxRow>(
    `INSERT INTO email_outbox (id, valuation_id, to_user_id, to_email, channel, template_key, subject, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    ],
  );
  return rows[0]!;
}

export async function markEmail(
  pool: pg.Pool,
  id: string,
  status: Exclude<EmailStatus, 'queued'>,
  error?: string,
): Promise<void> {
  await pool.query(
    `UPDATE email_outbox
     SET status = $2::email_status, error = $3, attempts = attempts + 1,
         sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END
     WHERE id = $1`,
    [id, status, error ?? null],
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
 */
export async function claimFailedEmails(
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
        WHERE status = 'failed'
          AND attempts < $1
          AND channel = ANY($2::comm_channel[])
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
 * Settles a row taken by claimFailedEmails. Unlike markEmail this does not count
 * an attempt — the claim already did — and it releases the lease so a row left
 * 'failed' is picked up by the next sweep instead of waiting one out.
 */
export async function settleClaimedEmail(
  pool: pg.Pool,
  id: string,
  status: Exclude<EmailStatus, 'queued'>,
  error?: string,
): Promise<void> {
  await pool.query(
    `UPDATE email_outbox
     SET status = $2::email_status, error = $3, claimed_at = NULL,
         sent_at = CASE WHEN $2::text = 'sent' THEN now() ELSE sent_at END
     WHERE id = $1`,
    [id, status, error ?? null],
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
