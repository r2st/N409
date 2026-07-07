import type pg from 'pg';
import { newUlid } from '@n409/shared';

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

export async function recordEvent(
  client: pg.PoolClient,
  args: {
    valuationId: string;
    type: string;
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

export async function listEvents(pool: pg.Pool, valuationId: string): Promise<ValuationEventRow[]> {
  const { rows } = await pool.query<ValuationEventRow>(
    'SELECT * FROM valuation_events WHERE valuation_id = $1 ORDER BY seq ASC',
    [valuationId],
  );
  return rows;
}
