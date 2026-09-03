import { z } from 'zod';
import { isStorableDate } from './calendarRange.js';

/**
 * The `page` half of every paginated query string.
 *
 * `per_page` has always carried a ceiling — every list route caps it somewhere
 * between 25 and 500, because the cost of one page is obviously the caller's to
 * choose and obviously worth bounding. `page` carried only `.min(1)`, on the
 * reasoning that asking for a page past the end is harmless: the query matches
 * nothing and the route answers with an empty list.
 *
 * That holds right up to the point where the number stops being a plausible
 * page. Every repo turns it into `(page - 1) * perPage` and hands the result to
 * `OFFSET`, and Postgres reads OFFSET as a bigint:
 *
 *   ?page=10000000000000000000  → 250000000000000000000
 *                                 "is out of range for type bigint"
 *   ?page=1000000000000000000000 → JS stringifies it as "2.5e+22"
 *                                 "invalid input syntax for type bigint"
 *
 * Either way the driver throws, nothing catches it, and an unauthenticated-shaped
 * typo in a query string is a 500 on eight list endpoints — the same
 * error-shape oracle that malformed route ids used to be before
 * `plugins/params.ts`.
 *
 * The ceiling is deliberately far above any real request. At the largest
 * `per_page` in the codebase (500) it still admits 50M rows of paging, which no
 * UI walks and no export should be doing a page at a time — and deep offsets are
 * their own performance problem long before this bound is reached. It exists to
 * keep an impossible page from reaching SQL, not to ration a legitimate one.
 */
export const MAX_PAGE = 100_000;

/**
 * `page`, bounded. A value past `MAX_PAGE` is a 422 naming the field rather
 * than a 500 naming nothing.
 */
export const pageParam = () => z.coerce.number().int().min(1).max(MAX_PAGE).default(1);

/**
 * The OFFSET for a page, as the repos compute it. Exported so the bound above
 * can be tested against the thing it is actually bounding.
 */
export function offsetFor(page: number, perPage: number): number {
  return (page - 1) * perPage;
}

/**
 * How many rows one branch of a merged feed has to contribute.
 *
 * `ORDER BY t DESC LIMIT n OFFSET k` written *above* a `UNION ALL` is answered
 * the only way it can be: every branch is materialised in full, the lot is
 * sorted, and n rows are kept. On an append-only table that is a scan of the
 * whole history to render one screen, and it gets slower every day the product
 * is used — the shape R167 found on three feeds at once.
 *
 * The rewrite is to cap each branch *before* the merge, and this is the cap.
 * The n+k rows the caller ends up with are, by construction, within the top n+k
 * of the branch each came from: a row sitting at position n+k+1 or later in its
 * own branch already has n+k branch-mates ahead of it, so it cannot be in the
 * top n+k of a superset. Capping each branch at n+k therefore discards only
 * rows that could not have been returned, and the merge sorts
 * (branches × (n+k)) rows instead of the tables.
 *
 * Two conditions, and both are the caller's to keep:
 *
 *  - the branch's `ORDER BY` must be the merged one, on the branch's own
 *    columns — a branch capped in a different order caps the wrong rows;
 *  - every predicate that applies to the branch must be *inside* it. A filter
 *    left above the union is applied after the cap, so a page could come back
 *    short (or empty) while matching rows sit unread below the cap.
 */
export function mergeWindow(page: number, perPage: number): number {
  return offsetFor(page, perPage) + perPage;
}

// ── Keyset (cursor) pagination ──────────────────────────────────────────────

