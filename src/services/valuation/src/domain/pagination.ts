import { z } from 'zod';

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
