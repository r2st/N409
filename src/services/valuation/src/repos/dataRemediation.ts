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

/**
 * Ceiling on one page of either queue.
 *
 * Both queries are latest-per-valuation scans of `calculations` / `qa_reviews`
 * across the whole platform, so their cost and their result grow with every
 * engagement ever run. The queue is worked through a page at a time regardless;
 * what a cap must not do is change the *answer* to "how many are affected",
 * which is why the totals below are counted in SQL over the whole match rather
 * than in JavaScript over the page.
 */
export const REMEDIATION_PAGE_LIMIT = 500;

/**
 * The soft delete, applied to both queues and to the re-run guard between them.
 *
 * These are work queues — lists of engagements with a "re-run" button beside
 * them — and archiving is how an engagement stops being work. `archived_at` is
 * what `retireValuations` and the retention sweep stamp, and
 * `buildValuationWhere` keeps it out of the list, the counts and the export; a
 * query that builds its own WHERE inherits none of that.
 *
 * It matters twice here. The queue offered an operator a re-run of an
 * engagement the firm had withdrawn, which the guard below would then have
 * carried out — writing a fresh calculation onto retired work. And the totals
 * beside it are counted with `count(*) OVER ()`, so the "how many are affected"
 * figure this file goes out of its way to keep exact was overstated by every
 * retired engagement that ever took the stale path.
 *
 * `state <> 'published'` on the guard is the neighbouring rule and stays: one
 * is "we must not silently reissue a signed opinion", this is "there is nothing
 * here to reissue".
 */
const NOT_ARCHIVED = 'v.archived_at IS NULL';

/**
 * Totals over the entire match, not the returned page.
 *
 * `count(*) OVER ()` is evaluated before `LIMIT`, so these stay correct however
 * short the page is. They are attached to every row and read off the first.
 */
interface QueueTotals {
  total_matched: string;
  published_matched: string;
}

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

/** A page of a remediation queue, with the totals the page was cut from. */
export interface RemediationQueue<T> {
  rows: T[];
  /** Every row matching the defect, not just the ones returned. */
  total: number;
  /** How many of those are published — the ones needing a human decision. */
  published: number;
  truncated: boolean;
}

function readTotals<T>(
  rows: Array<T & QueueTotals>,
  limit: number,
): RemediationQueue<Omit<T, keyof QueueTotals>> {
  const head = rows[0];
  const total = head ? Number(head.total_matched) : 0;
  const published = head ? Number(head.published_matched) : 0;
  const page = rows.slice(0, limit).map((r) => {
    const { total_matched: _t, published_matched: _p, ...rest } = r;
    return rest as Omit<T, keyof QueueTotals>;
  });
  return { rows: page, total, published, truncated: total > page.length };
}

function pageLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? REMEDIATION_PAGE_LIMIT, 1), REMEDIATION_PAGE_LIMIT);
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
 *
 * A page, because the scan is over every succeeded calculation on the platform.
 * Published rows are still ordered first — they are the ones needing a human
 * decision — which means a capped page can consist entirely of rows the bulk
 * re-run refuses. That is why the re-run path resolves eligibility with
 * {@link findRerunnableBacksolves} against the ids it was actually given rather
 * than by searching this page.
 */
export async function listStaleBacksolves(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<RemediationQueue<StaleBacksolveRow>> {
  const limit = pageLimit(opts.limit);
  const { rows } = await pool.query<StaleBacksolveRow & QueueTotals>(
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
            (v.state = 'published') AS published,
            count(*) OVER ()::text AS total_matched,
            count(*) FILTER (WHERE v.state = 'published') OVER ()::text AS published_matched
       FROM latest l
       JOIN valuations v ON v.id = l.valuation_id
      WHERE ${NOT_ARCHIVED}
        AND l.results->'approaches'->'opm_backsolve'->>'method' = 'backsolve_single'
        AND COALESCE(NULLIF(l.inputs->'inputs'->>'options_outstanding', '')::numeric, 0) > 0
      ORDER BY (v.state = 'published') DESC, l.created_at ASC
      LIMIT $1`,
    [limit],
  );
  return readTotals(rows, limit);
}

/**
 * The subset of `valuationIds` that is genuinely re-runnable right now.
 *
 * The same predicate as the queue, narrowed to the ids asked for and to
 * unpublished engagements. Scoping the check to the request rather than
 * intersecting it with a page of the queue is what keeps the re-run correct
 * under a cap: a row sitting at position 900 of the list is still re-runnable,
 * and an operator who reached it by any route must not be told it does not
 * exist. It is also the cheaper read — bounded by the ids given, not by the
 * platform's history.
 */
export async function findRerunnableBacksolves(
  pool: pg.Pool,
  valuationIds: readonly string[],
): Promise<Set<string>> {
  if (valuationIds.length === 0) return new Set();
  const { rows } = await pool.query<{ valuation_id: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (c.valuation_id) c.*
         FROM calculations c
        WHERE c.status = 'succeeded' AND c.valuation_id = ANY($1::text[])
        ORDER BY c.valuation_id, c.created_at DESC
     )
     SELECT l.valuation_id
       FROM latest l
       JOIN valuations v ON v.id = l.valuation_id
      WHERE ${NOT_ARCHIVED}
        AND l.results->'approaches'->'opm_backsolve'->>'method' = 'backsolve_single'
        AND COALESCE(NULLIF(l.inputs->'inputs'->>'options_outstanding', '')::numeric, 0) > 0
        AND v.state <> 'published'`,
    [valuationIds as readonly string[]],
  );
  return new Set(rows.map((r) => r.valuation_id));
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
 *
 * A page, on the same terms as the backsolve queue: the scan is over every QA
 * review on the platform, and the totals are counted in SQL so the cap bounds
 * the read without bounding the answer.
 */
export async function listStaleQaReviews(
  pool: pg.Pool,
  opts: { limit?: number } = {},
): Promise<RemediationQueue<StaleQaReviewRow>> {
  const limit = pageLimit(opts.limit);
  const { rows } = await pool.query<StaleQaReviewRow & QueueTotals>(
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
            (v.state = 'published') AS published,
            count(*) OVER ()::text AS total_matched,
            count(*) FILTER (WHERE v.state = 'published') OVER ()::text AS published_matched
       FROM latest l
       JOIN calculations c ON c.id = l.calculation_id
       JOIN valuations v   ON v.id = l.valuation_id
      WHERE ${NOT_ARCHIVED}
        AND c.results->'discounts'->>'dlom_method' IN ('chaffee', 'finnerty')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(l.checks) chk
           WHERE chk->>'key' = 'dlom_range'
        )
      ORDER BY (v.state = 'published') DESC, l.created_at ASC
      LIMIT $1`,
    [limit],
  );
  return readTotals(rows, limit);
}
