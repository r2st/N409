import type pg from 'pg';
import { likeContains } from '../db/like.js';
import { STATE_GROUPS } from '../domain/operations.js';
import type { FirmValuationRow } from '../domain/firmDashboard.js';

/**
 * Firm dashboard reads. Every query is scoped by `partner_id` in its WHERE
 * clause — the scoping is not layered on by the caller, so there is no route
 * that can forget it.
 *
 * Rollups are computed in SQL rather than by loading the firm's book into
 * memory: a firm with ten years of engagements should not pay for a full table
 * read to render six numbers.
 *
 * Every query also carries {@link LIVE_ONLY}, for the same reason the engagement
 * list carries `archived_at IS NULL` (`buildValuationWhere`, repos/valuations.ts).
 * Archiving is this platform's soft delete — the retention sweep stamps it, and
 * `retireValuations` stamps it — and these six queries counted archived rows.
 * A dashboard is read *against* the list underneath it: the header said 15
 * engagements, the list showed 12, and a firm reasonably reads that gap as
 * three engagements it cannot find rather than three it retired. The client
 * roster counted retired companies as clients, and the team panel charged
 * retired work to whoever last held it.
 */

/**
 * The archived filter, as SQL, qualified with the caller's alias.
 *
 * A constant rather than six literals: the bug this fixes was six queries that
 * each had to remember, and the next query added to this file is the seventh.
 */
const LIVE_ONLY = (alias = '') => `${alias}archived_at IS NULL`;

/** States that are neither published nor abandoned — the live book. */
const ACTIVE_STATES = [...STATE_GROUPS.open, ...STATE_GROUPS.in_review, ...STATE_GROUPS.drafted];

export interface FirmSummary {
  total: number;
  active: number;
  published: number;
  closed: number;
  waiting_on_client: number;
  overdue: number;
  due_soon: number;
  unassigned: number;
  by_state: Record<string, number>;
}

export async function firmSummary(
  pool: pg.Pool,
  partnerId: string,
  dueSoonDays: number,
): Promise<FirmSummary> {
  const { rows } = await pool.query<{
    total: string;
    active: string;
    published: string;
    closed: string;
    waiting_on_client: string;
    overdue: string;
    due_soon: string;
    unassigned: string;
  }>(
    `SELECT count(*)                                              AS total,
            count(*) FILTER (WHERE state = ANY($2))               AS active,
            count(*) FILTER (WHERE state = 'published')           AS published,
            count(*) FILTER (WHERE state = ANY($3))               AS closed,
            count(*) FILTER (WHERE waiting_on_client
                               AND state = ANY($2))               AS waiting_on_client,
            count(*) FILTER (WHERE due_date < now()
                               AND state = ANY($2))               AS overdue,
            count(*) FILTER (WHERE due_date >= now()
                               AND due_date < now() + ($4 || ' days')::interval
                               AND state = ANY($2))               AS due_soon,
            count(*) FILTER (WHERE assigned_reviewer_id IS NULL
                               AND state = ANY($5))               AS unassigned
       FROM valuations
      WHERE partner_id = $1 AND ${LIVE_ONLY()}`,
    [
      partnerId,
      ACTIVE_STATES,
      STATE_GROUPS.closed,
      String(dueSoonDays),
      [...STATE_GROUPS.in_review, ...STATE_GROUPS.drafted],
    ],
  );

  const byState = await pool.query<{ state: string; count: string }>(
    `SELECT state, count(*) AS count FROM valuations
      WHERE partner_id = $1 AND ${LIVE_ONLY()} GROUP BY state`,
    [partnerId],
  );

  const r = rows[0]!;
  return {
    total: Number(r.total),
    active: Number(r.active),
    published: Number(r.published),
    closed: Number(r.closed),
    waiting_on_client: Number(r.waiting_on_client),
    overdue: Number(r.overdue),
    due_soon: Number(r.due_soon),
    unassigned: Number(r.unassigned),
    by_state: Object.fromEntries(byState.rows.map((row) => [row.state, Number(row.count)])),
  };
}

export interface FirmClient {
  company_name: string;
  engagements: number;
  active: number;
  latest_valuation_id: string;
  latest_state: string;
  latest_created_at: string;
  next_due_date: string | null;
  last_published_at: string | null;
}

/**
 * The client roster: one row per company the firm has worked for, not per
 * engagement. `company_name` is the only client identity the schema has —
 * there is no clients table — so it is what we group on.
 */
