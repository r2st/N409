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

export async function listSupportMessages(
  pool: pg.Pool,
  filters: { status?: SupportMessageStatus; userId?: string } = {},
): Promise<SupportMessageRow[]> {
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
  const { rows } = await pool.query<SupportMessageRow>(
    `SELECT m.*, u.email AS user_email
     FROM support_messages m JOIN users u ON u.id = m.user_id
     ${whereSql}
     ORDER BY m.status ASC, m.created_at DESC
     LIMIT 200`,
    params,
  );
  return rows;
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
