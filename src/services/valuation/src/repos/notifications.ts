import type pg from 'pg';
import { newUlid } from '@n409/shared';

export interface NotificationRow {
  id: string;
  user_id: string;
  valuation_id: string | null;
  type: string;
  title: string;
  body: string | null;
  read_at: Date | null;
  created_at: Date;
}

export interface CreateNotificationInput {
  userId: string;
  valuationId?: string | null;
  type: string;
  title: string;
  body?: string | null;
}

/** Accepts a pool or an in-transaction client so hooks can write atomically. */
export async function createNotification(
  db: pg.Pool | pg.PoolClient,
  input: CreateNotificationInput,
): Promise<NotificationRow> {
  const { rows } = await db.query<NotificationRow>(
    `INSERT INTO notifications (id, user_id, valuation_id, type, title, body)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [newUlid(), input.userId, input.valuationId ?? null, input.type, input.title, input.body ?? null],
  );
  return rows[0]!;
}

export async function listNotifications(
  pool: pg.Pool,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const { rows } = await pool.query<NotificationRow>(
    `SELECT * FROM notifications
     WHERE user_id = $1 ${opts.unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function unreadCount(pool: pg.Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return Number(rows[0]!.count);
}

/** Marks one notification read; scoped by user so ids can't be probed. */
export async function markRead(pool: pg.Pool, userId: string, id: string): Promise<NotificationRow | null> {
  const { rows } = await pool.query<NotificationRow>(
    `UPDATE notifications SET read_at = coalesce(read_at, now())
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function markAllRead(pool: pg.Pool, userId: string): Promise<number> {
  const res = await pool.query(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return res.rowCount ?? 0;
}
