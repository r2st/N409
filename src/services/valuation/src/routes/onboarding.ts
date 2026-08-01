import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { valuationScope } from '../auth/rbac.js';
import { onboardingProgress } from '../domain/onboarding.js';
import { onboardingFacts } from '../repos/onboarding.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Dashboard onboarding progress.
 *
 * Answers "which of the getting-started steps has this account actually
 * completed", scoped to the valuations the caller can see, so the checklist
 * agrees with the rest of the screen instead of tracking a separate
 * localStorage reality. Read-only and cheap: one query, no side effects.
 */
export function registerOnboardingRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/onboarding/progress', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const facts = await onboardingFacts(deps.pool, valuationScope(principal));
    return onboardingProgress(facts);
  });
}
