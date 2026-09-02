import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import {
  createDecision,
  isDecisionAlreadyRevised,
  DECISION_CATEGORIES,
  findDecisionById,
  DECISION_PAGE_LIMIT,
  listDecisions,
} from '../repos/methodologyDecisions.js';
import { findValuationById } from '../repos/valuations.js';
import { requirePrincipal } from '../plugins/auth.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';

/**
 * Audit-defense methodology decision log (IMPROVEMENTS_RESEARCH §5.3): every
 * consequential methodology choice recorded WITH its rationale at the moment
 * it is made, append-only. Revisions point at the superseded row instead of
 * mutating it, so the log reads as the decision history an auditor asks for.
 * Exported in the evidence bundle as decisions.json. Ops-only — this is
 * analyst working material.
 */

const DecisionBody = z.object({
  category: z.enum(DECISION_CATEGORIES),
  decision: z.string().trim().min(1).max(2_000),
  rationale: z.string().trim().min(1).max(10_000),
  supersedes: z.string().nullable().optional(),
});

function requireOps(principal: Principal): void {
  if (!isOps(principal)) throw problems.forbidden('The methodology decision log is operations-only');
}

export function registerDecisionRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const loadValuation = async (id: string) => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  app.post('/api/v1/valuations/:id/decisions', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id);
    refuseIfRetired(valuation, 'accepting changes');

    const parsed = DecisionBody.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Invalid decision', parsed.error);

    const supersedes = parsed.data.supersedes ?? null;
    if (supersedes !== null) {
      if (!isUlid(supersedes)) throw problems.unprocessable('Unknown superseded decision');
      const prior = await findDecisionById(deps.pool, supersedes);
      if (!prior || prior.valuation_id !== valuation.id) {
        throw problems.unprocessable('Unknown superseded decision');
      }
    }

    const decision = await createDecision(
      deps.pool,
      {
        valuationId: valuation.id,
        category: parsed.data.category,
        decision: parsed.data.decision,
        rationale: parsed.data.rationale,
        supersedes,
        decidedBy: principal.id,
      },
      { actorType: 'human', actorId: principal.id, source: 'decision-log' },
    );
    /*
     * A decision is revised once. See `DecisionAlreadyRevised`: the browser's
     * "Supersedes" select already omits revised entries, and a select is a
     * snapshot — the second of two operators on the same engagement, or a tab
     * left open while a colleague revises the row it is listing, submits a
     * target that stopped being revisable after the page was drawn.
     *
     * 409 rather than 422, because nothing about the request is malformed: it
     * was correct when it was composed and the world moved. The revision that
     * got there first is named, since the operator's next step is to read it
     * and decide whether they still disagree — and the entry they wrote is not
     * lost, it is one they can record against that one instead.
     */
    if (isDecisionAlreadyRevised(decision)) {
      throw problems.conflict(
        'That decision has already been revised by a later entry — reload the decision log and ' +
          `revise the current one instead (revision ${decision.supersededBy}).`,
      );
    }
    return reply.status(201).send({ decision });
  });

  app.get('/api/v1/valuations/:id/decisions', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    requireOps(principal);
    const { id } = req.params as { id: string };
    await loadValuation(id);
    const { decisions, truncated } = await listDecisions(deps.pool, id);
    // Rows superseded by a later entry, for strike-through rendering. Read off
    // this page: a superseding row beyond the cap cannot strike through one on
    // it, so a truncated log shows a superseded decision as live — which is
    // why the flag below has to reach the screen.
    const superseded = new Set(decisions.map((d) => d.supersedes).filter(Boolean) as string[]);
    return {
      decisions: decisions.map((d) => ({ ...d, superseded: superseded.has(d.id) })),
      categories: DECISION_CATEGORIES,
      truncated,
      page_limit: DECISION_PAGE_LIMIT,
    };
  });
}
