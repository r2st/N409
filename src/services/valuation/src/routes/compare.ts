import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { latestSucceededCalculation, type CalculationRow } from '../repos/calculations.js';
import {
  changedRows,
  comparableKinds,
  compareValuations,
  comparisonCsv,
  headlineSummary,
  type CompareSide,
} from '../domain/valuationCompare.js';
import { KIND_LABELS } from '../domain/valuationSelector.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Valuation comparison (GET /api/v1/valuations/compare?a=…&b=…).
 *
 * Both sides are authorised independently and to the same standard as reading
 * either valuation on its own: a caller who cannot see B cannot learn B's
 * numbers by putting it next to one they can see. A missing or unreadable id
 * is a 404 either way, so the endpoint never distinguishes "no such valuation"
 * from "not yours".
 *
 * Each side contributes its newest *successful* calculation. A valuation that
 * has never computed is still a legitimate side — it renders with empty
 * values rather than failing the request, because "the new one hasn't run yet"
 * is a normal state for the comparison a user wants to make.
 */

const Query = z.object({
  a: z.string(),
  b: z.string(),
  /** `csv` downloads the same comparison for the board pack's spreadsheet. */
  format: z.enum(['json', 'csv']).default('json'),
});

function sideFor(valuation: ValuationRow, calculation: CalculationRow | null): CompareSide {
  const payload = calculation?.inputs as { inputs?: { valuation_date?: unknown } } | undefined;
  const rawDate = payload?.inputs?.valuation_date;
  return {
    valuation_id: valuation.id,
    company_name: valuation.company_name,
    kind: valuation.kind,
    currency: valuation.currency,
    state: valuation.state,
    calculation_id: calculation?.id ?? null,
    engine_version: calculation?.engine_version ?? null,
    calculated_at: calculation ? new Date(calculation.created_at).toISOString() : null,
    valuation_date: typeof rawDate === 'string' ? rawDate.slice(0, 10) : null,
    results: calculation?.results ?? null,
  };
}

/** The product's own name for a kind, so the refusal reads as the picker does. */
function kindLabel(kind: string): string {
  return KIND_LABELS.find(([k]) => k === kind)?.[1] ?? kind;
}

export function registerCompareRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const load = async (principal: Principal, id: string): Promise<ValuationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    return valuation;
  };

  app.get('/api/v1/valuations/compare', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const query = Query.safeParse(req.query);
    if (!query.success) {
      throw problems.badRequest('Pass two valuation ids as ?a=…&b=…');
    }
    if (query.data.a === query.data.b) {
      throw problems.badRequest('Choose two different valuations to compare');
    }

    const [left, right] = await Promise.all([load(principal, query.data.a), load(principal, query.data.b)]);

    // Mixed currencies would put two different units in one delta column, and
    // a signed number under the wrong symbol is worse than no number at all.
    if (left.currency !== right.currency) {
      throw problems.unprocessable(
        `These valuations are denominated differently (${left.currency} and ${right.currency}) and cannot be compared side by side`,
      );
    }

    // The same judgement one step further out. Each specialty engine writes its
    // own result vocabulary (routes/specialty.ts persists it under
    // `results.specialty`), so an EMI run and an IFRS 2 run share no metric at
    // all — every row would be a figure against a dash, under a "Change"
    // column that means "different product", not "the number moved".
    if (!comparableKinds(left.kind, right.kind)) {
      throw problems.unprocessable(
        `A ${kindLabel(left.kind)} and a ${kindLabel(right.kind)} valuation measure different things and cannot be compared side by side`,
      );
    }

    const [calcA, calcB] = await Promise.all([
      latestSucceededCalculation(deps.pool, left.id),
      latestSucceededCalculation(deps.pool, right.id),
    ]);

    const a = sideFor(left, calcA);
    const b = sideFor(right, calcB);
    const groups = compareValuations(a, b);

    if (query.data.format === 'csv') {
      // Named from the two engagements rather than a timestamp: this file ends
      // up attached to a board pack, and "compare-2026-08-10.csv" tells the
      // person who opens it in six months nothing about what is being compared.
      const slug = (value: string) =>
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'valuation';
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="compare-${slug(a.company_name)}-vs-${slug(b.company_name)}.csv"`,
        )
        .send(comparisonCsv(a, b, groups));
    }

    return {
      a,
      b,
      groups,
      /*
       * How many metrics the comparison could read at all — not how many
       * moved. Zero is "there was nothing here to compare" (neither side has
       * computed, or both reported a shape this view does not read), which the
       * view has to say instead of "nothing differs": a comparator that found
       * no metrics has not established that the two agree.
       */
      metric_count: groups.reduce((n, g) => n + g.rows.length, 0),
      changed_count: changedRows(groups).length,
      summary: headlineSummary(groups),
    };
  });
}
