import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { runQaChecks, worstStatus, type QaStatus } from '../domain/qaChecks.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { createQaReview, listQaReviews } from '../repos/qaReviews.js';
import { calculationPayload, runAiPipeline, type AiPipelineDeps } from './ai.js';
import { InternalServiceError, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Quality-assurance gate (IMPROVEMENTS_RESEARCH §4.3): deterministic
 * reasonableness checks over the latest successful calculation, optionally
 * augmented by the 'qa' AI pipeline reviewing the outputs. The resulting
 * review is what the publish gate consults — a valuation with a failing (or
 * missing) review of its latest calculation cannot enter 'published'.
 */

const RunBody = z
  .object({
    // Also run the AI reviewer (needs the AI service; deterministic checks
    // alone never leave the process).
    ai: z.boolean().default(false),
  })
  .default({ ai: false });

const QA_STATUSES: ReadonlySet<string> = new Set(['pass', 'warn', 'fail']);

/** The AI verdict only ever tightens the outcome — never overrides a fail. */
export function combineWithAiVerdict(deterministic: QaStatus, verdict: unknown): QaStatus {
  if (typeof verdict === 'string' && QA_STATUSES.has(verdict)) {
    return worstStatus([deterministic, verdict as QaStatus]);
  }
  return deterministic;
}

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('QA reviews are operations-only');
}

export function registerQaRoutes(app: FastifyInstance, deps: AiPipelineDeps): void {
  const loadValuation = async (id: string): Promise<ValuationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  app.post('/api/v1/valuations/:id/qa', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id);

    const body = RunBody.safeParse(req.body ?? {});
    if (!body.success) throw problems.unprocessable('Invalid options', { errors: body.error.issues });

    const calculation = await latestSucceededCalculation(deps.pool, valuation.id);
    if (!calculation) {
      throw problems.unprocessable('No completed calculation to review — run a calculation first');
    }
    const params = await findParams(deps.pool, valuation.id);
    const deterministic = runQaChecks({ calculation, params });

    let aiFindings: Record<string, unknown> | null = null;
    let aiModel: string | null = null;
    let status = deterministic.status;
    if (body.data.ai) {
      try {
        const { job } = await runAiPipeline(deps, {
          valuation,
          pipeline: 'qa',
          anonymize: false,
          autoApply: false,
          createdBy: principal.id,
          actor: { actorType: 'ai', actorId: principal.id, source: 'ai-service' },
          // The reviewer judges outputs, not source documents.
          includeDocuments: false,
          extraPayload: {
            calculation: calculationPayload(calculation),
            qa_checks: deterministic.checks,
          },
        });
        aiFindings = job.result;
        aiModel = job.model;
        status = combineWithAiVerdict(deterministic.status, job.result?.verdict);
      } catch (err) {
        // No review row on an AI outage — a half-run must not open the gate.
        if (err instanceof InternalServiceError) throw toProblem(err);
        throw err;
      }
    }

    const review = await createQaReview(
      deps.pool,
      {
        valuationId: valuation.id,
        calculationId: calculation.id,
        status,
        checks: deterministic.checks,
        aiFindings,
        aiModel,
        createdBy: principal.id,
      },
      { actorType: body.data.ai ? 'ai' : 'system', actorId: principal.id, source: 'qa-gate' },
    );
    return reply.status(201).send({ review });
  });

  app.get('/api/v1/valuations/:id/qa', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(id);
    const [reviews, calculation] = await Promise.all([
      listQaReviews(deps.pool, id),
      latestSucceededCalculation(deps.pool, id),
    ]);
    // Which review (if any) currently satisfies the publish gate.
    const current = calculation ? (reviews.find((r) => r.calculation_id === calculation.id) ?? null) : null;
    return {
      reviews,
      latest_calculation_id: calculation?.id ?? null,
      gate: {
        satisfied: calculation ? current !== null && current.status !== 'fail' : true,
        review_id: current?.id ?? null,
        status: current?.status ?? null,
      },
    };
  });
}
