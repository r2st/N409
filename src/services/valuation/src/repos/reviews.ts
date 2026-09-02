import type pg from 'pg';
import { STATE_GROUPS } from '../domain/operations.js';
import type { ValuationRow } from './valuations.js';

/**
 * P1 #6 — the reviewer's queue: valuations sitting in a review state, with
 * signature rollups so the UI can flag what is still blocked from publish.
 *
 * Archived engagements are excluded, as they are from the engagement list
 * (`buildValuationWhere`, repos/valuations.ts). A queue is a list of work to
 * do: leaving retired engagements in it hands a reviewer something to sign off
 * that has already been withdrawn, and the queue depth every other surface
 * reports would not match the one they are looking at.
 */

export interface ReviewQueueRow extends ValuationRow {
  signed_main: boolean;
  signed_second: boolean;
}

export interface ReviewQueueFilters {
  /** Only valuations assigned to this reviewer. */
  reviewerId?: string;
  page: number;
  perPage: number;
}

export async function listReviewQueue(
  pool: pg.Pool,
  filters: ReviewQueueFilters,
): Promise<{ items: ReviewQueueRow[]; total: number }> {
  const where: string[] = ['v.archived_at IS NULL', 'v.state = ANY($1::valuation_state[])'];
  const params: unknown[] = [[...STATE_GROUPS.in_review]];
  if (filters.reviewerId) {
    params.push(filters.reviewerId);
    where.push(`v.assigned_reviewer_id = $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  /*
   * Asked together, not one after the other (R351, M8 — R338's shape). Neither
   * statement reads anything the other produces, which is why `paged` exists as
   * a separate parameter list, and awaiting them in sequence cost the reviewer
   * queue the sum of two round trips rather than the slower of them.
   */
  const counting = pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM valuations v ${whereSql}`,
    params,
  );

  const paged = [...params, filters.perPage, (filters.page - 1) * filters.perPage];
  const [{ rows: countRows }, { rows }] = await Promise.all([
    counting,
    pool.query<ReviewQueueRow>(
      `SELECT v.*,
            EXISTS (SELECT 1 FROM valuation_signatures s
                    WHERE s.valuation_id = v.id AND s.role = 'main') AS signed_main,
            EXISTS (SELECT 1 FROM valuation_signatures s
                    WHERE s.valuation_id = v.id AND s.role = 'second') AS signed_second
     FROM valuations v
     ${whereSql}
     ORDER BY v.created_at ASC, v.id ASC
     LIMIT $${paged.length - 1} OFFSET $${paged.length}`,
      paged,
    ),
  ]);
  return { items: rows, total: Number(countRows[0]!.count) };
}
