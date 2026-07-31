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
