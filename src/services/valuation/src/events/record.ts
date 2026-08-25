import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { ValuationEventType } from '../domain/auditTrail.js';

/**
 * The audit spine (architecture §1: "everything is an event on the Valuation").
 * Events are written in the SAME transaction as the change they describe, so a
 * change without its event (or vice versa) is impossible.
 */
export interface EventActor {
  actorType: 'human' | 'ai' | 'engine' | 'system';
  actorId?: string | null;
  source?: string;
}

export interface ValuationEventRow {
  id: string;
  valuation_id: string;
  seq: string;
  type: string;
  actor_type: string;
  actor_id: string | null;
  source: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

/**
 * Append one event.
 *
 * `type` is the catalog's key union rather than `string`: the audit trail
 * describes an event by looking its type up in `EVENT_CATALOG`, and a type with
 * no entry there renders as "Event recorded" in the change log and the evidence
 * bundle. Taking the union means the missing descriptor is a compile error here
 * instead of a vague line in an auditor's export.
 */
export async function recordEvent(
  client: pg.PoolClient,
  args: {
    valuationId: string;
    type: ValuationEventType;
    actor: EventActor;
    payload?: Record<string, unknown>;
  },
): Promise<ValuationEventRow> {
  const { rows } = await client.query<ValuationEventRow>(
    `INSERT INTO valuation_events (id, valuation_id, type, actor_type, actor_id, source, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      newUlid(),
      args.valuationId,
      args.type,
      args.actor.actorType,
      args.actor.actorId ?? null,
      args.actor.source ?? 'api',
      JSON.stringify(args.payload ?? {}),
    ],
  );
  return rows[0]!;
}

/**
 * Ceiling on one read of the raw spine (`GET /valuations/:id/events`).
 *
 * Smaller than the audit trail's MAX_TRAIL_EVENTS because this route hands
 * back whole rows — `payload` included, unsummarised — where the trail hands
 * back a described entry. It is a bound on one response, not on the history:
 * the trail route pages through all of it.
 */
export const EVENT_PAGE_LIMIT = 1_000;

/**
 * Filters pushed down to SQL. A long-running valuation accumulates thousands
 * of events; readers that only care about a slice (the client timeline, one
 * event type, a date window) should not drag the whole spine into memory.
 * Every predicate here is served by an index from 0001/0047 —
 * (valuation_id, occurred_at), (type), (actor_id, occurred_at).
 */
export interface EventQuery {
  /** Restrict to these event types. An empty array matches nothing. */
  types?: readonly string[];
  actorType?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  /** Cap the number of rows returned (newest kept, order still ascending). */
  limit?: number;
}

export async function listEvents(
  pool: pg.Pool,
  valuationId: string,
  query: EventQuery = {},
): Promise<ValuationEventRow[]> {
  const where = ['valuation_id = $1'];
  const params: unknown[] = [valuationId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (query.types) add('type = ANY(?)', [...query.types]);
  if (query.actorType) add('actor_type = ?', query.actorType);
  if (query.actorId) add('actor_id = ?', query.actorId);
  if (query.from) add('occurred_at >= ?', query.from);
  if (query.to) add('occurred_at <= ?', query.to);

  // The newest N rows, handed back oldest-first so callers can keep reading
  // the spine in causal order.
  if (query.limit !== undefined) {
    params.push(query.limit);
    const { rows } = await pool.query<ValuationEventRow>(
      `SELECT * FROM (
         SELECT * FROM valuation_events WHERE ${where.join(' AND ')}
         ORDER BY seq DESC LIMIT $${params.length}
       ) recent ORDER BY seq ASC`,
      params,
    );
    return rows;
  }

  const { rows } = await pool.query<ValuationEventRow>(
    `SELECT * FROM valuation_events WHERE ${where.join(' AND ')} ORDER BY seq ASC`,
    params,
  );
  return rows;
}

/** When anything last happened on this valuation — an index-only lookup. */
export async function latestEventAt(pool: pg.Pool, valuationId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ occurred_at: Date }>(
    'SELECT occurred_at FROM valuation_events WHERE valuation_id = $1 ORDER BY occurred_at DESC LIMIT 1',
    [valuationId],
  );
  return rows[0]?.occurred_at ?? null;
}
