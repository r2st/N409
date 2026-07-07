import type pg from 'pg';
import { isUlid, newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import {
  EVENT_TYPES,
  type ValuationKind,
  type ValuationSource,
  type ValuationState,
} from '../domain/valuation.js';
import {
  OPERATIONS_EVENT_TYPES,
  STATE_GROUPS,
  stateGroupOf,
  type StateGroup,
} from '../domain/operations.js';
import { recordEvent, type EventActor } from '../events/record.js';
import type { ValuationScope } from '../auth/rbac.js';

export interface ValuationRow {
  id: string;
  number: string;
  workflow_id: string | null;
  kind: ValuationKind;
  state: ValuationState;
  waiting_on_client: boolean;
  company_name: string;
  service_name: string | null;
  user_id: string;
  partner_id: string | null;
  source: ValuationSource | null;
  currency: string;
  service_countries: string[];
  paid_status: 'unpaid' | 'paid' | 'paid_by_partner';
  qsbs_attestation: boolean | null;
  delivery_days: number | null;
  assigned_reviewer_id: string | null;
  /** Per-valuation auto-pipeline opt-out (migration 0049). */
  auto_pipeline: boolean;
  created_at: Date;
  due_date: Date | null;
  published_at: Date | null;
  [key: string]: unknown;
}

export interface CreateValuationInput {
  kind: ValuationKind;
  companyName: string;
  serviceName?: string;
  userId: string;
  partnerId?: string | null;
  source?: ValuationSource;
  currency?: string;
  serviceCountries?: string[];
  gclid?: string;
}

/** Creates the aggregate root + its 1:1 params row + the birth event, atomically. */
export async function createValuation(
  pool: pg.Pool,
  input: CreateValuationInput,
  actor: EventActor,
): Promise<ValuationRow> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<ValuationRow>(
      `INSERT INTO valuations
         (id, kind, company_name, service_name, user_id, partner_id, source, currency, service_countries, gclid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        input.kind,
        input.companyName,
        input.serviceName ?? null,
        input.userId,
        input.partnerId ?? null,
        input.source ?? null,
        input.currency ?? 'USD',
        input.serviceCountries ?? [],
        input.gclid ?? null,
      ],
    );
    await client.query('INSERT INTO valuation_params (valuation_id) VALUES ($1)', [id]);
    await recordEvent(client, {
      valuationId: id,
      type: EVENT_TYPES.created,
      actor,
      payload: { kind: input.kind, company_name: input.companyName, state: 'pending' },
    });
    return rows[0]!;
  });
}

export async function findValuationById(pool: pg.Pool, id: string): Promise<ValuationRow | null> {
  const { rows } = await pool.query<ValuationRow>('SELECT * FROM valuations WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findValuationByNumber(
  pool: pg.Pool,
  number: number,
): Promise<ValuationRow | null> {
  const { rows } = await pool.query<ValuationRow>('SELECT * FROM valuations WHERE number = $1', [
    number,
  ]);
  return rows[0] ?? null;
}

/** Inbox fallback: the sender's most recent engagement (M3 email threading). */
export async function findLatestValuationByOwnerEmail(
  pool: pg.Pool,
  email: string,
): Promise<ValuationRow | null> {
  const { rows } = await pool.query<ValuationRow>(
    `SELECT v.* FROM valuations v
     JOIN users u ON u.id = v.user_id
     WHERE lower(u.email) = lower($1)
     ORDER BY v.created_at DESC
     LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

export interface ValuationFilters {
  state?: ValuationState;
  kind?: ValuationKind;
  /** Tabbed scope: a state group (M3 feature 15). Ignored when `state` is set. */
  group?: StateGroup;
  /** Free search: exact ULID / engagement number / workflow id, else company-name substring. */
  q?: string;
  /** Explicit id list — powers bulk export of a checkbox selection. */
  ids?: string[];
  /**
   * Unread scope (gap 4): keep only valuations whose conversation moved since
   * the given side last opened them (last_comment_at vs *_read_at).
   */
  unreadFor?: 'admin' | 'user';
  reviewerId?: string;
  partnerId?: string;
  userId?: string;
  source?: ValuationSource;
  paidStatus?: 'unpaid' | 'paid' | 'paid_by_partner';
  waitingOnClient?: boolean;
  createdFrom?: string;
  createdTo?: string;
  dueFrom?: string;
  dueTo?: string;
}

/** Rich sort (M4): whitelisted columns only — never interpolate user input. */
export const SORTABLE_COLUMNS = [
  'number',
  'company_name',
  'kind',
  'state',
  'paid_status',
  'created_at',
  'due_date',
  'published_at',
] as const;
export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

export interface SortSpec {
  column: SortableColumn;
  dir: 'asc' | 'desc';
}

/** Parses "company_name:asc,created_at:desc"; returns null on any bad part. */
export function parseSort(raw: string | undefined): SortSpec[] | null {
  if (!raw) return [];
  const specs: SortSpec[] = [];
  for (const part of raw.split(',')) {
    const [column, dir = 'asc'] = part.trim().split(':');
    if (!(SORTABLE_COLUMNS as readonly string[]).includes(column ?? '')) return null;
    if (dir !== 'asc' && dir !== 'desc') return null;
    specs.push({ column: column as SortableColumn, dir });
  }
  return specs;
}

function orderBySql(sort: SortSpec[] | undefined): string {
  if (!sort || sort.length === 0) return 'ORDER BY created_at DESC';
  const parts = sort.map((s) => `${s.column} ${s.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
  parts.push('id ASC'); // deterministic tiebreaker for stable pagination
  return `ORDER BY ${parts.join(', ')}`;
}

export interface ListFilters extends ValuationFilters {
  sort?: SortSpec[];
  page: number;
  perPage: number;
  /** Which read marker the computed per-row `unread` flag compares against. */
  readerSide?: 'admin' | 'user';
}

/**
 * Shared WHERE builder: RBAC scope + M3 advanced filters, all enforced in SQL.
 * `alias` prefixes column references when the query joins other tables.
 * Exported for unit tests only.
 */
export function buildValuationWhere(
  scope: ValuationScope,
  filters: ValuationFilters,
  alias = '',
): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(`${alias}${clause.replace('?', `$${params.length}`)}`);
  };

  if (scope.kind === 'partner') add('partner_id = ?', scope.partnerId);
  if (scope.kind === 'own') add('user_id = ?', scope.userId);
  if (filters.ids?.length) add('id = ANY(?)', filters.ids);
  if (filters.state) add('state = ?', filters.state);
  else if (filters.group) add('state = ANY(?::valuation_state[])', [...STATE_GROUPS[filters.group]]);
  if (filters.kind) add('kind = ?', filters.kind);
  if (filters.reviewerId) add('assigned_reviewer_id = ?', filters.reviewerId);
  if (filters.partnerId) add('partner_id = ?', filters.partnerId);
  if (filters.userId) add('user_id = ?', filters.userId);
  if (filters.source) add('source = ?', filters.source);
  if (filters.paidStatus) add('paid_status = ?', filters.paidStatus);
  if (filters.waitingOnClient !== undefined) add('waiting_on_client = ?', filters.waitingOnClient);
  // *_to bounds are inclusive calendar dates: created_to=2026-07-01 keeps the whole day.
  if (filters.unreadFor) {
    const readCol = filters.unreadFor === 'admin' ? 'admin_read_at' : 'user_read_at';
    where.push(
      `${alias}last_comment_at IS NOT NULL AND (${alias}${readCol} IS NULL OR ${alias}last_comment_at > ${alias}${readCol})`,
    );
  }
  if (filters.createdFrom) add('created_at >= ?', filters.createdFrom);
  if (filters.createdTo) add(`created_at < ?::timestamptz + interval '1 day'`, filters.createdTo);
  if (filters.dueFrom) add('due_date >= ?', filters.dueFrom);
  if (filters.dueTo) add(`due_date < ?::timestamptz + interval '1 day'`, filters.dueTo);

  if (filters.q) {
    const q = filters.q.trim();
    if (isUlid(q.toUpperCase())) {
      params.push(q.toUpperCase());
      where.push(`(${alias}id = $${params.length} OR ${alias}workflow_id = $${params.length})`);
    } else if (/^#?\d{1,12}$/.test(q)) {
      add('number = ?', Number(q.replace('#', '')));
    } else {
      // Company-name substring, exact workflow id, or requester name/email
      // (gap 7 — 409.ai also matches the requesting user).
      const ownerRef = `${alias || 'valuations.'}user_id`;
      params.push(`%${q}%`, q);
      const like = `$${params.length - 1}`;
      where.push(
        `(${alias}company_name ILIKE ${like} OR ${alias}workflow_id = $${params.length}
          OR EXISTS (
            SELECT 1 FROM users su
            WHERE su.id = ${ownerRef}
              AND (su.email ILIKE ${like}
                   OR concat_ws(' ', su.first_name, su.last_name) ILIKE ${like})
          ))`,
      );
    }
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Scope is enforced in SQL, not post-filtered — partner data never leaves the DB. */
export async function listValuations(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: ListFilters,
): Promise<{ items: ValuationRow[]; total: number }> {
  if (scope.kind === 'none') return { items: [], total: 0 };

  const { whereSql, params } = buildValuationWhere(scope, filters);
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM valuations ${whereSql}`,
    params,
  );

  // Per-row unread flag (gap 4) for the caller's side of the conversation.
  const readCol = filters.readerSide === 'admin' ? 'admin_read_at' : 'user_read_at';
  const unreadSql = filters.readerSide
    ? `, (last_comment_at IS NOT NULL AND (${readCol} IS NULL OR last_comment_at > ${readCol})) AS unread`
    : '';

  const paged = [...params, filters.perPage, (filters.page - 1) * filters.perPage];
  const { rows } = await pool.query<ValuationRow>(
    `SELECT *${unreadSql} FROM valuations ${whereSql}
     ${orderBySql(filters.sort)}
     LIMIT $${paged.length - 1} OFFSET $${paged.length}`,
    paged,
  );
  return { items: rows, total: Number(countRows[0]!.count) };
}

/** Stamp the side's read marker; called when a valuation is opened (gap 4). */
export async function markValuationRead(
  pool: pg.Pool,
  id: string,
  side: 'admin' | 'user',
): Promise<void> {
  const column = side === 'admin' ? 'admin_read_at' : 'user_read_at';
  await pool.query(`UPDATE valuations SET ${column} = now() WHERE id = $1`, [id]);
}

/** Live counts per tab (state group), honouring scope + every non-tab filter. */
export async function countValuationsByGroup(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: ValuationFilters,
): Promise<Record<StateGroup | 'all', number>> {
  const counts: Record<StateGroup | 'all', number> = {
    all: 0,
    open: 0,
    in_review: 0,
    drafted: 0,
    published: 0,
    closed: 0,
  };
  if (scope.kind === 'none') return counts;

  // Each tab shows its own total, so the state/group filter itself is dropped.
  const { whereSql, params } = buildValuationWhere(scope, {
    ...filters,
    state: undefined,
    group: undefined,
  });
  const { rows } = await pool.query<{ state: ValuationState; count: string }>(
    `SELECT state, count(*)::text AS count FROM valuations ${whereSql} GROUP BY state`,
    params,
  );
  for (const row of rows) {
    const n = Number(row.count);
    counts[stateGroupOf(row.state)] += n;
    counts.all += n;
  }
  return counts;
}

export interface DashboardStatsRow {
  kind: ValuationKind;
  state: ValuationState;
  source: ValuationSource | null;
  count: number;
}

/** Raw kind × state × source counts for the dashboard pivot/pies (M3 feature 17). */
export async function dashboardStats(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: Pick<ValuationFilters, 'createdFrom' | 'createdTo'>,
): Promise<DashboardStatsRow[]> {
  if (scope.kind === 'none') return [];
  const { whereSql, params } = buildValuationWhere(scope, filters);
  const { rows } = await pool.query<{
    kind: ValuationKind;
    state: ValuationState;
    source: ValuationSource | null;
    count: string;
  }>(
    `SELECT kind, state, source, count(*)::text AS count
     FROM valuations ${whereSql}
     GROUP BY kind, state, source`,
    params,
  );
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

/** Rows for CSV export — same scope/filters as the list, joined for display, capped. */
export async function exportValuations(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: ValuationFilters,
  limit = 10_000,
): Promise<Array<Record<string, unknown>>> {
  if (scope.kind === 'none') return [];
  const { whereSql, params } = buildValuationWhere(scope, filters, 'v.');
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT v.id, v.number, v.workflow_id, v.kind, v.state, v.company_name, v.service_name,
            u.email AS owner_email, p.name AS partner_name, v.source, v.currency,
            v.paid_status, v.waiting_on_client, r.email AS reviewer_email,
            v.created_at, v.due_date, v.published_at
     FROM valuations v
     LEFT JOIN users u ON u.id = v.user_id
     LEFT JOIN partners p ON p.id = v.partner_id
     LEFT JOIN users r ON r.id = v.assigned_reviewer_id
     ${whereSql}
     ORDER BY v.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Clone / roll-forward (M3 feature 18): duplicate the aggregate root and its
 * methodology params into a fresh 'pending' engagement, linked back through
 * the audit spine.
 */
export async function cloneValuation(
  pool: pg.Pool,
  source: ValuationRow,
  opts: { rollForward: boolean; userId: string },
  actor: EventActor,
): Promise<ValuationRow> {
  return withTransaction(pool, async (client) => {
    const id = newUlid();
    const { rows } = await client.query<ValuationRow>(
      `INSERT INTO valuations
         (id, kind, company_name, service_name, user_id, partner_id, source, currency,
          service_countries, delivery_days, assigned_reviewer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        source.kind,
        source.company_name,
        source.service_name,
        opts.userId,
        source.partner_id,
        source.source,
        source.currency,
        source.service_countries,
        source.delivery_days,
        source.assigned_reviewer_id,
      ],
    );
    // Copy methodology params; a roll-forward flags the copy for re-dating.
    await client.query(
      `INSERT INTO valuation_params
         (valuation_id, rolling_forward, inception_date, fiscal_year_end, exit_timeline,
          business_overview, revenue_status, last_round_date, last_year_revenue_cents,
          ytd_revenue_cents, runway_months, weight_asset, weight_opm, weight_income,
          weight_market, dloc, dlom, dlom_method, dlom_qualitative, market_method,
          market_horizon, market_custom_ranges, asset_method)
       SELECT $2, $3, inception_date, fiscal_year_end, exit_timeline,
              business_overview, revenue_status, last_round_date, last_year_revenue_cents,
              ytd_revenue_cents, runway_months, weight_asset, weight_opm, weight_income,
              weight_market, dloc, dlom, dlom_method, dlom_qualitative, market_method,
              market_horizon, market_custom_ranges, asset_method
       FROM valuation_params WHERE valuation_id = $1`,
      [source.id, id, opts.rollForward],
    );
    // Deeper clone (gap 5): carry documents, funding rounds, and workbook
    // cells so a roll-forward starts from last year's data, not a blank
    // engagement. Document rows are duplicated but point at the same
    // content-addressed blob (sha-prefixed storage path), so no file copying.
    const { rows: sourceDocs } = await client.query<{ id: string }>(
      `SELECT id FROM documents WHERE valuation_id = $1 AND deleted_at IS NULL`,
      [source.id],
    );
    for (const doc of sourceDocs) {
      await client.query(
        `INSERT INTO documents
           (id, valuation_id, kind, filename, content_type, size_bytes, sha256, storage_path, uploaded_by)
         SELECT $1, $2, kind, filename, content_type, size_bytes, sha256, storage_path, uploaded_by
         FROM documents WHERE id = $3`,
        [newUlid(), id, doc.id],
      );
    }
    const { rows: sourceRounds } = await client.query<{ id: string }>(
      `SELECT id FROM funding_rounds WHERE valuation_id = $1`,
      [source.id],
    );
    for (const round of sourceRounds) {
      await client.query(
        `INSERT INTO funding_rounds
           (id, valuation_id, name, security_type, closed_on, amount_raised_cents,
            pre_money_cents, post_money_cents, shares_issued, notes, created_by)
         SELECT $1, $2, name, security_type, closed_on, amount_raised_cents,
                pre_money_cents, post_money_cents, shares_issued, notes, created_by
         FROM funding_rounds WHERE id = $3`,
        [newUlid(), id, round.id],
      );
    }
    const { rowCount: cellCount } = await client.query(
      `INSERT INTO workbook_cells (valuation_id, sheet, row_key, column_key, value, updated_by)
       SELECT $2, sheet, row_key, column_key, value, updated_by
       FROM workbook_cells WHERE valuation_id = $1`,
      [source.id, id],
    );

    await recordEvent(client, {
      valuationId: id,
      type: EVENT_TYPES.created,
      actor,
      payload: { kind: source.kind, company_name: source.company_name, state: 'pending' },
    });
    await recordEvent(client, {
      valuationId: id,
      type: OPERATIONS_EVENT_TYPES.cloned,
      actor,
      payload: {
        from: source.id,
        from_number: source.number,
        roll_forward: opts.rollForward,
        copied: {
          documents: sourceDocs.length,
          funding_rounds: sourceRounds.length,
          workbook_cells: cellCount ?? 0,
        },
      },
    });
    return rows[0]!;
  });
}

const TIMESTAMP_ON_STATE: Partial<Record<ValuationState, string>> = {
  started: 'started_at',
  user_finished: 'user_finished_at',
  completed: 'completed_at',
  drafted: 'drafted_at',
  draft_accepted: 'draft_accepted_at',
  published: 'published_at',
};

/**
 * Applies a field-level patch and writes `valuation_updated` (plus
 * `state_changed` when state moves) in the same transaction.
 */
export async function patchValuation(
  pool: pg.Pool,
  current: ValuationRow,
  fields: Record<string, unknown>,
  actor: EventActor,
): Promise<ValuationRow> {
  const entries = Object.entries(fields).filter(([k, v]) => current[k] !== v);
  if (entries.length === 0) return current;

  return withTransaction(pool, async (client) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of entries) {
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    }

    const newState = fields.state as ValuationState | undefined;
    if (newState && newState !== current.state) {
      const tsColumn = TIMESTAMP_ON_STATE[newState];
      if (tsColumn) sets.push(`${tsColumn} = now()`);
    }

    params.push(current.id);
    const { rows } = await client.query<ValuationRow>(
      `UPDATE valuations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );

    const changes = Object.fromEntries(entries.map(([k, v]) => [k, { from: current[k] ?? null, to: v }]));
    await recordEvent(client, {
      valuationId: current.id,
      type: EVENT_TYPES.updated,
      actor,
      payload: { changes },
    });
    if (newState && newState !== current.state) {
      await recordEvent(client, {
        valuationId: current.id,
        type: EVENT_TYPES.stateChanged,
        actor,
        payload: { from: current.state, to: newState },
      });
    }
    return rows[0]!;
  });
}