export async function firmClients(
  pool: pg.Pool,
  partnerId: string,
  opts: { search?: string; limit: number; offset: number },
): Promise<{ clients: FirmClient[]; total: number }> {
  // The two queries carry different parameter lists, so each builds its own
  // placeholder index — sharing one produced an off-by-one that only showed up
  // once a search term was supplied.
  const search = opts.search?.trim() ? likeContains(opts.search.trim()) : null;

  const totalParams: unknown[] = [partnerId];
  if (search) totalParams.push(search);
  const totalRes = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT company_name) AS count FROM valuations
      WHERE partner_id = $1 AND ${LIVE_ONLY()}${search ? ' AND company_name ILIKE $2' : ''}`,
    totalParams,
  );

  const params: unknown[] = [partnerId, ACTIVE_STATES];
  let filter = '';
  if (search) {
    params.push(search);
    filter = ` AND company_name ILIKE $${params.length}`;
  }
  params.push(opts.limit, opts.offset);
  const { rows } = await pool.query<{
    company_name: string;
    engagements: string;
    active: string;
    latest_valuation_id: string;
    latest_state: string;
    latest_created_at: Date;
    next_due_date: Date | null;
    last_published_at: Date | null;
  }>(
    `SELECT company_name,
            count(*)                                      AS engagements,
            count(*) FILTER (WHERE state = ANY($2))       AS active,
            (array_agg(id ORDER BY created_at DESC))[1]    AS latest_valuation_id,
            (array_agg(state ORDER BY created_at DESC))[1] AS latest_state,
            max(created_at)                               AS latest_created_at,
            -- The soonest live deadline; finished engagements do not count.
            min(due_date) FILTER (WHERE state = ANY($2))  AS next_due_date,
            max(published_at)                             AS last_published_at
       FROM valuations
      WHERE partner_id = $1 AND ${LIVE_ONLY()}${filter}
      GROUP BY company_name
      ORDER BY max(created_at) DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    total: Number(totalRes.rows[0]!.count),
    clients: rows.map((r) => ({
      company_name: r.company_name,
      engagements: Number(r.engagements),
      active: Number(r.active),
      latest_valuation_id: r.latest_valuation_id,
      latest_state: r.latest_state,
      latest_created_at: r.latest_created_at.toISOString(),
      next_due_date: r.next_due_date ? r.next_due_date.toISOString() : null,
      last_published_at: r.last_published_at ? r.last_published_at.toISOString() : null,
    })),
  };
}

export interface FirmTeamMember {
  user_id: string;
  name: string | null;
  email: string;
  assigned: number;
  active: number;
  overdue: number;
}

/**
 * Workload by reviewer. Only counts engagements belonging to this firm, so a
 * reviewer who also works another firm's book is not double-counted here.
 */
export async function firmTeam(pool: pg.Pool, partnerId: string): Promise<FirmTeamMember[]> {
  const { rows } = await pool.query<{
    user_id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    assigned: string;
    active: string;
    overdue: string;
  }>(
    `SELECT u.id AS user_id, u.first_name, u.last_name, u.email,
            count(*)                                       AS assigned,
            count(*) FILTER (WHERE v.state = ANY($2))      AS active,
            count(*) FILTER (WHERE v.due_date < now()
                               AND v.state = ANY($2))      AS overdue
       FROM valuations v
       JOIN users u ON u.id = v.assigned_reviewer_id
      WHERE v.partner_id = $1 AND ${LIVE_ONLY('v.')}
      GROUP BY u.id, u.first_name, u.last_name, u.email
      ORDER BY count(*) FILTER (WHERE v.state = ANY($2)) DESC, u.email ASC`,
    [partnerId, ACTIVE_STATES],
  );

  return rows.map((r) => ({
    user_id: r.user_id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
    email: r.email,
    assigned: Number(r.assigned),
    active: Number(r.active),
    overdue: Number(r.overdue),
  }));
}

/**
 * Candidates for the attention queue: the firm's live engagements, newest
 * first. The classification itself is pure (domain/firmDashboard.ts) — this
 * only narrows the read to states that can possibly need attention.
 */
export async function firmAttentionCandidates(
  pool: pg.Pool,
  partnerId: string,
  limit: number,
): Promise<FirmValuationRow[]> {
  const { rows } = await pool.query<{
    id: string;
    number: string;
    company_name: string;
    state: string;
    due_date: Date | null;
    waiting_on_client: boolean;
    assigned_reviewer_id: string | null;
    first_name: string | null;
    last_name: string | null;
    reviewer_email: string | null;
    created_at: Date;
    last_comment_at: Date | null;
  }>(
    `SELECT v.id, v.number, v.company_name, v.state, v.due_date, v.waiting_on_client,
            v.assigned_reviewer_id, u.first_name, u.last_name, u.email AS reviewer_email,
            v.created_at, v.last_comment_at
       FROM valuations v
       LEFT JOIN users u ON u.id = v.assigned_reviewer_id
      WHERE v.partner_id = $1 AND ${LIVE_ONLY('v.')} AND v.state = ANY($2)
      ORDER BY v.due_date ASC NULLS LAST, v.created_at ASC
      LIMIT $3`,
    [partnerId, ACTIVE_STATES, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    number: Number(r.number),
    company_name: r.company_name,
    state: r.state as FirmValuationRow['state'],
    due_date: r.due_date ? r.due_date.toISOString() : null,
    waiting_on_client: r.waiting_on_client,
    assigned_reviewer_id: r.assigned_reviewer_id,
    assigned_reviewer_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.reviewer_email || null,
    created_at: r.created_at.toISOString(),
    last_comment_at: r.last_comment_at ? r.last_comment_at.toISOString() : null,
  }));
}
