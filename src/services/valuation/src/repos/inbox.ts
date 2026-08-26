import type pg from 'pg';
import { likeContains } from '../db/like.js';
import { valuationScope, type Principal } from '../auth/rbac.js';
import { visibleCommentKinds } from '../auth/operations.js';
import type { CommentKind } from '../domain/operations.js';

/**
 * The shared inbox — every engagement thread in one list (409.ai §17).
 *
 * `repos/comments.ts` answers "what has been said on this engagement". Nobody
 * works that way: an analyst carrying nine files does not open nine tabs to
 * find out which of them a client replied to overnight. The one question this
 * table has never been able to answer is the one the day starts with, and the
 * only reason it could not is that every query on it was keyed by
 * valuation_id.
 *
 * Read state is per (reader, engagement) and lives in `valuation_comment_reads`
 * (0113). `valuations.last_comment_at` says when a thread last moved, which is
 * a property of the thread; unread is a property of the reader, and the two
 * were previously conflated into a global "6 unread" badge that meant "six
 * threads have moved recently" and went stale for everyone at once.
 */

export interface InboxItem {
  id: string;
  valuation_id: string;
  valuation_number: string;
  company_name: string;
  valuation_kind: string;
  valuation_state: string;
  kind: CommentKind;
  body: string;
  author_id: string | null;
  author_name: string | null;
  author_email: string | null;
  email_meta: { from?: string; subject?: string; message_id?: string } | null;
  pinned: boolean;
  created_at: Date;
  /** Newer than this reader's last-read mark on the engagement. */
  unread: boolean;
}

export interface InboxFilter {
  kinds?: ReadonlySet<CommentKind>;
  unreadOnly?: boolean;
  /** Substring match on body, company name or engagement number. */
  search?: string;
  page: number;
  perPage: number;
}

/**
 * The scope predicate, as SQL, matching `valuationScope` exactly.
 *
 * Returned as a fragment rather than filtered in JS because the inbox is
 * paginated: filtering after the LIMIT would hand a partner user a page of
 * four rows out of fifty and call it page one.
 *
 * The archived rule is part of the fragment rather than added by each of the
 * three callers, for the reason the firm console demonstrated: the list and the
 * badge counting different things is the bug. All three read through here —
 * the page, the unread-thread count behind the nav badge, and "clear inbox" —
 * so a retired engagement is out of the inbox, out of the number beside it, and
 * not something "clear inbox" silently reaches into.
 */
function scopeClause(principal: Principal, params: unknown[]): string | null {
  const scope = valuationScope(principal);
  // `buildValuationWhere` keeps archived engagements out of the list, the
  // counts and the export; the inbox builds its own WHERE and inherited none
  // of it, so a retired engagement kept a live thread in the shared inbox and
  // an unread badge nobody could clear from the engagement itself.
  const live = 'v.archived_at IS NULL';
  switch (scope.kind) {
    case 'all':
      return live;
    case 'partner':
      params.push(scope.partnerId);
      return `${live} AND v.partner_id = $${params.length}`;
    case 'own':
      params.push(scope.userId);
      return `${live} AND v.user_id = $${params.length}`;
    case 'none':
      return null;
  }
}

export interface InboxPage {
  items: InboxItem[];
  total: number;
  unread_total: number;
}

export async function listInbox(
  pool: pg.Pool,
  principal: Principal,
  filter: InboxFilter,
): Promise<InboxPage> {
  const params: unknown[] = [];
  const scope = scopeClause(principal, params);
  // A principal with no scope gets an empty inbox rather than an error: the
  // page is reachable from the nav, and 403ing a nav item is a worse answer
  // than showing nothing.
  if (scope === null) return { items: [], total: 0, unread_total: 0 };

  // Kind visibility is the same rule the per-engagement thread uses — a client
  // sees `chat` and nothing else, so an internal note never reaches an inbox
  // it should not.
  const visible = visibleCommentKinds(principal);
  const kinds = [...(filter.kinds ?? visible)].filter((k) => visible.has(k));
  if (kinds.length === 0) return { items: [], total: 0, unread_total: 0 };

  params.push(kinds);
  const kindClause = `c.kind = ANY($${params.length})`;
  params.push(principal.id);
  const readerParam = `$${params.length}`;

  const where = [scope, kindClause];
  if (filter.search) {
    // `likeContains`, not a hand-rolled `%…%`: the query is a substring the
    // user typed, and ILIKE would otherwise read their `%` and `_` as the
    // pattern language rather than as characters.
    params.push(likeContains(filter.search));
    const p = `$${params.length}`;
    where.push(`(c.body ILIKE ${p} OR v.company_name ILIKE ${p} OR v.number::text ILIKE ${p})`);
  }

  const unreadExpr = `(r.last_read_at IS NULL OR c.created_at > r.last_read_at)`;
  if (filter.unreadOnly) where.push(unreadExpr);

  // LEFT JOIN, not a subquery per row: a reader who has never opened an
  // engagement has no row at all, and everything on it is unread.
  const from = `
    FROM valuation_comments c
    JOIN valuations v ON v.id = c.valuation_id
    LEFT JOIN users u ON u.id = c.author_id
    LEFT JOIN valuation_comment_reads r
      ON r.valuation_id = c.valuation_id AND r.user_id = ${readerParam}
    WHERE ${where.join(' AND ')}`;

  const { rows: totals } = await pool.query<{ total: string; unread_total: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE ${unreadExpr})::text AS unread_total
     ${from}`,
    params,
  );

  const offset = (filter.page - 1) * filter.perPage;
  params.push(filter.perPage, offset);
  const { rows } = await pool.query<InboxItem>(
    `SELECT c.id, c.valuation_id, c.kind, c.body, c.author_id, c.email_meta, c.pinned, c.created_at,
            v.number AS valuation_number, v.company_name,
            v.kind::text AS valuation_kind, v.state::text AS valuation_state,
            nullif(trim(concat(u.first_name, ' ', u.last_name)), '') AS author_name,
            u.email AS author_email,
            ${unreadExpr} AS unread
     ${from}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    items: rows,
    total: Number(totals[0]?.total ?? 0),
    unread_total: Number(totals[0]?.unread_total ?? 0),
  };
}