/**
 * Why a second pagination scheme exists next to the offset one above.
 *
 * OFFSET is right for a page-numbered UI: the client wants "page 7 of 40", and
 * a count it can render as forty tabs. It is wrong for a client walking a log
 * to the end, which is what an API client does, and wrong in two ways that both
 * show up as missing rows rather than as errors.
 *
 * **It skips and repeats under concurrent writes.** OFFSET counts rows at the
 * moment each query runs. A partner reading their delivery history newest-first
 * while deliveries are still being written gets the new rows pushed onto page 1
 * between requests, so every row already served shifts down by however many
 * arrived — and the row that shifted from the end of page 1 to the start of
 * page 2 is served twice, while the one that shifted off the end of page 2 is
 * never served at all. The client cannot detect this; it just ends up with a
 * gap in the audit trail it was reconciling against.
 *
 * **It gets slower the further it goes.** `OFFSET 50000` makes Postgres walk
 * and discard fifty thousand rows to return twenty-five. On a delivery log,
 * which is append-only and unbounded, the deep pages are exactly the ones an
 * incident review reads.
 *
 * A keyset cursor has neither property: it names the last row served, and the
 * next page is "rows after that one" — a range scan on the index that already
 * orders the table, and a predicate that does not care what was inserted
 * meanwhile. New rows land on page 1, where the client already looked, rather
 * than displacing rows it has not.
 */

/**
 * The position of one row in a `created_at DESC, id ASC` ordering.
 *
 * `at` is deliberately a *string* rather than a `Date`, and that is the whole
 * reason this type exists instead of the cursor carrying a timestamp the
 * obvious way.
 *
 * Postgres stores `timestamptz` to the microsecond. node-postgres parses one
 * into a JS `Date`, which holds milliseconds — so a row read into JS has
 * already lost the last three digits, and a cursor built from `row.created_at`
 * carries a truncated instant. Truncation rounds *down*, so the cursor names a
 * moment fractionally earlier than the row it came from, and the next page's
 * `created_at < $cursor` then excludes every row in the interval between them:
 * rows that were never served on the previous page and never will be. Three
 * digits is not a rounding error here — deliveries are written in bursts by the
 * same sweep, so rows sharing a millisecond are the normal case, not the
 * corner.
 *
 * So the timestamp never becomes a `Date`. The query renders it with
 * {@link CURSOR_AT_SQL} — microsecond-exact, and forced to UTC so the text does
 * not depend on the session's TimeZone — and it goes back to Postgres as text
 * for the cast to re-parse. Round-tripping through text is lossless in a way
 * round-tripping through JS is not.
 */
export interface Cursor {
  /** Microsecond-exact UTC rendering of the row's `created_at`. */
  at: string;
  /** The row's ULID, which breaks ties within one microsecond. */
  id: string;
}

/**
 * How a cursor's timestamp is rendered in SQL. Interpolate the column, e.g.
 * ``to_char(...)`` over `d.created_at`; the result is what {@link CURSOR_AT_RE}
 * accepts and what `$n::timestamptz` re-parses exactly.
 *
 * `AT TIME ZONE 'UTC'` rather than `::text` because `::text` renders in the
 * session's TimeZone — `-04` on a server set to America/New_York — which makes
 * the cursor's meaning depend on a session setting that no client can see and
 * that a failover or a pool reconnect may change underneath it.
 */
export function cursorAtSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** What {@link cursorAtSql} produces, and the only timestamp shape accepted. */
export const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Is this a shape *and* an instant?
 *
 * {@link CURSOR_AT_RE} is a shape check, and a shape check is not a calendar —
 * the same distinction `market_movement.py._period` and `routes/rollforward.ts`
 * make about `2026-02-31`, which "matches every plausible pattern and is not a
 * day". `\d{2}` for the month admits 13, and for the day 45.
 *
 * That was the whole of the re-validation `decodeCursor` promises, and it left
 * the failure that function exists to prevent wide open. It closes 22007
 * (`'garbage'::timestamptz`, invalid *syntax*) and not 22008 (value out of
 * range), which is what Postgres answers for a well-formed impossible date:
 * measured on the deployment's own server, `'2026-02-31T00:00:00.000000Z'`,
 * `'9999-13-45T25:61:61.999999Z'` and `'0000-00-00T00:00:00.000000Z'` all raise
 * `22008 date/time field value out of range` when bound to
 * `keysetAfterSql`'s `$n::timestamptz`. An uncaught driver error out of a
 * partner's `?cursor=` — a 500 where the 400 beside it belongs.
 *
 * Two checks, because neither is the other. The round trip through `Date`
 * refuses a date that is not a date: JavaScript rejects month 13 outright and
 * *normalises* 2026-02-31 to 2026-03-03, so re-rendering and comparing is what
 * catches the second kind. `isStorableDate` then applies the range the rest of
 * the estate uses — year 0000 is a real `Date` and is not a year Postgres has.
 *
 * Milliseconds are the resolution `Date` carries; the microsecond tail is left
 * to the regex, which has already established that it is six digits.
 */
