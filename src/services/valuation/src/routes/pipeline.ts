import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { hasExtractableDocument } from '../repos/documents.js';
import { activePipelineRun, latestPipelineRun, setValuationAutoPipeline } from '../repos/pipelineRuns.js';
import { startPipelineRun, type AutoPipelineDeps } from '../pipeline/autoPipeline.js';
import { EXTRACTABLE_EXTENSIONS } from './ai.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';

const ToggleBody = z.object({ auto_pipeline: z.boolean() }).strict();

function actorFor(principal: Principal): EventActor {
  return { actorType: 'human', actorId: principal.id, source: 'api' };
}

/**
 * Auto-pipeline status/control routes (final-status §4.4 #3). The status GET
 * is what the valuation detail page polls while a run is in flight; trigger
 * and opt-out toggle are ops-only.
 */
export function registerPipelineRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; autoPipeline: AutoPipelineDeps },
): void {
  const loadValuation = async (principal: Principal, id: string): Promise<ValuationRow> => {
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

  app.get('/api/v1/valuations/:id/pipeline', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);
    return {
      enabled: deps.autoPipeline.enabled,
      auto_pipeline: valuation.auto_pipeline,
      run: await latestPipelineRun(deps.pool, valuation.id),
    };
  });

  app.post('/api/v1/valuations/:id/pipeline/runs', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Pipeline runs are operations-only');
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);
    refuseIfRetired(valuation, 'accepting changes');
    if (!deps.autoPipeline.enabled) {
      throw problems.unprocessable('The pipeline is disabled on this deployment (AUTO_PIPELINE=off)');
    }
    // Asked as the existence question it is. Reading the document list and
    // running `.some(isExtractable)` over it was correct only while the list
    // was the whole list; past the cap it refuses a run on an engagement that
    // does hold an extractable file, with a remedy the user has already met.
    if (!(await hasExtractableDocument(deps.pool, valuation.id, [...EXTRACTABLE_EXTENSIONS]))) {
      throw problems.unprocessable('Upload at least one extractable document (pdf/txt/csv/xlsx/…) first');
    }
    if (await activePipelineRun(deps.pool, valuation.id)) {
      throw problems.conflict('A pipeline run is already in progress for this valuation');
    }
    const run = await startPipelineRun(deps.autoPipeline, {
      valuation,
      trigger: 'manual',
      triggeredBy: principal.id,
    });
    // Null means another trigger won the race between the check above and the
    // insert — same answer as the check itself, just decided by the database.
    if (!run) throw problems.conflict('A pipeline run is already in progress for this valuation');
    return reply.status(201).send({ run });
  });

  app.patch('/api/v1/valuations/:id/pipeline', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Pipeline settings are operations-only');
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(principal, id);
    refuseIfRetired(valuation, 'accepting changes');
    const body = ToggleBody.safeParse(req.body ?? {});
    if (!body.success) throw invalidBody('Invalid body', body.error);
    const updated = await setValuationAutoPipeline(
      deps.pool,
      valuation,
      body.data.auto_pipeline,
      actorFor(principal),
    );
    return { auto_pipeline: updated.auto_pipeline };
  });
}
