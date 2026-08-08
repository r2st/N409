import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { internalAuthHeaders, InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById } from '../repos/valuations.js';
import { findQuestionnaire } from '../repos/intake.js';
import { createCalculation, latestSucceededCalculation } from '../repos/calculations.js';
import { loadHmrcForm } from '../repos/hmrcForms.js';
import type { EventActor } from '../events/record.js';
import {
  isSpecialtyKind,
  SPECIALTY_KINDS,
  SpecialtyInputError,
  specialtyEngineRequest,
  specialtyHeadline,
} from '../domain/specialty.js';
import type { ValuationKind } from '../domain/valuation.js';

/**
 * Specialty report-type pipeline (remaining-gaps §report-types): one route
 * that takes a specialty valuation from submitted intake to a stored
 * calculation. The kind decides the engine endpoint; the questionnaire's
 * answers are assembled into its request (domain/specialty.ts); the result is
 * persisted as a calculation row so the existing report machinery — latest
 * succeeded calculation, exhibits, QA — picks it up with no special cases.
 */

const RunBody = z
  .object({
    /**
     * Analyst refinements merged over the questionnaire-assembled inputs —
     * the PPA intangible schedule, a real revenue forecast for an IP asset,
     * an SMB method weighting. Shallow merge; an override replaces the
     * assembled key wholesale.
     */
    inputs: z.record(z.unknown()).default({}),
  })
  .default({ inputs: {} });

/**
 * The specialty endpoints return bare result objects, so the engine build is
 * fetched once from its health route and remembered — a restart of either
 * service re-reads it. 'unknown' when the engine cannot say (stubbed tests).
 */
let cachedEngineVersion: string | null = null;
async function engineVersion(engineUrl: string): Promise<string> {
  if (cachedEngineVersion) return cachedEngineVersion;
  try {
    const res = await fetch(`${engineUrl}/engine/v1/health`, {
      headers: internalAuthHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { engine_version?: unknown };
    if (typeof body.engine_version === 'string' && body.engine_version !== '') {
      cachedEngineVersion = body.engine_version;
      return cachedEngineVersion;
    }
  } catch {
    // The version is provenance, not a dependency — a run must not fail
    // because the health route was momentarily unreachable.
  }
  return 'unknown';
}

/** Test hook: forget the remembered engine build. */
export function resetEngineVersionCache(): void {
  cachedEngineVersion = null;
}

function actorFor(principal: Principal): EventActor {
  return { actorType: 'engine', actorId: principal.id, source: 'engine-wrapper' };
}

export function registerSpecialtyRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; engineUrl: string },
): void {
  const loadValuation = async (id: string, principal: Principal) => {
    if (!isOps(principal)) throw problems.forbidden('Specialty calculations are operations-only');
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  const requireSpecialty = (kind: ValuationKind) => {
    if (!isSpecialtyKind(kind)) {
      throw problems.unprocessable(
        `A ${kind} valuation does not run through the specialty pipeline — supported kinds: ` +
          SPECIALTY_KINDS.join(', '),
      );
    }
    return kind;
  };

  // Run the kind's engine and persist the result as a calculation.
  app.post('/api/v1/valuations/:id/specialty', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id, principal);
    const kind = requireSpecialty(valuation.kind as ValuationKind);

    const parsed = RunBody.safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid inputs', { errors: parsed.error.issues });

    const questionnaire = await findQuestionnaire(deps.pool, id);
    let request;
    try {
      request = specialtyEngineRequest(kind, questionnaire?.answers ?? {}, parsed.data.inputs);
    } catch (err) {
      if (err instanceof SpecialtyInputError) throw problems.unprocessable(err.message);
      throw err;
    }

    const version = await engineVersion(deps.engineUrl);
    try {
      const result = await postJson<Record<string, unknown>>(
        'engine',
        `${deps.engineUrl}${request.path}`,
        request.body,
        { timeoutMs: 30_000 },
      );
      const headline = specialtyHeadline(kind, request, result);
      const calculation = await createCalculation(
        deps.pool,
        {
          valuationId: id,
          engineVersion: version,
          status: 'succeeded',
          inputs: { endpoint: request.path, ...request.body },
          results: { kind, specialty: result },
          equityValue: headline.equityValue,
          fmvPerShare: headline.fmvPerShare,
          createdBy: principal.id,
        },
        actorFor(principal),
      );
      return reply.status(201).send({ calculation, result });
    } catch (err) {
      if (err instanceof InternalServiceError) {
        await createCalculation(
          deps.pool,
          {
            valuationId: id,
            engineVersion: version,
            status: 'failed',
            inputs: { endpoint: request.path, ...request.body },
            error: err.message,
            diagnostics: err.issues,
            createdBy: principal.id,
          },
          actorFor(principal),
        );
        req.log.warn({ err }, 'specialty engine run failed');
        throw toProblem(err);
      }
      throw err;
    }
  });

  // Latest specialty result — what the workspace tab renders.
  app.get('/api/v1/valuations/:id/specialty', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id, principal);
    const kind = valuation.kind as ValuationKind;
    const latest = await latestSucceededCalculation(deps.pool, id);
    const specialty =
      latest?.results && typeof latest.results.specialty === 'object'
        ? (latest.results.specialty as Record<string, unknown>)
        : null;
    return {
      kind,
      supported: isSpecialtyKind(kind),
      calculation: specialty ? latest : null,
      result: specialty,
    };
  });

  /**
   * The HMRC agreement request pack — VAL231 for EMI, VAL230 for CSOP.
   *
   * 404 on any other kind rather than an empty envelope: there is no VAL230
   * for a 409A, and a client that renders whatever comes back should have
   * nothing to render. `complete` and `missing_required` are the point of the
   * endpoint — an analyst opens this to find out what is still outstanding
   * before the form goes to Shares and Assets Valuation, and a pack that
   * looked finished because the gaps were omitted would be worse than none.
   */
  app.get('/api/v1/valuations/:id/hmrc-form', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id, principal);
    const form = await loadHmrcForm(deps.pool, valuation);
    if (!form) {
      throw problems.notFound(
        `No HMRC valuation form applies to a ${valuation.kind} engagement (VAL231 is EMI, VAL230 is CSOP)`,
      );
    }
    return { form };
  });
}
