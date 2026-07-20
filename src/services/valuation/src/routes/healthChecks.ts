import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { runHealthChecks } from '../domain/healthChecks.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { createHealthCheck, listHealthChecks } from '../repos/healthChecks.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Valuation health checks (domain/healthChecks.ts): a categorized readiness
 * gate over the latest successful calculation, run before a report is
 * finalized. An `error`-severity finding blocks finalization; warnings and
 * info surface for the analyst. Analyst tooling — ops only.
 */

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('Health checks are operations-only');
}

export function registerHealthCheckRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const loadValuation = async (id: string): Promise<ValuationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  app.post('/api/v1/valuations/:id/health-checks', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id);

    const calculation = await latestSucceededCalculation(deps.pool, valuation.id);
    if (!calculation) {
      throw problems.unprocessable('No completed calculation to check — run a calculation first');
    }
    const params = await findParams(deps.pool, valuation.id);
    const report = runHealthChecks({ calculation, params, valuation });

    const row = await createHealthCheck(
      deps.pool,
      {
        valuationId: valuation.id,
        calculationId: calculation.id,
        severity: report.severity,
        blocking: report.blocking,
        checks: report.checks,
        counts: report.counts,
        createdBy: principal.id,
      },
      { actorType: 'system', actorId: principal.id, source: 'health-checks' },
    );
    return reply.status(201).send({ health_check: row });
  });

  app.get('/api/v1/valuations/:id/health-checks', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(id);
    const [runs, calculation] = await Promise.all([
      listHealthChecks(deps.pool, id),
      latestSucceededCalculation(deps.pool, id),
    ]);
    const current = calculation
      ? (runs.find((r) => r.calculation_id === calculation.id) ?? null)
      : null;
    return {
      health_checks: runs,
      latest_calculation_id: calculation?.id ?? null,
      gate: {
        // Finalization is clear when the latest calculation has a non-blocking
        // run (or there is no calculation to check yet).
        satisfied: calculation ? current !== null && !current.blocking : true,
        health_check_id: current?.id ?? null,
        severity: current?.severity ?? null,
        blocking: current?.blocking ?? null,
      },
    };
  });
}