/**
 * Everything {@link unreadThreadCount} answers differently for, as one string.
 *
 * Built here rather than at the route because this file owns the query, and a
 * key that misses one of the query's inputs is not a stale badge — it is one
 * reader served another reader's number. The three inputs are the three the
 * SQL below actually reads: the scope clause (`valuationScope`), the read-mark
 * join (`principal.id`), and the kind filter (`visibleCommentKinds`). All three
 * derive from the principal, so a role change produces a different key rather
 * than a stale hit under the old one.
 *
 * The kinds are sorted: `visibleCommentKinds` returns a Set, and iteration
 * order is insertion order, so two principals with the same visibility built by
 * different paths would otherwise key differently and each pay for their own
 * miss.
 */
export function unreadThreadCountKey(principal: Principal): string {
  return JSON.stringify({
    scope: valuationScope(principal),
    reader: principal.id,
    kinds: [...visibleCommentKinds(principal)].sort(),
  });
}

/**
 * How many engagements have moved since this reader last looked at them.
 *
 * Threads, not comments: "3" in the nav badge means three files want
 * attention, which is actionable. A comment count means "someone wrote nine
 * paragraphs", which is not.
 */
export async function unreadThreadCount(pool: pg.Pool, principal: Principal): Promise<number> {
  const params: unknown[] = [];
  const scope = scopeClause(principal, params);
  if (scope === null) return 0;

  const visible = [...visibleCommentKinds(principal)];
  params.push(visible, principal.id);
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT c.valuation_id)::text AS count
     FROM valuation_comments c
     JOIN valuations v ON v.id = c.valuation_id
     LEFT JOIN valuation_comment_reads r
       ON r.valuation_id = c.valuation_id AND r.user_id = $${params.length}
     WHERE ${scope}
       AND c.kind = ANY($${params.length - 1})
       AND (r.last_read_at IS NULL OR c.created_at > r.last_read_at)`,
    params,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Mark an engagement's thread read for this reader, as of now.
 *
 * `GREATEST` on conflict, so a stale request cannot move the mark backwards
 * and resurrect messages the reader has already seen — two tabs open on the
 * same thread is enough to produce out-of-order writes.
 */
export async function markThreadRead(pool: pg.Pool, userId: string, valuationId: string): Promise<Date> {
  const { rows } = await pool.query<{ last_read_at: Date }>(
    `INSERT INTO valuation_comment_reads (user_id, valuation_id, last_read_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id, valuation_id) DO UPDATE
       SET last_read_at = GREATEST(valuation_comment_reads.last_read_at, EXCLUDED.last_read_at)
     RETURNING last_read_at`,
    [userId, valuationId],
  );
  return rows[0]!.last_read_at;
}

/** Mark everything in the reader's scope read — the "clear inbox" action. */
export async function markAllRead(pool: pg.Pool, principal: Principal): Promise<number> {
  const params: unknown[] = [];
  const scope = scopeClause(principal, params);
  if (scope === null) return 0;
  params.push(principal.id);
  const { rowCount } = await pool.query(
    `INSERT INTO valuation_comment_reads (user_id, valuation_id, last_read_at)
     SELECT $${params.length}, v.id, now()
     FROM valuations v
     WHERE ${scope} AND EXISTS (SELECT 1 FROM valuation_comments c WHERE c.valuation_id = v.id)
     ON CONFLICT (user_id, valuation_id) DO UPDATE
       SET last_read_at = GREATEST(valuation_comment_reads.last_read_at, EXCLUDED.last_read_at)`,
    params,
  );
  return rowCount ?? 0;
}
