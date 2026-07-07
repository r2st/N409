import type pg from 'pg';
import { newUlid } from '@n409/shared';
import type { EventActor } from './record.js';

/**
 * Audit spine for non-valuation admin actions (P2 #12): user/role changes,
 * partner edits, prompt and template changes. Append-only like
 * valuation_events; writes are best-effort fire-after-success from the admin
 * routes (the mutation itself is not held hostage by the audit insert).
 */

export interface AdminEventRow {
  id: string;
  type: string;
  actor_type: string;
  actor_id: string | null;
  source: string | null;
  subject_type: string;
  subject_id: string | null;
  subject_label: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export async function recordAdminEvent(
  db: pg.Pool | pg.PoolClient,
  args: {
    type: string;
    actor: EventActor;
    subjectType: string;
    subjectId?: string | null;
    subjectLabel?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<AdminEventRow> {
  const { rows } = await db.query<AdminEventRow>(
    `INSERT INTO admin_events (id, type, actor_type, actor_id, source, subject_type, subject_id, subject_label, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      newUlid(),
      args.type,
      args.actor.actorType,
      args.actor.actorId ?? null,
      args.actor.source ?? 'api',
      args.subjectType,
      args.subjectId ?? null,
      args.subjectLabel ?? null,
      JSON.stringify(args.payload ?? {}),
    ],
  );
  return rows[0]!;
}
