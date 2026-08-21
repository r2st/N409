import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';

/**
 * The discount-rate build-up, previewed.
 *
 * `engine/v1/wacc` builds the cost of equity on a modified CAPM and blends it
 * with the after-tax cost of debt, and had no caller. The rate it produces is
 * the DCF's most-questioned input, and until migration 0135 it reached the
 * engine only as a number an analyst typed into `income.discount_rate`.
 *
 * The calculation is where the build-up is *applied* (routes/calculations.ts
 * sets `auto_wacc` when the params carry one). This route is where it is
 * *seen*: an analyst entering a beta set and a target capital structure needs
 * to know what rate they produce before committing a run to it, and running a
 * whole valuation to find out is a slow way to ask.
 *
 * Reads the build-up from the stored params rather than from the request body,
 * so the preview cannot show a rate the calculation would not reproduce. That
 * is the whole value of a preview and the easiest thing to get wrong.
 */

/** Wall clock for one build-up. In-process arithmetic; generous. */
const WACC_TIMEOUT_MS = 15_000;

export function registerWaccRoutes(app: FastifyInstance, deps: { pool: pg.Pool; engineUrl: string }): void {
  app.post('/api/v1/valuations/:id/wacc/preview', { preHandler: app.authenticate }, async (req) => {
    const principal: Principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    if (!isOps(principal)) throw problems.forbidden('The discount-rate build-up is operations-only');
    // After authorization, not before: answering "retired" to a caller who may
    // not read this engagement would confirm that it exists.
    refuseIfRetired(valuation, 'accepting new runs');

    const paramsRow = await findParams(deps.pool, valuation.id);
    const inputs = paramsRow?.wacc_inputs;
    if (
      inputs === null ||
      inputs === undefined ||
      typeof inputs !== 'object' ||
      Array.isArray(inputs) ||
      Object.keys(inputs).length === 0
    ) {
      throw problems.unprocessable(
        'No WACC build-up is recorded on this engagement — enter the beta set and the target capital structure first',
      );
    }

    try {
      const result = await postJson<Record<string, unknown>>(
        'engine',
        `${deps.engineUrl}/engine/v1/wacc`,
        { inputs },
        {
          timeoutMs: WACC_TIMEOUT_MS,
          record: { valuationId: valuation.id, name: 'engine wacc' },
        },
      );
      return {
        wacc: result,
        // Whether this preview would actually reach the discount rate. The
        // switch and the build-up are separate params, and a preview that
        // showed a rate without saying it is switched off would be the one
        // misreading this endpoint exists to prevent.
        applied_on_next_run: paramsRow?.auto_wacc === true,
      };
    } catch (err) {
      if (err instanceof InternalServiceError) {
        req.log.warn({ err }, 'wacc build-up failed');
        throw toProblem(err);
      }
      throw err;
    }
  });
}
