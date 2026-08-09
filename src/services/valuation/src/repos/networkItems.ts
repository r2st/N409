import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { boundedJson } from '../domain/boundedJson.js';
import { offsetFor } from '../domain/pagination.js';

/**
 * Outbound engine/AI calls per engagement (migration 0127, 409.ai §11).
 *
 * Diagnostic only: nothing here is read to produce a figure and no report cites
 * it, which is what lets these rows be pruned. `market_research` and
 * `qa_reviews` are append-only for the opposite reason — a report cites them.
 */

export interface NetworkItemRow {
  id: string;
  valuation_id: string;
  service: string;
  name: string;
  status: number | null;
  error: string | null;
  duration_ms: number;
  request_id: string | null;
  created_at: Date;
  /** Present only on the by-id fetch — see `LIST_COLUMNS`. */
  request?: unknown;
  response?: unknown;
}

/**
 * Every column except the two payloads.
 *
 * The payloads are the whole point of the table and also the whole weight of
 * it: one engine compute request is the entire cap table. A list of forty calls
 * that carried them would be megabytes to render a table of timestamps and
 * status codes, so the list omits both and the row is opened to see them.
 */
const LIST_COLUMNS = `id, valuation_id, service, name, status, error, duration_ms, request_id, created_at`;

export interface NetworkItemInput {
  valuationId: string;
  service: string;
  name: string;
  request: unknown;
  response: unknown;
  status: number | null;
  error: string | null;
  durationMs: number;
  requestId: string | null;
}

/**
 * How many calls are kept per engagement.
 *
 * Generous against real use — 409.ai's own example engagement showed 33 items
 * for a completed valuation, and a heavily reworked one makes a few hundred —
 * while still bounding a runaway retry loop to something a table can hold.
 */
export const KEEP_PER_VALUATION = 500;

/**
 * Record one call. Never throws.
 *
 * This runs on the success path *and* the failure path of every engine and AI
 * call, so an error raised here would turn a working calculation into a failed
 * one, and — worse — would turn an upstream outage that was about to be
 * reported accurately into a database error that names the wrong culprit. A
 * diagnostic write that cannot be made is a diagnostic that is missing, which
 * is the cost the caller should pay for it, and the only one.
 *
 * The caller is not awaited on the hot path (see `clients/internal.ts`), so the
 * returned promise is generally floating; it resolves to the row id, or null
 * when the write was dropped.
 */
export async function recordNetworkItem(
  pool: pg.Pool,
  input: NetworkItemInput,
  onError?: (err: unknown) => void,
): Promise<string | null> {
  try {
    const id = newUlid();
    await pool.query(
      `INSERT INTO network_items
         (id, valuation_id, service, name, request, response, status, error, duration_ms, request_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
      [
        id,
        input.valuationId,
        input.service,
        input.name,
        JSON.stringify(boundedJson(input.request)),
        JSON.stringify(boundedJson(input.response)),
        input.status,
        input.error,
        // An integer column: a sub-millisecond call is 0, not a rejected insert.
        Math.max(0, Math.round(input.durationMs)),
        input.requestId,
      ],
    );
    return id;
  } catch (err) {
    onError?.(err);
    return null;
  }
}

/**
 * Drop all but the newest `keep` rows for one engagement. Never throws, for the
 * same reason `recordNetworkItem` does not.
 *
 * Deliberately not a trigger and not a scheduled sweep over every engagement:
 * the only engagement whose count can have just crossed the bound is the one
 * that was just written to.
 *
 * Written as a cutoff rather than `id NOT IN (newest 500)`, which is the
 * obvious form and the wrong one — it materialises five hundred ids on every
 * call to normally delete nothing. The subquery here is a single index lookup
 * straight down `(valuation_id, created_at DESC)` to the boundary row, and
 * yields NULL when the engagement has fewer rows than the bound, so
 * `created_at < NULL` matches nothing and the common case is a no-op.
 *
 * Rows tying the boundary timestamp exactly are kept, so this can leave
 * slightly more than `keep`. That is the safe direction for a bound whose only
 * job is to stop unbounded growth.
 */
export async function pruneNetworkItems(
  pool: pg.Pool,
  valuationId: string,
  keep: number = KEEP_PER_VALUATION,
  onError?: (err: unknown) => void,
): Promise<number> {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM network_items
        WHERE valuation_id = $1
          AND created_at < (
            SELECT created_at FROM network_items
             WHERE valuation_id = $1
             ORDER BY created_at DESC
             OFFSET $2 LIMIT 1
          )`,
      [valuationId, keep],
    );
    return rowCount ?? 0;
  } catch (err) {
    onError?.(err);
    return 0;
  }
}

export interface NetworkItemPage {
  items: NetworkItemRow[];
  /** Rows matching the filter, across all pages — see `countNetworkItemsByService`. */
  total: number;
  page: number;
  per_page: number;
  /** Rows per tier, unfiltered, for the tab strip. */
  counts: Record<string, number>;
}

/**
 * Per-tier counts for one engagement.
 *
 * Unfiltered by design: the tab strip has to show what the tabs the reader is
 * *not* on contain, so a count taken from the filtered query would read zero
 * for every other tier.
 */
export async function countNetworkItemsByService(
  pool: pg.Pool,
  valuationId: string,
): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ service: string; count: string }>(
    `SELECT service, count(*)::text AS count
       FROM network_items WHERE valuation_id = $1 GROUP BY service ORDER BY service`,
    [valuationId],
  );
  return Object.fromEntries(rows.map((r) => [r.service, Number(r.count)]));
}

/**
 * One engagement's calls, newest first, optionally one tier only.
 *
 * `total` comes from the per-tier counts rather than a `count(*) OVER ()` on
 * the page. The window function is the reflex here and it is wrong at the edge:
 * it rides on the returned rows, so a page past the end returns none and the
 * total reads zero — telling a reader who paged one step too far that the log
 * is empty. The GROUP BY is a query this route already needs for its tabs, and
 * it is right regardless of which page was asked for.
 */
export async function listNetworkItems(
  pool: pg.Pool,
  valuationId: string,
  opts: { service?: string; page?: number; perPage?: number } = {},
): Promise<NetworkItemPage> {
  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 50;
  const [{ rows }, counts] = await Promise.all([
    pool.query<NetworkItemRow>(
      `SELECT ${LIST_COLUMNS}
         FROM network_items
        WHERE valuation_id = $1
          AND ($2::text IS NULL OR service = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4`,
      [valuationId, opts.service ?? null, perPage, offsetFor(page, perPage)],
    ),
    countNetworkItemsByService(pool, valuationId),
  ]);
  const total = opts.service
    ? (counts[opts.service] ?? 0)
    : Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { items: rows, total, page, per_page: perPage, counts };
}

/**
 * One call with both payloads.
 *
 * Scoped by valuation as well as by id, so an id from one engagement cannot be
 * used to read another's payloads. The id is unguessable, but "unguessable" is
 * not an access rule — the same reasoning as `findCalculationWithTrace`.
 */
export async function findNetworkItem(
  pool: pg.Pool,
  valuationId: string,
  id: string,
): Promise<NetworkItemRow | null> {
  const { rows } = await pool.query<NetworkItemRow>(
    'SELECT * FROM network_items WHERE id = $1 AND valuation_id = $2',
    [id, valuationId],
  );
  return rows[0] ?? null;
}
