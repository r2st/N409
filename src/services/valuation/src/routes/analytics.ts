import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { analyticsResultsSql, buildAnalytics, type CalcInput } from '../domain/valuationAnalytics.js';
import { ENGINE_409A_KINDS, sameCompanyFilter } from '../domain/valuationHistory.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Valuation analytics (feature 5): GET /valuations/:id/analytics returns the
 * FMV / DLOM / volatility / revenue-multiple time series across every
 * valuation of the same company (latest successful calculation of each), plus
 * a comparable-multiple benchmark drawn from the most recent calculation.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const load = async (principal: Principal, id: string) => {
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

  app.get('/api/v1/valuations/:id/analytics', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await load(principal, id);

    // Latest successful calculation of each same-company valuation, chronological.
    // `sameCompanyFilter` is shared with the report's trend chart: the two are
    // the same question, and answering it twice is how they came to disagree
    // with the firm console about which engagements belong to one client.
    //
    // Restricted to the kinds whose `results` this endpoint can actually read
    // (`ENGINE_409A_KINDS`). Every figure below is a 409A key and a specialty
    // run has none of them, so one would arrive as an all-null point — and, if
    // it were the newest, as the row the whole benchmark block is computed
    // from, emptying the comparable set of a 409A that has one.
    //
    // Dated and ordered by each run's **measurement date**, the same correction
    // the report's trend chart takes: `created_at` is when the arithmetic was
    // last redone, and a recalculated engagement moves under it. Order is the
    // half with teeth here — `buildAnalytics` reads `first` and `last` off the
    // ends of this list for every trend, and takes the benchmark block from the
    // final row alone, so a prior year recalculated after this one's run became
    // "the latest" and the FMV trend it reported ran backwards.
    const scope = sameCompanyFilter(valuation);
    const { rows } = await deps.pool.query<{
      calculation_id: string;
      valuation_id: string;
      number: string;
      as_of: string;
      results: Record<string, unknown>;
    }>(
      /*
       * The narrowing is `analyticsResultsSql`, and the whole reason it is a
       * jsonb projection rather than a column list is that `buildAnalytics`
       * below is untouched by it (R393, M8). It reads five scalars and the
       * comparable-multiple list; this used to hand it the engine's entire
       * result document, allocation and breakpoints included, once per prior
       * valuation of the company and with no ceiling on how many that is.
       *
       * The narrowing moved inside the LATERAL with `as_of`, so the discarded
       * bytes are dropped where the row is chosen rather than carried up to
       * the outer projection. `inputs` stays in there because `as_of` is
       * extracted from it — in SQL, as before — and never leaves.
       */
      `SELECT c.calculation_id, c.valuation_id, v.number, c.as_of, c.results
         FROM valuations v
         JOIN LATERAL (
           SELECT r.id AS calculation_id, r.valuation_id, r.created_at,
                  COALESCE(
                    NULLIF(substring(r.inputs->>'valuation_date' from '^\\d{4}-\\d{2}-\\d{2}'), ''),
                    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
                  ) AS as_of,
                  ${analyticsResultsSql('r')} AS results
             FROM calculations r
            WHERE r.valuation_id = v.id AND r.status = 'succeeded' AND r.results IS NOT NULL
            ORDER BY r.created_at DESC
            LIMIT 1
         ) c ON true
        WHERE ${scope.clause}
          AND v.kind = ANY($3)
        ORDER BY c.as_of ASC, c.created_at ASC`,
      [...scope.params, ENGINE_409A_KINDS],
    );

    const calcs: CalcInput[] = rows.map((r) => ({
      calculation_id: r.calculation_id,
      valuation_id: r.valuation_id,
      as_of: r.as_of,
      results: r.results,
    }));

    const analytics = buildAnalytics(calcs);
    // Attach valuation numbers to each point for chart labels.
    const numberByValuation = new Map(rows.map((r) => [r.valuation_id, r.number]));
    return {
      company_name: valuation.company_name,
      analytics: {
        ...analytics,
        series: analytics.series.map((p) => ({
          ...p,
          valuation_number: numberByValuation.get(p.valuation_id) ?? null,
        })),
      },
    };
  });
}
