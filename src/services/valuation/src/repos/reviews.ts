import type pg from 'pg';
import { STATE_GROUPS } from '../domain/operations.js';
import type { ValuationRow } from './valuations.js';

/**
 * P1 #6 — the reviewer's queue: valuations sitting in a review state, with
 * signature rollups so the UI can flag what is still blocked from publish.
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
  const where: string[] = ['v.state = ANY($1)'];
  const params: unknown[] = [[...STATE_GROUPS.in_review]];
  if (filters.reviewerId) {
    params.push(filters.reviewerId);
    where.push(`v.assigned_reviewer_id = $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM valuations v ${whereSql}`,
    params,
  );

  const paged = [...params, filters.perPage, (filters.page - 1) * filters.perPage];
  const { rows } = await pool.query<ReviewQueueRow>(
    `SELECT v.*,
            EXISTS (SELECT 1 FROM valuation_signatures s
                    WHERE s.valuation_id = v.id AND s.role = 'main') AS signed_main,
            EXISTS (SELECT 1 FROM valuation_signatures s
                    WHERE s.valuation_id = v.id AND s.role = 'second') AS signed_second
     FROM valuations v
     ${whereSql}
     ORDER BY v.updated_at ASC
     LIMIT $${paged.length - 1} OFFSET $${paged.length}`,
    paged,
  );
  return { items: rows, total: Number(countRows[0]!.count) };
}
