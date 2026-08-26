import type pg from 'pg';
import { newUlid } from '@n409/shared';

export type SupportMessageStatus = 'open' | 'resolved';

export interface SupportMessageRow {
  id: string;
  user_id: string;
  subject: string;
  body: string;
  page_path: string | null;
  status: SupportMessageStatus;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  /** joined for the ops inbox */
  user_email?: string;
}

export async function createSupportMessage(
  pool: pg.Pool,
  input: { userId: string; subject: string; body: string; pagePath?: string | null },
): Promise<SupportMessageRow> {
  const { rows } = await pool.query<SupportMessageRow>(
    `INSERT INTO support_messages (id, user_id, subject, body, page_path)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [newUlid(), input.userId, input.subject, input.body, input.pagePath ?? null],
  );
  return rows[0]!;
}

/**
 * Ceiling on one page of the support inbox.
 *
 * Ordered by status first, so the cap falls on the *oldest* message of the
 * lowest-priority status rather than on the newest of anything — which is
 * exactly the row an operator would assume had been dealt with. Two hundred is
 * far above a day's volume and well within a year's, and the inbox has no
 * archive: every message ever sent is still in this query's `FROM`.
 */
export const SUPPORT_MESSAGE_PAGE_LIMIT = 200;

export async function listSupportMessages(
  pool: pg.Pool,
  filters: { status?: SupportMessageStatus; userId?: string; limit?: number } = {},
): Promise<{ messages: SupportMessageRow[]; truncated: boolean }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    params.push(filters.status);
    where.push(`m.status = $${params.length}`);
  }
  if (filters.userId) {
    params.push(filters.userId);
    where.push(`m.user_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(
    Math.max(filters.limit ?? SUPPORT_MESSAGE_PAGE_LIMIT, 1),
    SUPPORT_MESSAGE_PAGE_LIMIT,
  );
  params.push(limit + 1);
  const { rows } = await pool.query<SupportMessageRow>(
    `SELECT m.*, u.email AS user_email
     FROM support_messages m JOIN users u ON u.id = m.user_id
     ${whereSql}
     ORDER BY m.status ASC, m.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return { messages: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function setSupportMessageStatus(
  pool: pg.Pool,
  id: string,
  status: SupportMessageStatus,
  resolvedBy: string,
): Promise<SupportMessageRow | null> {
  const { rows } = await pool.query<SupportMessageRow>(
    `UPDATE support_messages
     SET status = $2::support_message_status,
         resolved_by = CASE WHEN $2::text = 'resolved' THEN $3 ELSE NULL END,
         resolved_at = CASE WHEN $2::text = 'resolved' THEN now() ELSE NULL END
     WHERE id = $1
     RETURNING *`,
    [id, status, resolvedBy],
  );
  return rows[0] ?? null;
}
