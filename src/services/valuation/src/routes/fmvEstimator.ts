import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problems } from '@n409/shared';
import {
  estimateFmv,
  ESTIMATOR_ROUND_AGES,
  ESTIMATOR_STAGES,
  NoEvidenceError,
  SAFE_HARBOR_DISCLAIMER,
} from '../domain/fmvEstimator.js';

/**
 * The free 409A estimator behind `/tools/409a-valuation-calculator`.
 *
 * Public, like the "which valuation?" quiz next to it: the tool runs on the
 * marketing site before an account exists, and a calculator gated behind a
 * signup is not a free calculator. Pure computation — no database, no
 * per-caller state, nothing persisted — so the platform limiter is the only
 * one it needs.
 *
 * The money fields are capped at a trillion rather than left open. Nothing
 * legitimate reaches it, `Number.MAX_VALUE` through a multiple band produces
 * `Infinity` rather than an error, and a range of `Infinity` renders as a
 * plausible-looking blank on the page.
 */

const MAX_MONEY = 1e12;

const EstimatorBody = z
  .object({
    stage: z.enum(ESTIMATOR_STAGES),
    round_age: z.enum(ESTIMATOR_ROUND_AGES),
    post_money: z.number().finite().min(0).max(MAX_MONEY).optional(),
    capital_raised: z.number().finite().min(0).max(MAX_MONEY).optional(),
    revenue_ltm: z.number().finite().min(0).max(MAX_MONEY).optional(),
    profit_ltm: z.number().finite().min(0).max(MAX_MONEY).optional(),
    fully_diluted_shares: z.number().finite().min(0).max(1e15).optional(),
  })
  .strict();

export function registerFmvEstimatorRoutes(app: FastifyInstance): void {
  app.post('/api/v1/fmv-estimator', async (req) => {
    const parsed = EstimatorBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw problems.unprocessable('Invalid estimator inputs', { errors: parsed.error.issues });
    }
    try {
      return {
        // The vocabulary the form renders from, served by the endpoint that
        // scores it — the same contract the intake schema and the selector
        // keep, so a stage added here cannot go missing from the form.
        inputs: { stages: ESTIMATOR_STAGES, round_ages: ESTIMATOR_ROUND_AGES },
        result: estimateFmv(parsed.data),
      };
    } catch (err) {
      // "You gave me nothing to work with" is the caller's mistake to fix, and
      // it is the state the form opens in — a 422 naming the four fields, not
      // a 500.
      if (err instanceof NoEvidenceError) {
        throw problems.unprocessable(err.message, { disclaimer: SAFE_HARBOR_DISCLAIMER });
      }
      throw err;
    }
  });
}
