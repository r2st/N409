import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { findValuationById } from '../repos/valuations.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { buildBridge } from '../domain/valuationBridge.js';
import { sameCompany, sameCompanyFilter } from '../domain/valuationHistory.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Cross-period value-bridge (feature 3): GET /valuations/:id/bridge/:compareId
 * explains the per-share FMV change between two valuations of the same company,
 * using the latest successful calculation of each.
 *
 * "The same company" is `sameCompanyFilter` — the one definition the report's
 * trend chart and the analytics time series were moved onto, and which this
 * endpoint was left out of. It had its own copy of the equivalence class that
 * change replaced, `v.user_id = $1 AND company_name = $2`, in both halves: the
 * candidate list a firm picks from, and the guard on the comparison itself.
 *
 * So a firm whose 409As were opened by different members — which client intake
 * makes ordinary, since a converted intake belongs to whoever pressed Convert —
 * saw an empty candidate list on this year's valuation, and was answered "Both
 * valuations must be for the same company" if it reached for last year's
 * directly. That is the bridge refusing to draw the one comparison it exists
 * for, on the firm's own client, over a field the firm never chose.
 */
export function registerBridgeRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
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

  // Other valuations of the same company that have a completed calculation —
  // the candidates the UI offers to compare against.
  app.get('/api/v1/valuations/:id/bridge-candidates', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await load(principal, id);
    const scope = sameCompanyFilter(valuation);
    const { rows } = await deps.pool.query<{
      id: string;
      number: string;
      created_at: Date;
      fmv_per_share: string | null;
    }>(
      `SELECT v.id, v.number, v.created_at,
              (SELECT c.fmv_per_share FROM calculations c
                 WHERE c.valuation_id = v.id AND c.status = 'succeeded'
                 ORDER BY c.created_at DESC LIMIT 1) AS fmv_per_share
         FROM valuations v
        WHERE ${scope.clause}
          AND v.id <> $3
          AND EXISTS (SELECT 1 FROM calculations c
                        WHERE c.valuation_id = v.id AND c.status = 'succeeded')
        ORDER BY v.created_at DESC
        LIMIT 50`,
      [...scope.params, id],
    );
    return { candidates: rows };
  });

  app.get('/api/v1/valuations/:id/bridge/:compareId', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id, compareId } = req.params as { id: string; compareId: string };
    if (id === compareId) throw problems.unprocessable('Pick two different valuations to compare');

    const [to, from] = await Promise.all([load(principal, id), load(principal, compareId)]);

    // The bridge only makes sense within one company's history — the same
    // "one client" the candidate list above is drawn from.
    if (!sameCompany(to, from)) {
      throw problems.unprocessable('Both valuations must be for the same company');
    }

    const [toCalc, fromCalc] = await Promise.all([
      latestSucceededCalculation(deps.pool, id),
      latestSucceededCalculation(deps.pool, compareId),
    ]);
    if (!toCalc?.results || !fromCalc?.results) {
      throw problems.unprocessable(
        'Both valuations need a completed calculation before they can be compared',
      );
    }

    const bridge = buildBridge(fromCalc.results, toCalc.results);
    return {
      bridge,
      from: {
        valuation_id: compareId,
        number: from.number,
        calculation_id: fromCalc.id,
        created_at: fromCalc.created_at,
      },
      to: {
        valuation_id: id,
        number: to.number,
        calculation_id: toCalc.id,
        created_at: toCalc.created_at,
      },
      company_name: to.company_name,
    };
  });
}
