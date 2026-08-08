import type pg from 'pg';

/**
 * Read-only remediation queries (design §7.4, REVISION `gap:` lines).
 *
 * Two stored-data defects that correct themselves for anything re-run and do
 * not correct themselves for anything already published. Both want the same
 * treatment and neither wants a migration:
 *
 *   * **Stale backsolve.** `99383b2` changed what the single-breakpoint
 *     backsolve computes. Every calculation stored before it that took that
 *     path with a non-zero option pool holds an equity value low by roughly the
 *     pool's share, and any report rendered from one still says so.
 *
 *   * **Stale QA review.** Reviews recorded before `9ed0aa6` graded the DLOM
 *     *parameter* rather than the figure the engine applied, so a stored
 *     `dlom_range` check on a Chaffee/Finnerty run is either absent or about
 *     the wrong number — and that check is a publish gate.
 *
 * A list first, deliberately. A published opinion is a signed document that a
 * client has acted on; silently rewriting the figure inside it is not a bug fix,
 * it is a different opinion issued under the same cover. So these queries
 * answer "which ones, and can they be re-run" and stop there — the bulk re-run
 * the route offers is confined to engagements that have not published, and a
 * published one gets a flag and a decision recorded by a human.
 */

export interface StaleBacksolveRow {
  calculation_id: string;
  valuation_id: string;
  valuation_number: number;
  company_name: string;
  state: string;
  /** Equity value as stored — the figure that is low by roughly the pool share. */
  equity_value: string | null;
  fmv_per_share: string | null;
  options_outstanding: number | null;
  calculated_at: Date;
  /** Whether a report was rendered from this engagement at all. */
  has_rendered_report: boolean;
  /** Published opinions are never re-run automatically. */
  published: boolean;
}

/**
 * Calculations that took the single-breakpoint backsolve with a live option
 * pool.
 *
 * `results.approaches.opm_backsolve.method` and `inputs.inputs.options_outstanding`
 * are the two facts that identify the defect — the engine records which branch
 * it took, which is what makes this answerable at all rather than a guess from
 * a date.
 *
 * Latest-per-valuation only: an engagement whose newest run is clean has
 * already been fixed by a re-run, and listing its history would fill the queue
 * with rows nobody needs to act on.
 */
export async function listStaleBacksolves(pool: pg.Pool): Promise<StaleBacksolveRow[]> {
  const { rows } = await pool.query<StaleBacksolveRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (c.valuation_id) c.*
         FROM calculations c
        WHERE c.status = 'succeeded'
        ORDER BY c.valuation_id, c.created_at DESC
     )
     SELECT l.id            AS calculation_id,
            l.valuation_id,
            v.number        AS valuation_number,
            v.company_name,
            v.state::text   AS state,
            l.equity_value::text,
            l.fmv_per_share::text,
            NULLIF(l.inputs->'inputs'->>'options_outstanding', '')::numeric::int
                            AS options_outstanding,
            l.created_at    AS calculated_at,
            EXISTS (
              SELECT 1 FROM reports r
               JOIN report_versions rv ON rv.report_id = r.id
               WHERE r.valuation_id = l.valuation_id AND rv.pdf IS NOT NULL
            )               AS has_rendered_report,
            (v.state = 'published') AS published
       FROM latest l
       JOIN valuations v ON v.id = l.valuation_id
      WHERE l.results->'approaches'->'opm_backsolve'->>'method' = 'backsolve_single'
        AND COALESCE(NULLIF(l.inputs->'inputs'->>'options_outstanding', '')::numeric, 0) > 0
      ORDER BY (v.state = 'published') DESC, l.created_at ASC`,
  );
  return rows;
}

export interface StaleQaReviewRow {
  review_id: string;
  valuation_id: string;
  valuation_number: number;
  company_name: string;
  state: string;
  calculation_id: string;
  /** The DLOM method the run used — chaffee or finnerty. */
  dlom_method: string | null;
  /** The discount the engine applied, which the review should have graded. */
  applied_dlom: string | null;
  review_status: string;
  reviewed_at: Date;
  /** Whether the review recorded a dlom_range check at all. */
  has_dlom_check: boolean;
  published: boolean;
}

/**
 * QA reviews of a model-DLOM run whose `dlom_range` check is missing.
 *
 * Only the missing case is listed, not the "disagrees with the applied figure"
 * case. A stored check carries its rendered *detail* string rather than the
 * number it graded, so recovering what a review compared against would mean
 * parsing prose — and a remediation queue built on a regex over a sentence is a
 * queue that quietly changes size when someone rewords the sentence. Absent is
 * unambiguous, and it is the shape that actually published unexamined: with
 * `params.dlom` null (the normal shape for a model DLOM) the old check did not
 * run at all.
 */
export async function listStaleQaReviews(pool: pg.Pool): Promise<StaleQaReviewRow[]> {
  const { rows } = await pool.query<StaleQaReviewRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (q.valuation_id) q.*
         FROM qa_reviews q
        ORDER BY q.valuation_id, q.created_at DESC
     )
     SELECT l.id             AS review_id,
            l.valuation_id,
            v.number         AS valuation_number,
            v.company_name,
            v.state::text    AS state,
            l.calculation_id,
            c.results->'discounts'->>'dlom_method' AS dlom_method,
            c.results->'discounts'->>'dlom'        AS applied_dlom,
            l.status         AS review_status,
            l.created_at     AS reviewed_at,
            EXISTS (
              SELECT 1 FROM jsonb_array_elements(l.checks) chk
               WHERE chk->>'key' = 'dlom_range'
            )                AS has_dlom_check,
            (v.state = 'published') AS published
       FROM latest l
       JOIN calculations c ON c.id = l.calculation_id
       JOIN valuations v   ON v.id = l.valuation_id
      WHERE c.results->'discounts'->>'dlom_method' IN ('chaffee', 'finnerty')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(l.checks) chk
           WHERE chk->>'key' = 'dlom_range'
        )
      ORDER BY (v.state = 'published') DESC, l.created_at ASC`,
  );
  return rows;
}
