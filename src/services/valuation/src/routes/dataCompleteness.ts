import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, type Principal } from '../auth/rbac.js';
import { scoreCompleteness } from '../domain/dataCompleteness.js';
import { findValuationById } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { findQuestionnaire } from '../repos/intake.js';
import { findCapTable } from '../repos/capTables.js';
import { documentCoverage } from '../repos/documents.js';
import { requirePrincipal } from '../plugins/auth.js';

/**
 * Missing-data completeness (domain/dataCompleteness.ts) — what this
 * engagement still needs before a valuation can run.
 *
 * Computed on demand rather than stored, unlike health checks. A health check
 * is a record of a gate being passed at a moment, and finalization refers back
 * to it; this is a live view of the evidence base, and a stored copy would be
 * stale the moment anyone uploads a file. Nothing signs off on it, so there is
 * nothing to keep.
 *
 * Readable by anyone who can read the valuation, not ops-only: "what are we
 * still waiting on" is the question a client-facing engagement manager asks
 * most, and making it ops-only just moves the question into email.
 */
export function registerDataCompletenessRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/api/v1/valuations/:id/completeness', { preHandler: app.authenticate }, async (req) => {
    const principal: Principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();

    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    const readable = canReadValuation(principal, {
      userId: valuation.user_id,
      partnerId: valuation.partner_id,
    });
    // 404 rather than 403: whether a valuation exists is itself scoped.
    if (!readable) throw problems.notFound();

    // Only the set of covered buckets is read below, so this asks for the
    // buckets rather than for the files. `listDocuments` is a capped page, and
    // scoring a page would report a bucket as missing because its files sit
    // past the cap — a gap the engagement does not have, on the one screen
    // whose whole job is to say what is still missing.
    const [params, questionnaire, capTable, coverage] = await Promise.all([
      findParams(deps.pool, valuation.id),
      findQuestionnaire(deps.pool, valuation.id),
      findCapTable(deps.pool, valuation.id),
      documentCoverage(deps.pool, valuation.id),
    ]);

    // `engine_inputs` is the extracted-financials blob merged onto the params
    // row (repos/params.ts). It is the same object the engine payload is
    // assembled from, so scoring against it asks the question the engine will
    // ask rather than one adjacent to it.
    const engineInputs =
      params && typeof params.engine_inputs === 'object' && params.engine_inputs !== null
        ? (params.engine_inputs as Record<string, unknown>)
        : {};

    const report = scoreCompleteness({
      kind: valuation.kind,
      answers: questionnaire?.answers ?? {},
      documents: [...coverage.byCategory.keys()].map((category) => ({ category })),
      engineInputs,
      params: params ?? {},
      shareClasses: capTable?.entries ?? [],
    });

    return { completeness: report };
  });
}
