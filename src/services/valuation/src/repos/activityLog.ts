import type pg from 'pg';
import { eventLabel } from '../domain/auditTrail.js';

/**
 * Global activity listing (P2 #12): valuation_events and admin_events merged
 * into one reverse-chronological feed with actor display and subject context
 * joined in for rendering.
 */

export type ActivityScope = 'valuations' | 'admin' | 'all';

export interface ActivityEntry {
  id: string;
  scope: 'valuation' | 'admin';
  type: string;
  /**
   * The type in English, decided here rather than in the browser — the same
   * contract the dashboard feed and the per-valuation timeline already ship.
   * This feed was the last surface printing the raw type: `admin_events` had no
   * catalog to name them from, so the log rendered `valuation_tags_ai_applied`
   * in a mono chip and left the reader to parse it.
   */
  label: string;
  actor_type: string;
  actor_id: string | null;
  actor_email: string | null;
  source: string | null;
  subject_type: string;
  subject_id: string | null;
  subject_label: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export interface ActivityFilters {
  scope: ActivityScope;
  valuationId?: string;
  actorId?: string;
  actorType?: string;
  type?: string;
  source?: string;
  from?: Date;
  to?: Date;
  page: number;
  perPage: number;
}

const VALUATION_BRANCH = `
  SELECT e.id, 'valuation' AS scope, e.type, e.actor_type::text AS actor_type, e.actor_id,
         e.source, 'valuation' AS subject_type, e.valuation_id::text AS subject_id,
         v.company_name || ' · #' || v.number AS subject_label,
         e.payload, e.occurred_at
  FROM valuation_events e
  JOIN valuations v ON v.id = e.valuation_id`;

const ADMIN_BRANCH = `
  SELECT a.id, 'admin' AS scope, a.type, a.actor_type::text AS actor_type, a.actor_id,
         a.source, a.subject_type, a.subject_id, a.subject_label, a.payload, a.occurred_at
  FROM admin_events a`;

export async function listActivity(
  pool: pg.Pool,
  filters: ActivityFilters,
): Promise<{ items: ActivityEntry[]; total: number }> {
  const branches: string[] = [];
  if (filters.scope !== 'admin') branches.push(VALUATION_BRANCH);
  if (filters.scope !== 'valuations') branches.push(ADMIN_BRANCH);

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (filters.valuationId) add(`s.scope = 'valuation' AND s.subject_id = ?`, filters.valuationId);
  if (filters.actorId) add('s.actor_id = ?', filters.actorId);
  if (filters.actorType) add('s.actor_type = ?', filters.actorType);
  if (filters.type) add('s.type = ?', filters.type);
  if (filters.source) add('s.source = ?', filters.source);
  if (filters.from) add('s.occurred_at >= ?', filters.from);
  if (filters.to) add('s.occurred_at <= ?', filters.to);
  const whereSql = where.length > 0 ? `WHERE (${where.join(') AND (')})` : '';

  const union = branches.join('\n  UNION ALL\n');
  const countSql = `SELECT count(*)::int AS total FROM (${union}) s ${whereSql}`;
  const { rows: countRows } = await pool.query<{ total: number }>(countSql, params);

  const pageParams = [...params, filters.perPage, (filters.page - 1) * filters.perPage];
  const listSql = `
    SELECT s.*, u.email AS actor_email
    FROM (${union}) s
    LEFT JOIN users u ON u.id = s.actor_id
    ${whereSql}
    ORDER BY s.occurred_at DESC, s.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  const { rows } = await pool.query<ActivityEntry>(listSql, pageParams);
  return {
    items: rows.map((row) => ({ ...row, label: eventLabel(row.type) })),
    total: countRows[0]!.total,
  };
}