function isRealCursorInstant(at: string): boolean {
  const millis = `${at.slice(0, 23)}Z`;
  const parsed = new Date(millis);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== millis) return false;
  return isStorableDate(parsed);
}

/** ULIDs as `0001_core.sql`'s domain defines them (Crockford base32, 26 chars). */
const CURSOR_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Cursors are base64url of `${at}.${id}`, which is opaque enough.
 *
 * Not encryption and not claimed to be: a client that base64-decodes one finds
 * a timestamp and a row id it was already shown in the page body. The encoding
 * buys the one thing that matters, which is that the cursor does not *look*
 * like two fields, so nobody builds one by hand and then depends on the shape
 * we would like to be free to change.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}.${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * A cursor, or `null` if it is not one we wrote.
 *
 * Every field is re-validated rather than trusted, because the alternative is a
 * 500. These values are interpolated as *parameters*, so there is no injection
 * to worry about — but `'garbage'::timestamptz` still raises 22007 inside the
 * driver, and an uncaught driver error on a query-string value is the same
 * unauthenticated error-shape oracle `pageParam`'s ceiling exists to close.
 * Returning `null` lets the route answer 400 naming the field.
 *
 * Non-base64 input is caught by re-encoding rather than by inspecting it:
 * `Buffer.from` is lenient — it skips characters outside the alphabet instead
 * of failing — so `decode(x)` succeeding proves nothing about `x`. Comparing
 * the round-trip is what actually rejects a mangled cursor, and a cursor
 * mangled in transit must fail rather than silently decode to a *different*
 * position and skip rows.
 */
export function decodeCursor(raw: string): Cursor | null {
  if (raw.length > 200) return null;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) return null;
  // The separator is `.`, which cannot occur in a ULID and occurs exactly once
  // in the timestamp — so split from the right rather than the left.
  const split = decoded.lastIndexOf('.');
  if (split < 0) return null;
  const at = decoded.slice(0, split);
  const id = decoded.slice(split + 1);
  if (!CURSOR_AT_RE.test(at) || !isRealCursorInstant(at) || !CURSOR_ID_RE.test(id)) return null;
  return { at, id };
}

/**
 * `cursor`, as a query-string field. Optional everywhere: the first page of a
 * cursor-paged list is the one requested without a cursor.
 */
export const cursorParam = () => z.string().min(1).max(200).optional();

/**
 * The keyset predicate for `created_at DESC, id ASC`, as a SQL fragment.
 *
 * The mixed direction is not an oversight — it is the ordering `orderBySql`
 * already produces, and the predicate has to match the ORDER BY exactly or it
 * excludes rows the ordering would have placed on a later page. So "strictly
 * after the cursor row" is: an older `created_at`, or the same `created_at`
 * with a *higher* id.
 *
 * `atParam`/`idParam` are `$n` placeholders the caller has already bound.
 */
export function keysetAfterSql(column: string, idColumn: string, atParam: string, idParam: string): string {
  return `(${column} < ${atParam}::timestamptz OR (${column} = ${atParam}::timestamptz AND ${idColumn} > ${idParam}))`;
}

/**
 * Splits an over-fetched result into a page and the cursor for the next one.
 *
 * The over-fetch is how `has_more` is answered without a second query: ask for
 * one more row than the page holds, and its presence *is* the answer. A count
 * would answer a different question — how many rows match — which on an
 * append-only log is both expensive and stale by the time it is read.
 *
 * `nextCursor` is null exactly when `hasMore` is false, so a client can loop on
 * either without them ever disagreeing.
 */
export function pageFrom<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => Cursor,
): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
    hasMore,
  };
}
