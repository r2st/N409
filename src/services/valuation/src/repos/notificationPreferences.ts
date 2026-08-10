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
 * Replaces a batch of preferences in one transaction.
 *
 * The settings screen submits the whole matrix as a unit, and the route used
 * to apply it with a loop of independent upserts. Any failure part-way — a
 * dropped connection, a statement timeout — left the user with some switches
 * moved and some not, and returned an error suggesting *nothing* had been
 * saved. The screen then re-read a matrix that matched neither what was on it
 * before nor what was submitted, and the only way to find out which half had
 * landed was to read the rows. A partial save of a settings form is worse than
 * no save, because the user has no reason to look.
 */
export async function replacePreferences(
  pool: pg.Pool,
  userId: string,
  prefs: Array<{ event_type: NotificationEventType } & ChannelPreference>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const pref of prefs) {
      await upsertPreference(client, userId, pref.event_type, {
        in_app: pref.in_app,
        email: pref.email,
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
