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

/**
 * The same insert for a whole fan-out, in one round trip.
 *
 * Every caller of {@link createNotification} that alerts a *group* — the
 * billing admins on a chargeback, the ops roles on a stalled queue — was
 * issuing one INSERT per recipient inside a loop. The cost is not the inserts,
 * it is the round trips: the list comes from a role lookup, so it grows with
 * the team, and the loops sit on paths that already have somewhere better to
 * spend their latency (a Stripe webhook running against a redelivery timeout,
 * a five-minute alert tick).
 *
 * Ordering of the returned rows follows the input, so a caller can still pair
 * a row with the recipient it was written for. An empty list is not a query.
 */
export async function createNotifications(
  db: pg.Pool | pg.PoolClient,
  inputs: readonly CreateNotificationInput[],
): Promise<NotificationRow[]> {
  if (inputs.length === 0) return [];
  const ids = inputs.map(() => newUlid());
  const { rows } = await db.query<NotificationRow>(
    `INSERT INTO notifications (id, user_id, valuation_id, type, title, body)
     SELECT * FROM unnest(
       $1::ulid[], $2::ulid[], $3::ulid[], $4::text[], $5::text[], $6::text[]
     )
     RETURNING *`,
    [
      ids,
      inputs.map((i) => i.userId),
      inputs.map((i) => i.valuationId ?? null),
      inputs.map((i) => i.type),
      inputs.map((i) => i.title),
      inputs.map((i) => i.body ?? null),
    ],
  );
  // RETURNING is in insertion order for a single INSERT, but nothing in the
  // standard promises it — sort by the ids we generated so the contract above
  // holds whatever the planner does.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
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
