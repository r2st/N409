import type pg from 'pg';
import { isOrderedEventType, ORDERED_EVENT_TYPES, type StripeEventKey } from '../domain/stripeEvents.js';

/**
 * The webhook event ledger (migration 0155).
 *
 * `classifyStripeEvent` is asked before the handlers run and `recordStripeEvent`
 * after they have finished. Nothing is written on the way in, which is the whole
 * design: an event whose handling threw must leave no record, so that Stripe's
 * redelivery — which both webhooks deliberately provoke by answering 5xx — runs
 * it again instead of being turned away as something already done.
 */

export type EventVerdict =
  /** Not seen before, and nothing newer is known about the object. Handle it. */
  | 'fresh'
  /** This exact event id has already been handled. */
  | 'duplicate'
  /** A newer event about the same object has already been applied. */
  | 'stale';

/**
 * Has this event been handled, or has it been overtaken?
 *
 * An event with no id is always 'fresh'. Every real Stripe delivery carries
 * one; a payload without it is something constructed by hand, and refusing to
 * act on it would be inventing a rule Stripe does not have.
 */
export async function classifyStripeEvent(pool: pg.Pool, key: StripeEventKey): Promise<EventVerdict> {
  if (!key.eventId) return 'fresh';

  const seen = await pool.query('SELECT 1 FROM stripe_webhook_events WHERE event_id = $1', [key.eventId]);
  if (seen.rowCount) return 'duplicate';

  // Ordering only applies where two events about one object are two readings of
  // the same state rather than two separate facts — see ORDERED_EVENT_TYPES.
  if (!key.objectId || !key.eventCreated || !isOrderedEventType(key.type)) return 'fresh';

  // Strictly newer. Two events sharing a timestamp is possible (Stripe's
  // `created` has one-second resolution) and there is nothing to choose between
  // them, so the second is applied rather than dropped: applying both in
  // arrival order is what happened before this existed, and is the safe answer
  // where the ledger genuinely cannot tell.
  const newer = await pool.query(
    `SELECT 1 FROM stripe_webhook_events
      WHERE object_id = $1
        AND type = ANY($2::text[])
        AND outcome = 'handled'
        AND event_created > $3
      LIMIT 1`,
    [key.objectId, ORDERED_EVENT_TYPES, key.eventCreated],
  );
  return newer.rowCount ? 'stale' : 'fresh';
}

/**
 * Record that this event has been dealt with.
 *
 * `ON CONFLICT DO NOTHING` because two concurrent deliveries of one event can
 * both have been classified 'fresh' — the ledger narrows that window rather
 * than closing it, and the per-handler compare-and-sets are what make the
 * overlap safe. The second writer finding the row already there is that case,
 * and it is not an error.
 */
export async function recordStripeEvent(
  pool: pg.Pool,
  key: StripeEventKey,
  outcome: 'handled' | 'stale' = 'handled',
): Promise<void> {
  if (!key.eventId) return;
  await pool.query(
    `INSERT INTO stripe_webhook_events (event_id, type, endpoint, object_id, event_created, outcome)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id) DO NOTHING`,
    [key.eventId, key.type, key.endpoint, key.objectId, key.eventCreated, outcome],
  );
}

export interface StripeEventRow {
  event_id: string;
  type: string;
  endpoint: 'payments' | 'billing';
  object_id: string | null;
  event_created: Date | null;
  received_at: Date;
  outcome: 'handled' | 'stale';
}

/** One ledger row, for tests and for answering "what did we do with evt_…". */
export async function findStripeEvent(pool: pg.Pool, eventId: string): Promise<StripeEventRow | null> {
  const { rows } = await pool.query<StripeEventRow>(
    'SELECT * FROM stripe_webhook_events WHERE event_id = $1',
    [eventId],
  );
  return rows[0] ?? null;
}
