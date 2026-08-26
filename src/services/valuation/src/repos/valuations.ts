import type pg from 'pg';
import { isUlid, newUlid, problems, TtlCache } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import { likeContains, userFullNameSql } from '../db/like.js';
import { CLIENT_VISIBLE_EVENT_TYPES, diffRecords, eventLabel } from '../domain/auditTrail.js';
import { type Cursor, cursorAtSql, encodeCursor, keysetAfterSql, pageFrom } from '../domain/pagination.js';
import {
  EVENT_TYPES,
  type PaidStatus,
  type ValuationKind,
  type ValuationSource,
  type ValuationState,
} from '../domain/valuation.js';
import { OPERATIONS_EVENT_TYPES, STATE_GROUPS, stateGroupOf, type StateGroup } from '../domain/operations.js';
import { namedBucket, namedBucketsFor, NAMED_BUCKET_KEYS, type NamedBucketKey } from '../domain/workflow.js';
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
  paid_status: PaidStatus;
  qsbs_attestation: boolean | null;
  delivery_days: number | null;
  /** bigint — pg hands it back as a string. Drives the pricing band. */
  amount_raised_cents: string | number | null;
  assigned_reviewer_id: string | null;
  /** Per-valuation auto-pipeline opt-out (migration 0049). */
  auto_pipeline: boolean;
  /**
   * The partner's own identifier for this engagement (migration 0164). Unique
   * per partner, set only by the partner API, NULL for everything created
   * through the web app.
   */
  external_id: string | null;
  /** Optimistic-lock counter, bumped by every write (migration 0137). */
  version: number;
  /**
   * Soft delete, written by the retention sweep. Declared rather than left to
   * the index signature below because every write path has to be able to ask:
   * `buildValuationWhere` keeps archived rows out of the *lists*, and a route
   * holding one row by id has nothing but this column to go on.
   */
  archived_at: Date | null;
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
  /** Partner's own id for this engagement. Unique per partner — see 0164. */
  externalId?: string | null;
}

/**
 * The aggregate root + its 1:1 params row + the birth event, on a caller's
 * transaction.
 *
 * Exported separately from `createValuation` so a caller that has more to do
 * atomically — converting a submitted client-intake link, which must claim the
 * link and seed the questionnaire in the same breath — can compose with it
 * rather than re-spelling this INSERT and drifting from it.
 */
