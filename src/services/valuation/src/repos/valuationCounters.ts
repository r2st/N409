import type pg from 'pg';
import {
  calculationCoverage,
  type ApproachWeights,
  type ValuationCounters,
} from '../domain/valuationCounters.js';

/**
 * The workspace header counters, in one round trip (design §4.6, §7.3).
 *
 * One query rather than five. The header renders on every page load of every
 * engagement, and five sequential counts on the hottest read path in the
 * product is five times the latency for a chip row. Each scalar subquery is
 * index-served: `documents_pending_review_idx` (0121),
 * `review_tasks_valuation_idx` (0003), `valuation_comments_valuation_idx`
 * (0020).
 *
 * The comment count is scoped to the caller in SQL rather than filtered after,
 * for the reason the inbox repo gives: unread is a property of the reader, and
 * "how many since I last looked" cannot be answered from the thread alone.
 */
export async function loadValuationCounters(
  pool: pg.Pool,
  valuationId: string,
  readerId: string,
  visibleKinds: readonly string[],
): Promise<ValuationCounters> {
  const { rows } = await pool.query<{
    pending_files: string;
    my_tasks: string;
    all_tasks: string;
    unread_comments: string;
    weight_asset: string | null;
    weight_opm: string | null;
    weight_income: string | null;
    weight_market: string | null;
    results: unknown;
  }>(
    `SELECT
       (SELECT count(*) FROM documents d
         WHERE d.valuation_id = $1 AND d.deleted_at IS NULL AND d.reviewed_at IS NULL)::text
         AS pending_files,
       (SELECT count(*) FROM review_tasks t
         WHERE t.valuation_id = $1 AND t.status = 'open' AND t.assignee_id = $2)::text
         AS my_tasks,
       (SELECT count(*) FROM review_tasks t
         WHERE t.valuation_id = $1 AND t.status = 'open')::text
         AS all_tasks,
       -- Comments the reader has not seen. No read row means they have never
       -- opened the thread, so everything on it is unread — COALESCE to epoch
       -- rather than to now(), which would report a busy thread as empty.
       (SELECT count(*) FROM valuation_comments c
         WHERE c.valuation_id = $1
           AND c.kind = ANY($3::comment_kind[])
           AND c.created_at > COALESCE(
                 (SELECT r.last_read_at FROM valuation_comment_reads r
                   WHERE r.valuation_id = $1 AND r.user_id = $2),
                 'epoch'::timestamptz))::text
         AS unread_comments,
       p.weight_asset, p.weight_opm, p.weight_income, p.weight_market,
       -- The latest *successful* run: a failed one has no approaches to count,
       -- and reading it would drop the badge to 0/4 on an engagement whose
       -- last good calculation is still the one on screen.
       (SELECT c.results FROM calculations c
         WHERE c.valuation_id = $1 AND c.status = 'succeeded'
         ORDER BY c.created_at DESC LIMIT 1) AS results
     FROM (SELECT 1) AS one
     LEFT JOIN valuation_params p ON p.valuation_id = $1`,
    [valuationId, readerId, visibleKinds],
  );

  const row = rows[0]!;
  const weights: ApproachWeights | null =
    row.weight_asset === null &&
    row.weight_opm === null &&
    row.weight_income === null &&
    row.weight_market === null
      ? null
      : {
          weight_asset: row.weight_asset,
          weight_opm: row.weight_opm,
          weight_income: row.weight_income,
          weight_market: row.weight_market,
        };

  return {
    pending_files: Number(row.pending_files),
    my_tasks: Number(row.my_tasks),
    all_tasks: Number(row.all_tasks),
    unread_comments: Number(row.unread_comments),
    calculations: calculationCoverage(weights, row.results),
  };
}
