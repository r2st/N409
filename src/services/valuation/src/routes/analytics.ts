import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { buildAnalytics, type CalcInput } from '../domain/valuationAnalytics.js';
import { sameCompanyFilter } from '../domain/valuationHistory.js';
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
    const scope = sameCompanyFilter(valuation);
    const { rows } = await deps.pool.query<{
      calculation_id: string;
      valuation_id: string;
      number: string;
      as_of: Date;
      results: Record<string, unknown>;
    }>(
      `SELECT c.id AS calculation_id, c.valuation_id, v.number, c.created_at AS as_of, c.results
         FROM valuations v
         JOIN LATERAL (
           SELECT id, valuation_id, created_at, results
             FROM calculations
            WHERE valuation_id = v.id AND status = 'succeeded' AND results IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1
         ) c ON true
        WHERE ${scope.clause}
        ORDER BY c.created_at ASC`,
      scope.params,
    );

    const calcs: CalcInput[] = rows.map((r) => ({
      calculation_id: r.calculation_id,
      valuation_id: r.valuation_id,
      as_of: new Date(r.as_of).toISOString(),
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