export async function insertValuation(
  client: pg.PoolClient,
  input: CreateValuationInput,
  actor: EventActor,
): Promise<ValuationRow> {
  const id = newUlid();
  const { rows } = await client.query<ValuationRow>(
    `INSERT INTO valuations
       (id, kind, company_name, service_name, user_id, partner_id, source, currency, service_countries, gclid,
        external_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      input.externalId ?? null,
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
}

/** Creates the aggregate root + its 1:1 params row + the birth event, atomically. */
export async function createValuation(
  pool: pg.Pool,
  input: CreateValuationInput,
  actor: EventActor,
): Promise<ValuationRow> {
  return withTransaction(pool, async (client) => insertValuation(client, input, actor));
}

/**
 * Read-through cache for the single hottest query in the service.
 *
 * Almost every valuation-scoped route starts by loading the row to authorize
 * against it, and the busier pages load several of those routes at once — the
 * detail view alone fans out to params, cap table, documents, comments,
 * progress and the audit trail, each re-fetching the same row before doing its
 * own work. Those are identical `WHERE id = $1` lookups within milliseconds of
 * each other.
 *
 * Correctness rests on invalidation, not on the TTL: every statement in this
 * service that writes to `valuations` invalidates the row afterwards, and there
 * are only eight of them (this file, plus comments, organizations, retention
 * and pipelineRuns — see the callers of the two exports). The TTL is the
 * backstop for a writer nobody remembered to wire up and for the day this
 * service runs more than one process, and it is deliberately short enough that
 * a stale read cannot outlive a page view.
 *
 * *Afterwards* is load-bearing, and is why there are two exports rather than
 * one: a transactional writer must invalidate after its COMMIT, because a drop
 * issued before the commit is a drop a concurrent reader can refill from the
 * pre-commit row. {@link invalidateValuationAfter} is the wrapper for those;
 * {@link invalidateValuation} is for the auto-commit single statements.
 *
 * `getOrLoad` also collapses concurrent identical lookups into one query, which
 * is what actually helps the fan-out above: those six requests arrive together,
 * so they share a single round trip rather than queueing six.
 */
const VALUATION_CACHE_TTL_MS = 5_000;

const valuationCache = new TtlCache<ValuationRow | null>({
  ttlMs: VALUATION_CACHE_TTL_MS,
  // Roughly a busy analyst's working set; eviction is oldest-first.
  maxEntries: 1_000,
});

/**
 * Drops a valuation from the read cache. Call after any statement that writes
 * to the `valuations` row — including from other repos, which is why this is
 * exported rather than kept private to this module.
 *
 * *After the write is visible to other connections*, which for a transactional
 * writer means after COMMIT, not after the UPDATE. `TtlCache` already handles an
 * invalidation that lands mid-load — it marks the in-flight load stale so its
 * result is not published — but that defence only covers a load that had already
 * started. Called from inside the transaction, this drops the entry and then
 * leaves a window, up to the length of the rest of the transaction, in which a
 * concurrent reader starts a *fresh* load, reads the pre-commit row on its own
 * connection, and caches it. No invalidation follows it, so the superseded row
 * is then served for a full TTL — the failure this cache says it does not have,
 * arrived at from the opposite direction.
 *
 * It is not academic: `patchValuation` writes the row, records one or two
 * events, and only then commits, and every state transition on the platform
 * goes through it. A read landing in that window pins the *old* `state` — the
 * field `canReadReport` and the whole publication gate gate on — for five
 * seconds after the transition committed.
 *
 * {@link invalidateValuationAfter} is the shape that cannot get this wrong.
 */
export function invalidateValuation(id: string): void {
  valuationCache.delete(id);
}

/**
 * Runs a transactional write and invalidates the row's cache entry once it has
 * committed, whatever the outcome of the write.
 *
 * Invalidating on the failure path too is deliberate and free: a rolled-back
 * transaction has changed nothing, so the drop costs one re-read and cannot be
 * wrong, whereas working out which failures could not have touched the row is
 * exactly the reasoning that produces a stale cache entry later.
 */
export async function invalidateValuationAfter<T>(id: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } finally {
    valuationCache.delete(id);
  }
}

/** Empties the cache. For tests, and for anything that rewrites rows in bulk. */
export function clearValuationCache(): void {
  valuationCache.clear();
}

export async function findValuationById(pool: pg.Pool, id: string): Promise<ValuationRow | null> {
  return valuationCache.getOrLoad(id, async () => {
    const { rows } = await pool.query<ValuationRow>('SELECT * FROM valuations WHERE id = $1', [id]);
    return rows[0] ?? null;
  });
}

/**
 * Batch counterpart to findValuationById, keyed by id for O(1) lookup.
 *
 * The monitoring dashboard and scan iterate every enabled monitor; fetching each
 * valuation individually meant one round trip per monitor before any of the real
 * work started, and that cost grew linearly with the number of monitored
 * companies. `= ANY($1)` collapses it to one query.
 *
 * Ids missing from the result are simply absent from the map — callers already
 * skip monitors whose valuation has been deleted.
 */
export async function findValuationsByIds(pool: pg.Pool, ids: string[]): Promise<Map<string, ValuationRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query<ValuationRow>('SELECT * FROM valuations WHERE id = ANY($1)', [
    [...new Set(ids)],
  ]);
  return new Map(rows.map((row) => [row.id, row]));
}

export async function findValuationByNumber(pool: pg.Pool, number: number): Promise<ValuationRow | null> {
  const { rows } = await pool.query<ValuationRow>('SELECT * FROM valuations WHERE number = $1', [number]);
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
  /**
   * Tabbed scope: one of the nine named buckets (design §4.2), defined once in
   * `domain/workflow.NAMED_BUCKETS`. Takes precedence over `group`, which stays
   * a URL alias so saved views and shared links keep working.
   */
  bucket?: NamedBucketKey;
  /** Free search: exact ULID / engagement number / workflow id, else company-name substring. */
  q?: string;
  /**
   * The users whose email or name matched `q`, already resolved.
   *
   * See {@link resolveQueryOwners} for why this is a *value* rather than the
   * subquery it used to be. `undefined` means nobody has resolved it and the
   * correlated `EXISTS` is used; `null` means the search matched more owners
   * than {@link Q_OWNER_LIMIT} and the `EXISTS` is used deliberately.
   */
  qOwnerIds?: readonly string[] | null;
  /** Explicit id list — powers bulk export of a checkbox selection. */
  ids?: string[];
  /**
   * Unread scope (gap 4): keep only valuations whose conversation moved since
   * the given side last opened them (last_comment_at vs *_read_at).
   */
  unreadFor?: 'admin' | 'user';
  reviewerId?: string;
  partnerId?: string;
  /**
   * The partner's own id for the engagement (migration 0164). Exact match: it
   * is a lookup key, not a search term, and the partner API's whole reason for
   * offering it is that it resolves to at most one row.
   */
  externalId?: string;
  userId?: string;
  source?: ValuationSource;
  paidStatus?: 'unpaid' | 'paid' | 'paid_by_partner';
  waitingOnClient?: boolean;
  createdFrom?: string;
  createdTo?: string;
  dueFrom?: string;
  dueTo?: string;
  /**
   * Engagement tags (migration 0153) — every slug must be present, and only
   * `accepted` ones count.
   *
   * AND rather than OR because that is what the query is for. "Pre-revenue
   * medtech with a participating stack" is one precedent question; the OR of
   * those three tags is most of the book of work, which is not a filter anyone
   * asked for. A caller wanting alternatives issues the requests separately and
   * knows which result is which.
   *
   * `suggested` tags are excluded for the reason they exist: a suggestion
   * nobody has reviewed must not silently change which engagements an analyst
   * sees when they filter.
   */
  tags?: string[];
  /**
   * Include archived engagements, which are excluded from every read by
   * default. Opt-in rather than opt-out because the default is what a list, a
   * count and an export all want, and the one caller that wants the whole
   * table (retention's own reporting) is better off saying so.
   */
  includeArchived?: boolean;
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

/**
 * The sortable columns that can actually hold a NULL.
 *
 * `NULLS LAST` reads as a harmless belt-and-braces on an ORDER BY, and on a
 * NOT NULL column it is: it cannot change a single row's position. What it
 * changes is the *plan*. A plain btree is stored ASC NULLS LAST, so reading it
 * backwards yields DESC NULLS **FIRST** — which means `col DESC NULLS LAST`
 * matches no index this schema has, and Postgres falls back to reading every
 * live row and top-N heapsorting it. Spelled without the no-op, the same sort
 * is an index scan: measured on 40k valuations, `created_at DESC` is 0.47ms and
 * `created_at DESC NULLS LAST` is 30ms, for identical output.
 *
 * So the clause is emitted only where it means something. The set is asserted
 * against `information_schema` in `listSortPlans.test.ts` rather than trusted:
 * a column that gains or loses NOT NULL has to move between these two
 * treatments, and nothing else in the file would notice.
 */
export const NULLABLE_SORT_COLUMNS: ReadonlySet<SortableColumn> = new Set(['due_date', 'published_at']);

export interface SortSpec {
  column: SortableColumn;
  dir: 'asc' | 'desc';
}

/**
 * Sort terms one request may name.
 *
 * The columns are whitelisted, so no term can be an injection — but the *count*
 * was unbounded, and every term becomes another key Postgres sorts the result
 * set by. There are only eight sortable columns and repeating one changes
 * nothing after the first, so any request past that is naming a column twice.
 * Ten leaves room for every column plus slack, and turns the ORDER BY into
 * something whose size does not depend on the query string's.
 */
export const MAX_SORT_TERMS = 10;

/** Parses "company_name:asc,created_at:desc"; returns null on any bad part. */
export function parseSort(raw: string | undefined): SortSpec[] | null {
  if (!raw) return [];
  const parts = raw.split(',');
  if (parts.length > MAX_SORT_TERMS) return null;
  const specs: SortSpec[] = [];
  for (const part of parts) {
    const [column, dir = 'asc'] = part.trim().split(':');
    if (!(SORTABLE_COLUMNS as readonly string[]).includes(column ?? '')) return null;
    if (dir !== 'asc' && dir !== 'desc') return null;
    specs.push({ column: column as SortableColumn, dir });
  }
  return specs;
}

/**
 * `alias` prefixes the column references, exactly as `buildValuationWhere` does.
 * The export query joins `users` and `partners`, both of which have their own
 * `created_at` and `id`, so an unqualified term there is not merely untidy — it
 * is an ambiguous-column error from Postgres.
 *
 * Exported for the tiebreaker sweep only: this is the one paged query whose
 * ORDER BY is built rather than written inline, so a source scan reading the
 * SQL literal sees an interpolation and cannot judge it. The sweep calls this
 * instead, which is the stronger check anyway — it judges both branches.
 */
export function orderBySql(sort: SortSpec[] | undefined, alias = ''): string {
  // The tiebreaker belongs on both branches, and used to be on only one.
  //
  // `created_at` defaults to `now()`, which in Postgres is the *transaction*
  // timestamp — every row written by one transaction carries the same instant to
  // the microsecond. Rows tying the sort key have no defined order between two
  // statements, and the page query is issued twice with different OFFSETs, so a
  // tie straddling a page boundary can serve the same engagement on both pages
  // and never serve its neighbour on either. `total` still counts it, which is
  // how this reads to a client: a list whose last page is short and whose count
  // says a row is missing.
  //
  // The default branch is the one the UI actually uses — sorting is opt-in — so
  // the branch that had the tiebreaker was the branch that needed it less.
  //
  // The tiebreaker's *direction* follows the last sort term, and that is a plan
  // decision rather than an ordering one. `col DESC, id ASC` is a mixed
  // ordering: no single btree can be read forwards or backwards to produce it,
  // so it costs a sort node however well the leading column is indexed.
  // `col DESC, id DESC` is one backward scan of `(col, id)`. Determinism — the
  // only thing the tiebreaker is here for — is indifferent to which way `id`
  // runs, so this buys the plan for nothing.
  //
  // The default branch keeps `id ASC` because it is not free there:
  // `keysetAfterSql` pairs `created_at DESC` with `id > $id`, and the cursor
  // predicate and the ORDER BY have to agree or the page silently skips rows.
  // `sortSupportsCursor` is what keeps the two branches apart — a custom sort
  // never gets a cursor, so only the default branch is spoken for.
  const parts = sort?.length
    ? sort.map((s) => {
        const dir = s.dir === 'desc' ? 'DESC' : 'ASC';
        const nulls = NULLABLE_SORT_COLUMNS.has(s.column) ? ' NULLS LAST' : '';
        return `${alias}${s.column} ${dir}${nulls}`;
      })
    : [`${alias}created_at DESC`];
  const tiebreak = sort?.length && sort[sort.length - 1]!.dir === 'desc' ? 'DESC' : 'ASC';
  parts.push(`${alias}id ${tiebreak}`); // deterministic tiebreaker for stable pagination
  return `ORDER BY ${parts.join(', ')}`;
}

export interface ListFilters extends ValuationFilters {
  sort?: SortSpec[];
  page: number;
  perPage: number;
  /** Which read marker the computed per-row `unread` flag compares against. */
  readerSide?: 'admin' | 'user';
  /**
   * Page by keyset from this position instead of by `page`. Ignored under a
   * caller-chosen `sort`, which the keyset predicate cannot page — see
   * {@link sortSupportsCursor}.
   */
  cursor?: Cursor | null;
}

/**
 * How many owner matches a text search may resolve before it gives up and uses
 * the correlated form.
 *
 * The fast path passes the matching owners as an array parameter, so its cost
 * is the array's size. A search broad enough to match a thousand accounts is
 * one whose company-name half already matches most of the book, so the scan the
 * fallback plans is going to happen either way — and refusing to enumerate past
 * this point is what keeps the array from becoming the new problem. Deliberately
 * *not* a `LIMIT` on the owner list: truncating it would silently drop
 * engagements from a search that says nothing about having done so.
 */
export const Q_OWNER_LIMIT = 1_000;

/**
 * Resolves the owner half of a free-text search into ids, ahead of the query
 * that filters on it.
 *
 * `q` matches three things: the company name, an exact workflow id, and the
 * requesting user's name or email. The third used to be a correlated `EXISTS`
 * against `users`, sitting inside the same `OR` as the other two — and that one
 * placement cost the whole predicate its indexes. Postgres can answer
 * `a ILIKE ? OR b = ?` from a `BitmapOr` over the trigram and btree indexes; add
 * a subquery as a third arm and no arm can be an index condition any more, so
 * the plan degrades to reading every live valuation and evaluating `ILIKE` per
 * row. Measured on 40k rows: 1.4ms without the `EXISTS`, 23.8ms with it, on both
 * the count and the page — and migration 0149's two trigram indexes on `users`,
 * added for exactly this search, were unreachable the whole time.
 *
 * Resolving first turns the third arm into `user_id = ANY($n)`, a plain value.
 * All three arms are index conditions again, the owner lookup itself is a
 * `BitmapOr` over `users_email_trgm_idx` and `users_full_name_trgm_idx`, and the
 * two statements together cost less than the one did.
 *
 * A no-op for the searches that are not text — an exact ULID or an engagement
 * number never reaches the owner arm — so the extra statement is only spent
 * where it buys something.
 */
export async function resolveQueryOwners<T extends ValuationFilters>(
  pool: pg.Pool,
  filters: T,
): Promise<T> {
  const q = filters.q?.trim();
  if (!q || isUlid(q.toUpperCase()) || /^#?\d{1,12}$/.test(q)) return filters;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users
      WHERE email ILIKE $1 OR ${userFullNameSql('users')} ILIKE $1
      LIMIT $2`,
    [likeContains(q), Q_OWNER_LIMIT + 1],
  );
  // One over the limit: `null` says "too many to enumerate", which
  // `buildValuationWhere` reads as "use the correlated form".
  if (rows.length > Q_OWNER_LIMIT) return { ...filters, qOwnerIds: null };
  return { ...filters, qOwnerIds: rows.map((r) => r.id) };
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

  /*
   * Archived engagements are out of every read unless one is asked for.
   *
   * `archived_at` was written by the retention sweep and read by nothing: the
   * list, the counts, the bucket strip and the export all selected it back, so
   * a soft delete deleted nothing a user could see and the sweep's only visible
   * effect was a row in its own action log. A soft delete whose read path never
   * landed is worse than none — it reports success and changes nothing.
   *
   * Here rather than in each of the ten callers because that is the shape the
   * bug already took once: one WHERE builder, and every read that forgets is a
   * read that shows archived work.
   */
  if (!filters.includeArchived) where.push(`${alias}archived_at IS NULL`);

  if (scope.kind === 'partner') add('partner_id = ?', scope.partnerId);
  if (scope.kind === 'own') add('user_id = ?', scope.userId);
  if (filters.ids?.length) add('id = ANY(?)', filters.ids);
  if (filters.state) add('state = ?', filters.state);
  else if (filters.bucket) {
    // The two non-state buckets are not state predicates: `waiting_on_client`
    // is a boolean that cuts across the lifecycle, and `unread` is per-reader.
    // Both fall through to the clauses already below, which is why neither adds
    // a state filter here rather than getting a special case of its own.
    const bucket = namedBucket(filters.bucket);
    if (bucket?.states.length) add('state = ANY(?::valuation_state[])', [...bucket.states]);
    if (bucket?.waitingOnClient) where.push(`${alias}waiting_on_client`);
  } else if (filters.group) add('state = ANY(?::valuation_state[])', [...STATE_GROUPS[filters.group]]);
  if (filters.kind) add('kind = ?', filters.kind);
  if (filters.reviewerId) add('assigned_reviewer_id = ?', filters.reviewerId);
  if (filters.externalId) add('external_id = ?', filters.externalId);
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
  /*
   * Tags, as one EXISTS per slug.
   *
   * Not `slug = ANY($1)` with a HAVING count: that form needs a GROUP BY the
   * count query and the page query would each have to grow, and it reads as an
   * OR to anyone skimming it. A conjunction of EXISTS clauses says AND in the
   * shape it is, and `valuation_tags_slug_idx` — (slug, valuation_id) WHERE
   * status = 'accepted' — is an index-only lookup for each one.
   */
  if (filters.tags?.length) {
    const idRef = `${alias || 'valuations.'}id`;
    for (const slug of filters.tags) {
      params.push(slug);
      where.push(
        `EXISTS (SELECT 1 FROM valuation_tags vt
                  WHERE vt.valuation_id = ${idRef} AND vt.status = 'accepted' AND vt.slug = $${params.length})`,
      );
    }
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
    } else if (filters.qOwnerIds !== undefined && filters.qOwnerIds !== null) {
      // Company-name substring, exact workflow id, or requester name/email
      // (gap 7 — 409.ai also matches the requesting user), with the owner half
      // supplied as a value. See `resolveQueryOwners`: this is the same
      // predicate as the branch below, and the only form of it Postgres can
      // answer from the indexes.
      params.push(likeContains(q), q, filters.qOwnerIds);
      const like = `$${params.length - 2}`;
      where.push(
        `(${alias}company_name ILIKE ${like} OR ${alias}workflow_id = $${params.length - 1}
          OR ${alias}user_id = ANY($${params.length}))`,
      );
    } else {
      // The fallback: nobody resolved the owners, or there were too many to
      // enumerate. Correct, and the plan R167 measured at 24ms on 40k rows.
      const ownerRef = `${alias || 'valuations.'}user_id`;
      params.push(likeContains(q), q);
      const like = `$${params.length - 1}`;
      where.push(
        `(${alias}company_name ILIKE ${like} OR ${alias}workflow_id = $${params.length}
          OR EXISTS (
            SELECT 1 FROM users su
            WHERE su.id = ${ownerRef}
              AND (su.email ILIKE ${like}
                   OR ${userFullNameSql('su')} ILIKE ${like})
          ))`,
      );
    }
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Whether a cursor can page this ordering.
 *
 * The keyset predicate is written for `created_at DESC, id ASC` specifically —
 * see `keysetAfterSql` — so it is only correct against the default branch of
 * {@link orderBySql}. Under a caller-chosen sort the predicate would filter on
 * a column the ORDER BY is not leading with, which does not error; it silently
 * returns the wrong rows. So the two are mutually exclusive by construction
 * rather than by the caller remembering, and a cursor page reports `nextCursor:
 * null` under a custom sort rather than handing out one that would mislead.
 */
export function sortSupportsCursor(sort: SortSpec[] | undefined): boolean {
  return !sort?.length;
}

/**
 * Scope is enforced in SQL, not post-filtered — partner data never leaves the DB.
 *
 * Pages two ways, and which one runs is decided by whether `filters.cursor` is
 * set. The offset path is what the workspace UI asks for: it renders page
 * numbers and a total, and it is reading a list a human is looking at rather
 * than walking one to the end. The keyset path is what an API client asks for,
 * because a client walking every page while rows are being written needs the
 * page boundaries to stay put — `domain/pagination.ts` has the long version.
 *
 * `total` is answered the same way on both paths, from the same count over the
 * *unfiltered* WHERE: it is the size of the matching set, not the size of what
 * is left after the cursor. A client that renders "1,204 valuations" wants the
 * former and would find the latter counting down as it paged.
 */
export async function listValuations(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: ListFilters,
): Promise<{ items: ValuationRow[]; total: number; nextCursor: string | null; hasMore: boolean }> {
  if (scope.kind === 'none') return { items: [], total: 0, nextCursor: null, hasMore: false };

  const { whereSql, params } = buildValuationWhere(scope, await resolveQueryOwners(pool, filters));

  // Per-row unread flag (gap 4) for the caller's side of the conversation.
  const readCol = filters.readerSide === 'admin' ? 'admin_read_at' : 'user_read_at';
  const unreadSql = filters.readerSide
    ? `, (last_comment_at IS NOT NULL AND (${readCol} IS NULL OR last_comment_at > ${readCol})) AS unread`
    : '';

  const cursorable = sortSupportsCursor(filters.sort);
  const cursor = cursorable ? (filters.cursor ?? null) : null;

  // The cursor's own column, carried on every row so the page's last row can
  // name itself. Selected rather than derived from `row.created_at`, which is a
  // JS Date by then and three digits short of the stored value.
  const cursorSelect = `, ${cursorAtSql('created_at')} AS cursor_at`;

  let listWhere = whereSql;
  const listParams = [...params];
  if (cursor) {
    listParams.push(cursor.at, cursor.id);
    const predicate = keysetAfterSql(
      'created_at',
      'id',
      `$${listParams.length - 1}`,
      `$${listParams.length}`,
    );
    listWhere = whereSql ? `${whereSql} AND ${predicate}` : `WHERE ${predicate}`;
  }
  if (cursor) {
    // One more than the page, so `has_more` is answered by the over-fetch
    // rather than by comparing an offset against a count that may have moved.
    listParams.push(filters.perPage + 1);
  } else {
    listParams.push(filters.perPage, (filters.page - 1) * filters.perPage);
  }
  const limitSql = cursor
    ? `LIMIT $${listParams.length}`
    : `LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;

  // The count and the page share a WHERE clause but neither needs the other's
  // result, and on an ops inbox filtered down from tens of thousands of rows
  // the count is the slower of the two. Running them in sequence made every
  // list request wait for both; issuing them together halves the wall clock at
  // the cost of one extra pooled connection for the duration.
  const [countResult, pageResult] = await Promise.all([
    pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM valuations ${whereSql}`, params),
    pool.query<ValuationRow & { cursor_at: string }>(
      `SELECT *${unreadSql}${cursorSelect} FROM valuations ${listWhere}
       ${orderBySql(filters.sort)}
       ${limitSql}`,
      listParams,
    ),
  ]);

  const total = Number(countResult.rows[0]!.count);
  const fetched = pageResult.rows;
  const page = cursor
    ? pageFrom(fetched, filters.perPage, (row) => ({ at: row.cursor_at, id: row.id }))
    : {
        items: fetched,
        // On the offset path the count is what says whether more remain; there
        // is no over-fetched row to ask.
        hasMore: (filters.page - 1) * filters.perPage + fetched.length < total,
        nextCursor: null as string | null,
      };

  // A first page requested *without* a cursor still hands one back, so a client
  // can open with an ordinary request and switch to cursors from the second
  // page on — without that, cursor paging would only be reachable by a client
  // that already had a cursor, which it could not have got.
  const last = page.items[page.items.length - 1];
  const nextCursor =
    page.nextCursor ??
    (cursorable && page.hasMore && last !== undefined
      ? encodeCursor({ at: last.cursor_at, id: last.id })
      : null);

  // `cursor_at` is an implementation detail of this function. Several callers
  // return the row wholesale to a client, and a stray column there is both a
  // leak of how paging works and, for the routes with `.strict()` response
  // schemas, a validation failure.
  const items = page.items.map(({ cursor_at: _cursorAt, ...row }) => row as ValuationRow);
  return { items, total, nextCursor, hasMore: page.hasMore };
}

