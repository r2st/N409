import type pg from 'pg';
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEventType,
} from '../domain/emailWorkflows.js';

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
  pool: pg.Pool,
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
