import type pg from 'pg';
import { eventLabel } from '../domain/auditTrail.js';
import { mergeWindow, offsetFor } from '../domain/pagination.js';

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

/**
 * One branch's own predicates, as SQL over that branch's own table alias.
 *
 * Every filter is answered here rather than above the union, because
 * {@link mergeWindow} caps each branch before the merge and a predicate left
 * outside would be applied *after* the cap. `valuationId` is the one filter
 * that is not symmetric: it used to read `s.scope = 'valuation' AND
 * s.subject_id = ?`, which no `admin_events` row can satisfy, so that branch
 * contributes nothing at all rather than being filtered on its own subject.
 */
function branchWhere(
  alias: 'e' | 'a',
  filters: ActivityFilters,
  params: unknown[],
): { sql: string; impossible: boolean } {
  const where: string[] = [];
  let impossible = false;
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (filters.valuationId) {
    if (alias === 'e') add('e.valuation_id = ?', filters.valuationId);
    else impossible = true;
  }
  if (filters.actorId) add(`${alias}.actor_id = ?`, filters.actorId);
  if (filters.actorType) add(`${alias}.actor_type::text = ?`, filters.actorType);
  if (filters.type) add(`${alias}.type = ?`, filters.type);
  if (filters.source) add(`${alias}.source = ?`, filters.source);
  if (filters.from) add(`${alias}.occurred_at >= ?`, filters.from);
  if (filters.to) add(`${alias}.occurred_at <= ?`, filters.to);
  return { sql: where.length > 0 ? `WHERE (${where.join(') AND (')})` : '', impossible };
}

/**
 * The valuation branch, capped and ordered on its own index.
 *
 * `valuations` is *not* joined in here any more. The join only ever supplied
 * `subject_label`, and carrying it inside the branch made the cheap plan —
 * walk `valuation_events_occurred_idx` backwards, stop at the cap — impossible:
 * Postgres hashed all forty thousand valuations first. The label is attached
 * below the merge instead, over the rows that survived it.
 */
const valuationBranch = (whereSql: string, limitParam: string) => `
  (SELECT e.id, 'valuation' AS scope, e.type, e.actor_type::text AS actor_type, e.actor_id,
          e.source, 'valuation' AS subject_type, e.valuation_id::text AS subject_id,
          NULL::text AS subject_label,
          e.payload, e.occurred_at
     FROM valuation_events e
     ${whereSql}
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ${limitParam})`;

const adminBranch = (whereSql: string, limitParam: string) => `
  (SELECT a.id, 'admin' AS scope, a.type, a.actor_type::text AS actor_type, a.actor_id,
          a.source, a.subject_type, a.subject_id, a.subject_label, a.payload, a.occurred_at
     FROM admin_events a
     ${whereSql}
    ORDER BY a.occurred_at DESC, a.id DESC
    LIMIT ${limitParam})`;

export async function listActivity(
  pool: pg.Pool,
  filters: ActivityFilters,
): Promise<{ items: ActivityEntry[]; total: number }> {
  const wantValuations = filters.scope !== 'admin';
  const wantAdmin = filters.scope !== 'valuations';

  // Counting each branch on its own table, rather than counting the union.
  //
  // The two are the same number: the join the valuation branch used to carry is
  // an inner join on `valuation_events.valuation_id`, which is `NOT NULL
  // REFERENCES valuations(id)` — it can neither drop a row nor duplicate one
  // (`valuations.id` is the primary key). So the count never needed the join,
  // and paying for it meant hashing the whole valuations table to arrive at a
  // number that could not depend on it.
  const countParts: string[] = [];
  const countParams: unknown[] = [];
  if (wantValuations) {
    const { sql, impossible } = branchWhere('e', filters, countParams);
    countParts.push(impossible ? '0' : `(SELECT count(*) FROM valuation_events e ${sql})`);
  }
  if (wantAdmin) {
    const { sql, impossible } = branchWhere('a', filters, countParams);
    countParts.push(impossible ? '0' : `(SELECT count(*) FROM admin_events a ${sql})`);
  }
  const { rows: countRows } = await pool.query<{ total: number }>(
    `SELECT (${countParts.join(' + ')})::int AS total`,
    countParams,
  );

  // The branch cap is bound first, so both branches can name it as `$1`: they
  // are capped at the same depth, and two placeholders would be two things to
  // keep in step.
  const params: unknown[] = [mergeWindow(filters.page, filters.perPage)];
  const limitParam = '$1';
  const branches: string[] = [];
  if (wantValuations) {
    const { sql, impossible } = branchWhere('e', filters, params);
    if (!impossible) branches.push(valuationBranch(sql, limitParam));
  }
  if (wantAdmin) {
    const { sql, impossible } = branchWhere('a', filters, params);
    if (!impossible) branches.push(adminBranch(sql, limitParam));
  }

  if (branches.length === 0) return { items: [], total: countRows[0]!.total };

  params.push(filters.perPage, offsetFor(filters.page, filters.perPage));
  // The two display lookups are scalar subqueries rather than `LEFT JOIN`s, and
  // that is a cost guarantee rather than a style choice. A join is planned on
  // table size: Postgres picks a per-row primary-key probe once `valuations` is
  // large and a hash over the *whole* table while it is small — which is the
  // right call for a small table, but it means the bound on this statement's
  // cost would be the planner's opinion rather than the query's shape, and the
  // shape is what R167 was fixing. A `SubPlan` can only run once per row
  // returned, so at most `perPage` primary-key lookups each, whatever the
  // tables grow to.
  const { rows } = await pool.query<ActivityEntry>(
    `SELECT m.id, m.scope, m.type, m.actor_type, m.actor_id, m.source, m.subject_type, m.subject_id,
            CASE WHEN m.scope = 'valuation'
                 THEN (SELECT v.company_name || ' · #' || v.number
                         FROM valuations v WHERE v.id = m.subject_id)
                 ELSE m.subject_label END AS subject_label,
            m.payload, m.occurred_at,
            (SELECT u.email FROM users u WHERE u.id = m.actor_id) AS actor_email
       FROM (
         SELECT * FROM (${branches.join('\n         UNION ALL\n')}) b
          ORDER BY b.occurred_at DESC, b.id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
       ) m
      ORDER BY m.occurred_at DESC, m.id DESC`,
    params,
  );
  return {
    items: rows.map((row) => ({ ...row, label: eventLabel(row.type) })),
    total: countRows[0]!.total,
  };
}
