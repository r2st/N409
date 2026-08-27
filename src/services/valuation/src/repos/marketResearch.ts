import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { withTransaction } from '../db/pool.js';
import type { ResearchRegion, ResearchTopic } from '../domain/research.js';

/**
 * Stored web-grounded research (migration 0116).
 *
 * Append-only. A re-run of the same (valuation, topic, region) stamps
 * `superseded_at` on the prior row and inserts a new one — it never updates in
 * place. A report cites the research it was drafted from, and rewriting the
 * answer under a citation that stays behind makes the citation a lie. The same
 * reasoning `qa_reviews` is append-only for.
 */

export interface MarketResearchRow {
  id: string;
  valuation_id: string;
  topic: string;
  region: string | null;
  question: string;
  answer: string;
  citations: Array<{ url: string; title?: string; date?: string }>;
  /**
   * False when the sources are real and `answer` is a placeholder note —
   * retrieval succeeded, the synthesis model did not (migration 0125).
   *
   * Report gates must check this as well as `citations.length`: such a row has
   * citations and no answer, which is the shape the old implicit rule read as
   * quotable.
   */
  synthesized: boolean;
  model: string;
  requested_by: string | null;
  created_at: Date;
  superseded_at: Date | null;
}

/** The live set for one engagement, newest topic first. */
/**
 * Ceiling on one page of the research log.
 *
 * The default branch is bounded without this: a live row is superseded by the
 * next run for the same (topic, region), and both are enums, so at most one
 * row per pair survives. `includeSuperseded` is the branch that needs the cap
 * — that is the whole history, one row per re-run, on a table nothing prunes,
 * and it is what the evidence bundle asks for. Newest first, so the page that
 * survives is the research the conclusion was actually drawn from.
 */
export const RESEARCH_PAGE_LIMIT = 500;

export async function listMarketResearch(
  pool: pg.Pool | pg.PoolClient,
  valuationId: string,
  opts: { includeSuperseded?: boolean } = {},
): Promise<{ research: MarketResearchRow[]; truncated: boolean }> {
  const { rows } = await pool.query<MarketResearchRow>(
    `SELECT * FROM market_research
      WHERE valuation_id = $1
        AND ($2::boolean OR superseded_at IS NULL)
      ORDER BY created_at DESC
      LIMIT $3`,
    [valuationId, opts.includeSuperseded ?? false, RESEARCH_PAGE_LIMIT + 1],
  );
  return {
    research: rows.slice(0, RESEARCH_PAGE_LIMIT),
    truncated: rows.length > RESEARCH_PAGE_LIMIT,
  };
}

export interface MarketResearchInput {
  valuationId: string;
  topic: ResearchTopic;
  region: ResearchRegion | null;
  question: string;
  answer: string;
  citations: unknown;
  /** Defaults to true — see `MarketResearchRow.synthesized`. */
  synthesized?: boolean;
  model: string;
  requestedBy: string | null;
}

/**
 * Supersede the prior live row for this (valuation, topic, region) and insert
 * the new one, in one transaction.
 *
 * Both halves or neither: superseding without inserting leaves the engagement
 * with no research where it had some, and inserting without superseding leaves
 * two live rows for one topic and no way for a reader to tell which the report
 * was drafted from.
 *
 * `region IS NOT DISTINCT FROM` rather than `=`: every non-region-scoped topic
 * stores NULL there, and `NULL = NULL` would supersede nothing, so each re-run
 * of the industry overview would have quietly stacked another live row.
 */
export async function recordMarketResearch(
  pool: pg.Pool,
  input: MarketResearchInput,
): Promise<MarketResearchRow> {
  return withTransaction(pool, async (tx) => {
    await tx.query(
      `UPDATE market_research SET superseded_at = now()
        WHERE valuation_id = $1 AND topic = $2
          AND region IS NOT DISTINCT FROM $3
          AND superseded_at IS NULL`,
      [input.valuationId, input.topic, input.region],
    );
    const { rows } = await tx.query<MarketResearchRow>(
      `INSERT INTO market_research
         (id, valuation_id, topic, region, question, answer, citations, synthesized, model, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING *`,
      [
        newUlid(),
        input.valuationId,
        input.topic,
        input.region,
        input.question,
        input.answer,
        JSON.stringify(Array.isArray(input.citations) ? input.citations : []),
        // `!== false` rather than `?? true`: an undefined from a caller that
        // predates the field means a synthesised answer, and so does an
        // explicit true. Only an explicit false is the degraded row.
        input.synthesized !== false,
        input.model,
        input.requestedBy,
      ],
    );
    return rows[0]!;
  });
}
