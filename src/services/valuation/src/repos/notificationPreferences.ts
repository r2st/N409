import type pg from 'pg';
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from '../domain/emailWorkflows.js';

/**
 * Notification preferences (P2 #11). Sparse and default-on: a missing row
 * means both channels are enabled, so the table only holds deviations.
 */

export interface ChannelPreference {
  in_app: boolean;
  email: boolean;
}

export interface NotificationPreferenceRow extends ChannelPreference {
  user_id: string;
  event_type: string;
}

const DEFAULT_ON: ChannelPreference = { in_app: true, email: true };

/** The full matrix for one user, defaults filled in for absent rows. */
export async function getPreferenceMatrix(
  pool: pg.Pool,
  userId: string,
): Promise<Array<{ event_type: NotificationEventType } & ChannelPreference>> {
  const { rows } = await pool.query<NotificationPreferenceRow>(
    'SELECT * FROM notification_preferences WHERE user_id = $1',
    [userId],
  );
  const byType = new Map(rows.map((r) => [r.event_type, r]));
  return NOTIFICATION_EVENT_TYPES.map((event_type) => {
    const row = byType.get(event_type);
    return { event_type, in_app: row?.in_app ?? true, email: row?.email ?? true };
  });
}

export async function upsertPreference(
  pool: pg.Pool | pg.PoolClient,
  userId: string,
  eventType: NotificationEventType,
  pref: ChannelPreference,
): Promise<void> {
  await pool.query(
    `INSERT INTO notification_preferences (user_id, event_type, in_app, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, event_type)
     DO UPDATE SET in_app = $3, email = $4, updated_at = now()`,
    [userId, eventType, pref.in_app, pref.email],
  );
}

/**
 * Replaces a batch of preferences in one statement.
 *
 * The settings screen submits the whole matrix as a unit, and the route once
 * applied it with a loop of independent upserts. Any failure part-way — a
 * dropped connection, a statement timeout — left the user with some switches
 * moved and some not, and returned an error suggesting *nothing* had been
 * saved. The screen then re-read a matrix that matched neither what was on it
 * before nor what was submitted, and the only way to find out which half had
 * landed was to read the rows. A partial save of a settings form is worse than
 * no save, because the user has no reason to look.
 *
 * A transaction around the loop fixed that; a single multi-row upsert makes it
 * structural. One statement is atomic on its own, so there is no BEGIN to
 * forget, no connection checked out of the pool for the length of the write,
 * and one round trip instead of one per row in the matrix.
 */
export async function replacePreferences(
  pool: pg.Pool,
  userId: string,
  prefs: Array<{ event_type: NotificationEventType } & ChannelPreference>,
): Promise<void> {
  if (prefs.length === 0) return;
  // Last write wins per event type. `ON CONFLICT DO UPDATE` refuses to touch a
  // row twice in one statement, and the loop this replaces would simply have
  // upserted the duplicate again — so the duplicate is collapsed rather than
  // turned into an error the screen never used to get.
  const byType = new Map(prefs.map((p) => [p.event_type, p]));
  const rows = [...byType.values()];
  await pool.query(
    `INSERT INTO notification_preferences (user_id, event_type, in_app, email)
     SELECT $1, t.event_type, t.in_app, t.email
       FROM unnest($2::text[], $3::boolean[], $4::boolean[]) AS t(event_type, in_app, email)
     ON CONFLICT (user_id, event_type)
     DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email, updated_at = now()`,
    [userId, rows.map((p) => p.event_type), rows.map((p) => p.in_app), rows.map((p) => p.email)],
  );
}

/**
 * Dispatch-time lookup: every stored deviation for a set of users, keyed
 * `${user_id}:${event_type}`. Pairs without an entry default to both
 * channels on.
 */
export async function preferenceOverrides(
  pool: pg.Pool,
  userIds: string[],
): Promise<Map<string, ChannelPreference>> {
  const prefs = new Map<string, ChannelPreference>();
  if (userIds.length === 0) return prefs;
  const { rows } = await pool.query<NotificationPreferenceRow>(
    'SELECT * FROM notification_preferences WHERE user_id = ANY($1)',
    [userIds],
  );
  for (const row of rows)
    prefs.set(`${row.user_id}:${row.event_type}`, { in_app: row.in_app, email: row.email });
  return prefs;
}

export function channelsFor(
  overrides: Map<string, ChannelPreference>,
  userId: string,
  eventType: string,
): ChannelPreference {
  return overrides.get(`${userId}:${eventType}`) ?? DEFAULT_ON;
}