/**
 * Stamp the side's read marker; called when a valuation is opened (gap 4).
 *
 * Guarded so that a read only writes when the write would change an answer.
 * The marker is never read as a timestamp — every consumer compares it to
 * `last_comment_at` and to nothing else (`buildValuationWhere`'s `unreadFor`,
 * the per-row `unread` flag, the bucket tallies) — so re-stamping a valuation
 * that is already read is invisible by construction. Unguarded it was not free:
 * `GET /api/v1/valuations/:id` is the most-hit route in the workspace, every
 * open wrote a row on the busiest table in the schema, and the profiling
 * harness ranked this the most expensive statement per call in the read path
 * at 1.9ms — dead tuples and index maintenance on `valuations_created_idx` for
 * a value that already said what it says.
 *
 * The cache drop moved under the same condition. Before, opening a valuation
 * invalidated the entry the same request had just filled, so the 5s read cache
 * could never serve the detail route it exists for: every GET evicted itself.
 *
 * Returns whether the marker moved, which is also how the tests tell a skipped
 * write from a performed one.
 */
export async function markValuationRead(pool: pg.Pool, id: string, side: 'admin' | 'user'): Promise<boolean> {
  const column = side === 'admin' ? 'admin_read_at' : 'user_read_at';
  const { rowCount } = await pool.query(
    `UPDATE valuations SET ${column} = now()
     WHERE id = $1
       AND last_comment_at IS NOT NULL
       AND (${column} IS NULL OR last_comment_at > ${column})`,
    [id],
  );
  const wrote = (rowCount ?? 0) > 0;
  if (wrote) invalidateValuation(id);
  return wrote;
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
    ...(await resolveQueryOwners(pool, filters)),
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

/**
 * Counts for the nine named buckets (design §4.2), inside the caller's scope.
 *
 * One scan for the seven state buckets plus `all`, and two cheap COUNTs for the
 * buckets that are not state predicates. Not nine queries: the tab strip is
 * rendered on every listing page load, and the point of the whole change is
 * that an operator stops writing filters — which they will not do if the page
 * got slower for it.
 *
 * The state/bucket filter itself is dropped, exactly as `countValuationsByGroup`
 * drops the group: each tab shows its own total, not its total within itself.
 */
export interface BucketTally {
  total: number;
  /** Unread by the asking reader — a subset of `total`, not a separate cohort. */
  unread: number;
}

export async function namedBucketBreakdown(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: ValuationFilters,
  readerSide: 'admin' | 'user',
): Promise<Record<NamedBucketKey, BucketTally>> {
  const counts = Object.fromEntries(NAMED_BUCKET_KEYS.map((k) => [k, { total: 0, unread: 0 }])) as Record<
    NamedBucketKey,
    BucketTally
  >;
  if (scope.kind === 'none') return counts;

  const base = {
    ...(await resolveQueryOwners(pool, filters)),
    state: undefined,
    group: undefined,
    bucket: undefined,
    unreadFor: undefined,
  };
  const { whereSql, params } = buildValuationWhere(scope, base);
  const readCol = readerSide === 'admin' ? 'admin_read_at' : 'user_read_at';

  // One scan for all nine buckets and both tallies. The alternative — a count
  // per bucket per tally — is eighteen aggregates over the same table on a page
  // that renders on every navigation, and the sidebar reads this same payload.
  const { rows } = await pool.query<{
    state: ValuationState;
    waiting_on_client: boolean;
    unread: boolean;
    count: string;
  }>(
    `SELECT state, waiting_on_client,
            (last_comment_at IS NOT NULL AND (${readCol} IS NULL OR last_comment_at > ${readCol})) AS unread,
            count(*)::text AS count
       FROM valuations ${whereSql}
      GROUP BY state, waiting_on_client, unread`,
    params,
  );

  const add = (key: NamedBucketKey, n: number, unread: boolean) => {
    counts[key].total += n;
    if (unread) counts[key].unread += n;
  };
  for (const row of rows) {
    const n = Number(row.count);
    // `namedBucketsFor` already includes `all`, and deliberately has no
    // fallback bucket: a state belonging to none of them shows up as counts
    // that do not add up rather than being filed silently under Ignored.
    for (const key of namedBucketsFor(row.state)) add(key, n, row.unread);
    if (row.waiting_on_client) add('waiting_on_client', n, row.unread);
    // The unread bucket is the unread rows themselves, so its own `unread`
    // tally equals its total by construction. Kept rather than special-cased:
    // a reader comparing "12 (12 unread)" against the other rows learns what
    // the bucket means.
    if (row.unread) add('unread', n, true);
  }
  return counts;
}

/** The flat totals the listing tab strip and the sidebar badges read. */
export async function countValuationsByNamedBucket(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: ValuationFilters,
  readerSide: 'admin' | 'user',
): Promise<Record<NamedBucketKey, number>> {
  const breakdown = await namedBucketBreakdown(pool, scope, filters, readerSide);
  return Object.fromEntries(NAMED_BUCKET_KEYS.map((key) => [key, breakdown[key].total])) as Record<
    NamedBucketKey,
    number
  >;
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

/**
 * Valuations published per week, most recent week last (design §3.1).
 *
 * Weeks are Postgres `date_trunc('week', …)` — ISO weeks starting Monday — and
 * every week in the window is returned, including the empty ones. A sparkline
 * drawn from only the non-empty weeks compresses a two-week outage into a
 * continuous line, which is the opposite of what the reader is looking for.
 */
export async function publishThroughput(
  pool: pg.Pool,
  scope: ValuationScope,
  weeks: number,
): Promise<Array<{ week: string; count: number }>> {
  if (scope.kind === 'none') return [];
  const { whereSql, params } = buildValuationWhere(scope, {});
  const scopeClause = whereSql ? `${whereSql} AND` : 'WHERE';
  const { rows } = await pool.query<{ week: string; count: string }>(
    `WITH weeks AS (
       SELECT generate_series(
         date_trunc('week', now()) - make_interval(weeks => $${params.length + 1}::int - 1),
         date_trunc('week', now()),
         interval '1 week'
       ) AS week
     ),
     published AS (
       SELECT date_trunc('week', published_at) AS week, count(*)::text AS count
         FROM valuations ${scopeClause} published_at IS NOT NULL
        GROUP BY 1
     )
     SELECT to_char(w.week, 'YYYY-MM-DD') AS week, coalesce(p.count, '0') AS count
       FROM weeks w LEFT JOIN published p ON p.week = w.week
      ORDER BY w.week ASC`,
    [...params, weeks],
  );
  return rows.map((r) => ({ week: r.week, count: Number(r.count) }));
}

/**
 * How long an engagement may sit waiting on the client before the dashboard
 * calls it out.
 *
 * Seven days, deliberately shorter than `firmDashboard.STALE_WAITING_DAYS`
 * (14). They answer different questions: this is the SLA warning band — "these
 * need a nudge" — and the firm attention band is the escalation. One threshold
 * serving both would either nag at a week or stay silent for a fortnight.
 */
export const SLA_WAITING_DAYS = 7;

/**
 * The two SLA figures the dashboard shows.
 *
 * `idle` matches the firm dashboard's definition — last comment, or creation if
 * there has never been one — so "waiting, no contact" means the same thing on
 * both surfaces.
 */
export async function slaBreaches(
  pool: pg.Pool,
  scope: ValuationScope,
): Promise<{ overdue: number; waiting_stale: number; waiting_days: number }> {
  const empty = { overdue: 0, waiting_stale: 0, waiting_days: SLA_WAITING_DAYS };
  if (scope.kind === 'none') return empty;
  const { whereSql, params } = buildValuationWhere(scope, {});
  const scopeClause = whereSql ? `${whereSql} AND` : 'WHERE';
  const { rows } = await pool.query<{ overdue: string; waiting_stale: string }>(
    `SELECT
       count(*) FILTER (
         WHERE due_date IS NOT NULL AND due_date < now() AND published_at IS NULL
       )::text AS overdue,
       count(*) FILTER (
         WHERE waiting_on_client
           AND coalesce(last_comment_at, created_at) < now() - make_interval(days => $${params.length + 1}::int)
       )::text AS waiting_stale
     FROM valuations ${scopeClause} state <> ALL($${params.length + 2}::valuation_state[])`,
    // A published or abandoned engagement cannot breach an SLA: it is finished.
    [...params, SLA_WAITING_DAYS, ['published', 'cancelled', 'ignored', 'timeout']],
  );
  return {
    overdue: Number(rows[0]!.overdue),
    waiting_stale: Number(rows[0]!.waiting_stale),
    waiting_days: SLA_WAITING_DAYS,
  };
}

/**
 * The recent-activity feed, inside the caller's scope (design §3.1).
 *
 * The spec named `admin_events`; this reads both event tables, because
 * `admin_events` whose subject is a valuation are rare — the workflow writes to
 * `valuation_events` — and a "recent activity" list that is empty on a busy
 * platform is worse than no list. Both branches are constrained to valuations
 * the caller may read, in SQL: a dashboard that counts or names rows a partner
 * may not open is the same cross-firm leak in a smaller font, which is what the
 * scope sweep exists to catch.
 */
export async function dashboardActivity(
  pool: pg.Pool,
  scope: ValuationScope,
  limit: number,
  /**
   * Whether the reader may see analyst tooling. False drops both halves of the
   * internal vocabulary: `valuation_events` narrows to the catalog's
   * client-visible types, and the `admin_events` branch is dropped whole —
   * every admin type is an ops action on someone's engagement, and the feed
   * named them to clients by word-splitting the raw type.
   */
  includeInternal = true,
): Promise<
  Array<{
    id: string;
    scope: 'valuation' | 'admin';
    type: string;
    /**
     * The event type in English, decided here rather than in the browser.
     * The feed mixes both event tables and the frontend used to name the rows
     * from a map of its own that disagreed with the change log's.
     */
    label: string;
    actor_type: string;
    actor_email: string | null;
    valuation_id: string;
    company_name: string;
    number: string;
    occurred_at: Date;
  }>
> {
  if (scope.kind === 'none') return [];
  const { whereSql, params } = buildValuationWhere(scope, {}, 'v.');
  // Both UNION branches reference the same scope placeholders, so the params
  // are passed once. Appending a second copy would leave the second branch
  // still pointing at the first — correct by accident, and one edit away from
  // a partner-scoped feed that silently stops being scoped. Anything added
  // below is therefore numbered *after* them.
  const args: unknown[] = [...params];

  let visibleTypes = '';
  if (!includeInternal) {
    args.push([...CLIENT_VISIBLE_EVENT_TYPES]);
    visibleTypes = `${whereSql ? ' AND' : ' WHERE'} e.type = ANY($${args.length})`;
  }
  // Every branch carries its own ORDER BY and LIMIT — see `mergeWindow`. With
  // the ordering only above the union, both event tables were read *entire*,
  // hashed against the whole of `valuations`, and top-N sorted to produce
  // twenty rows: 63ms on a seeded 220k events, on the landing page, growing
  // with an append-only log that nothing prunes. Each branch now walks its own
  // `occurred_at DESC` index and stops at the cap.
  //
  // Unlike `listActivity`, the join stays *inside* each branch: here it is the
  // scope predicate, not decoration, so a branch capped before it would cap the
  // wrong rows.
  args.push(limit);
  const limitParam = `$${args.length}`;
  const adminBranch = includeInternal
    ? `
         UNION ALL
         (SELECT a.id, 'admin' AS scope, a.type, a.actor_type::text AS actor_type, a.actor_id,
                 v.id AS valuation_id, v.company_name, v.number, a.occurred_at
            FROM admin_events a
            JOIN valuations v ON v.id = a.subject_id
            ${whereSql}${whereSql ? ' AND' : 'WHERE'} a.subject_type = 'valuation'
           ORDER BY a.occurred_at DESC, a.id DESC
           LIMIT ${limitParam})`
    : '';

  const { rows } = await pool.query(
    `SELECT s.*, u.email AS actor_email
       FROM (
         SELECT * FROM (
         (SELECT e.id, 'valuation' AS scope, e.type, e.actor_type::text AS actor_type, e.actor_id,
                 v.id AS valuation_id, v.company_name, v.number, e.occurred_at
            FROM valuation_events e
            JOIN valuations v ON v.id = e.valuation_id
            ${whereSql}${visibleTypes}
           ORDER BY e.occurred_at DESC, e.id DESC
           LIMIT ${limitParam})${adminBranch}
         ) b
          ORDER BY b.occurred_at DESC, b.id DESC
          LIMIT ${limitParam}
       ) s
       LEFT JOIN users u ON u.id = s.actor_id
      ORDER BY s.occurred_at DESC, s.id DESC`,
    args,
  );
  return rows.map((row) => ({ ...row, label: eventLabel(row.type as string) })) as never;
}

/** Rows for CSV export — same scope/filters as the list, joined for display, capped. */
/**
 * The CSV/XLSX export projection.
 *
 * `sort` is honoured here for the same reason the route parses it: an export is
 * the list the caller is looking at, in a file. It used to be dropped — the
 * route validated the caller's sort, rejected a bad one with a 400, and then
 * called this function without it, so every CSV and XLSX came back newest-first
 * however the list had been ordered. Only the PDF branch, which goes through
 * `listValuations`, ever applied it.
 */
export async function exportValuations(
  pool: pg.Pool,
  scope: ValuationScope,
  filters: ValuationFilters & { sort?: SortSpec[] },
  limit = 10_000,
): Promise<Array<Record<string, unknown>>> {
  if (scope.kind === 'none') return [];
  const { whereSql, params } = buildValuationWhere(scope, await resolveQueryOwners(pool, filters), 'v.');
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
     ${orderBySql(filters.sort, 'v.')}
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
    //
    // Both copies are one statement, not one per row: the new ids are minted
    // here and paired to their sources through unnest(), the same batching
    // `insertRecoveryCodes` uses. A roll-forward of an engagement carrying a
    // year of diligence ran a round trip per document inside the clone's
    // transaction, so the wall time — and the time the row locks were
    // held — grew with the size of the engagement being copied.
    const { rows: sourceDocs } = await client.query<{ id: string }>(
      `SELECT id FROM documents WHERE valuation_id = $1 AND deleted_at IS NULL`,
      [source.id],
    );
    if (sourceDocs.length > 0) {
      await client.query(
        `INSERT INTO documents
           (id, valuation_id, kind, filename, content_type, size_bytes, sha256, storage_path, uploaded_by)
         SELECT n.new_id, $1, d.kind, d.filename, d.content_type, d.size_bytes,
                d.sha256, d.storage_path, d.uploaded_by
           FROM documents d
           JOIN unnest($2::ulid[], $3::ulid[]) AS n(src_id, new_id) ON n.src_id = d.id`,
        [id, sourceDocs.map((d) => d.id), sourceDocs.map(() => newUlid())],
      );
    }
    const { rows: sourceRounds } = await client.query<{ id: string }>(
      `SELECT id FROM funding_rounds WHERE valuation_id = $1`,
      [source.id],
    );
    if (sourceRounds.length > 0) {
      await client.query(
        `INSERT INTO funding_rounds
           (id, valuation_id, name, security_type, closed_on, amount_raised_cents,
            pre_money_cents, post_money_cents, shares_issued, notes, created_by)
         SELECT n.new_id, $1, r.name, r.security_type, r.closed_on, r.amount_raised_cents,
                r.pre_money_cents, r.post_money_cents, r.shares_issued, r.notes, r.created_by
           FROM funding_rounds r
           JOIN unnest($2::ulid[], $3::ulid[]) AS n(src_id, new_id) ON n.src_id = r.id`,
        [id, sourceRounds.map((r) => r.id), sourceRounds.map(() => newUlid())],
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
 * The 409 a stale write is refused with.
 *
 * `current` is reported so the client can tell "somebody else saved" from "my
 * own retry raced itself" without a second round trip, and so the UI can offer
 * a reload rather than only an error. It is optional because the row may have
 * been deleted between the read and the write, in which case there is no
 * version to name.
 */
function staleWrite(current: number | undefined, expected: number): never {
  throw problems.conflict(
    `This valuation was changed by someone else (expected version ${expected}, ` +
      `now ${current ?? 'unknown'}). Reload and reapply your changes.`,
  );
}

export interface PatchOptions {
  /**
   * The `version` the caller's copy of the row was read at. When given, the
   * write is conditional on the row still being at that version and a stale
   * write is refused (409) rather than silently overwriting a concurrent edit.
   *
   * Omitted by the internal callers that are not applying a user's form —
   * workflow transitions, review decisions and the Stripe webhook each move one
   * column from a value they just computed, so there is no stale read to guard.
   */
  expectedVersion?: number;
  /**
   * A guard evaluated inside the write's own transaction, on the client that
   * issues the UPDATE, immediately before it. Throwing rolls the whole patch
   * back — no row change, no events.
   *
   * For preconditions whose subject is not this row. `expectedVersion` covers
   * "did the valuation move under me"; it says nothing about the signature and
   * QA rows the publish gate reads, which live in other tables and do not touch
   * `valuations.version` when they change. A guard on those has to run where it
   * can hold them still, which is here — see `assertPublishGateForWrite`.
   */
  preCommit?: (client: pg.PoolClient) => Promise<void>;
}

/**
 * Applies a field-level patch and writes `valuation_updated` (plus
 * `state_changed` when state moves) in the same transaction.
 *
 * `version` is bumped on every write and, when `expectedVersion` is supplied,
 * is also the UPDATE's condition — see migration 0137 for the lost-update this
 * closes. The check is made twice deliberately: once here against the row the
 * caller already read, which catches the ordinary "your tab is stale" case
 * before a transaction is opened, and once in the UPDATE's WHERE, which is the
 * only one that can catch a writer landing between that read and this write.
 */
export async function patchValuation(
  pool: pg.Pool,
  current: ValuationRow,
  fields: Record<string, unknown>,
  actor: EventActor,
  options: PatchOptions = {},
): Promise<ValuationRow> {
  const { expectedVersion } = options;
  if (expectedVersion !== undefined && expectedVersion !== current.version) {
    throw staleWrite(current.version, expectedVersion);
  }

  const changes = diffRecords(current, fields, Object.keys(fields));
  const entries = Object.entries(changes).map(([key, change]) => [key, change.to] as const);
  // Nothing to write, so nothing to lose: the caller's values already match the
  // row. Returning before the transaction keeps a no-op PATCH from burning a
  // version and spuriously conflicting with a concurrent editor.
  if (entries.length === 0) return current;

  return invalidateValuationAfter(current.id, () =>
    withTransaction(pool, async (client) => {
      // First in the transaction, so any lock it takes is held across the
      // UPDATE below rather than merely before it.
      await options.preCommit?.(client);

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

      // Every write moves the version, whether or not this caller asked for the
      // check — a reader that did ask must see a concurrent write it did not.
      sets.push('version = version + 1');

      params.push(current.id);
      let where = `id = $${params.length}`;
      if (expectedVersion !== undefined) {
        params.push(expectedVersion);
        where += ` AND version = $${params.length}`;
      }
      const { rows } = await client.query<ValuationRow>(
        `UPDATE valuations SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
        params,
      );
      // Zero rows is only reachable under a version condition — without one the
      // WHERE is the primary key of a row loaded and authorized moments ago. So
      // somebody committed between this caller's read and this UPDATE.
      if (rows.length === 0 && expectedVersion !== undefined) {
        const { rows: live } = await client.query<{ version: number }>(
          'SELECT version FROM valuations WHERE id = $1',
          [current.id],
        );
        staleWrite(live[0]?.version, expectedVersion);
      }

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
    }),
  );
}
