import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problems } from '@n409/shared';
import {
  selectValuationKinds,
  SELECTOR_JURISDICTIONS,
  SELECTOR_PURPOSES,
  SELECTOR_STANDARDS,
  SELECTOR_SUBJECTS,
  SELECTOR_TRIGGERS,
} from '../domain/valuationSelector.js';
import { invalidBody } from '../domain/validationProblem.js';
import { FixedWindowRateLimiter } from '../plugins/rateLimit.js';
import { recordThrottleRefusal } from '../observability/requestThrottle.js';

/**
 * "Which valuation do I need?" (remaining-gaps §selector). Public: the quiz
 * runs on the marketing site before an account exists, and the answer is
 * advice about report types, not data. Pure computation — no database, no
 * per-caller state.
 *
 * R378: added a per-IP limiter. The "platform limiter" cited here does not
 * exist for unauthenticated routes — `applyCostLimiter` keys on
 * `req.principal.id` and never fires without a session.
 */

const SELECTOR_LIMIT = 60;
const SELECTOR_WINDOW_MS = 10 * 60 * 1000;

const SelectorBody = z
  .object({
    purpose: z.enum(SELECTOR_PURPOSES).optional(),
    jurisdiction: z.enum(SELECTOR_JURISDICTIONS).optional(),
    accounting_standard: z.enum(SELECTOR_STANDARDS).optional(),
    subject: z.enum(SELECTOR_SUBJECTS).optional(),
    trigger: z.enum(SELECTOR_TRIGGERS).optional(),
    employee_count: z.number().int().min(0).max(10_000_000).optional(),
    grants_options: z.boolean().optional(),
    has_esop: z.boolean().optional(),
  })
  .strict();

export function registerValuationSelectorRoutes(
  app: FastifyInstance,
  deps: { limiter?: FixedWindowRateLimiter } = {},
): void {
  const limiter = deps.limiter ?? new FixedWindowRateLimiter(SELECTOR_LIMIT, SELECTOR_WINDOW_MS);

  app.post('/api/v1/valuation-selector', async (req) => {
    const { allowed, resetAt } = limiter.check(req.ip);
    if (!allowed) {
      recordThrottleRefusal('valuation-selector');
      throw problems.tooManyRequests(
        'Too many selector requests from this address',
        Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      );
    }
    const parsed = SelectorBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw invalidBody('Invalid selector answers', parsed.error);
    }
    const result = selectValuationKinds(parsed.data);
    return {
      // The questions the quiz can ask, so the frontend renders from the same
      // vocabulary this endpoint scores — the intake-schema contract again.
      inputs: {
        purposes: SELECTOR_PURPOSES,
        jurisdictions: SELECTOR_JURISDICTIONS,
        accounting_standards: SELECTOR_STANDARDS,
        subjects: SELECTOR_SUBJECTS,
        triggers: SELECTOR_TRIGGERS,
      },
      primary: result.primary,
      recommendations: result.recommendations,
    };
  });
}
