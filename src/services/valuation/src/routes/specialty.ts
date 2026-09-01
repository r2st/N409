import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import {
  describeForUser,
  internalAuthHeaders,
  InternalServiceError,
  postJson,
  toProblem,
} from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById } from '../repos/valuations.js';
import { findQuestionnaire } from '../repos/intake.js';
import {
  createCalculation,
  latestSucceededSpecialtyCalculation,
  listCalculationSummaries,
} from '../repos/calculations.js';
import { loadHmrcForm } from '../repos/hmrcForms.js';
import type { EventActor } from '../events/record.js';
import {
  isSpecialtyKind,
  SPECIALTY_ENGINE_LIST,
  SPECIALTY_ENGINES,
  SPECIALTY_KINDS,
  SpecialtyInputError,
  specialtyEngineRequest,
  specialtyHeadline,
  type SpecialtyKind,
} from '../domain/specialty.js';
import type { ValuationKind } from '../domain/valuation.js';
import { kindLabel } from '../domain/valuationSelector.js';
import { refuseIfRetired, refuseIfRetiredNow } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';

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
 *
 * Every way of not knowing is reported. The version is not a dependency and a
 * run must never fail for want of it, which is why all three doors below end
 * in a string rather than a throw — but the string is written to
 * `calculations.engine_version` and stays there, and that column is
 * provenance: it is the record of which build priced this company, read back
 * by an auditor years later and by the rollforward that compares two runs. A
 * row saying `unknown` is a run whose provenance was lost, and until this line
 * existed nothing anywhere said so or why. The three reasons answer different
 * questions — `http_error` is the engine refusing a request this service is
 * authorised to make, `unreadable_version` is a health body that changed
 * shape, `transport_error` is the unit being down — and 'unknown' collapsed
 * all of them.
 */
let cachedEngineVersion: string | null = null;
export async function engineVersion(engineUrl: string, log?: FastifyBaseLogger): Promise<string> {
  if (cachedEngineVersion) return cachedEngineVersion;
  const unknown = (reason: string, extra: Record<string, unknown> = {}): string => {
    log?.warn(
      { reason, ...extra },
      'engine build could not be read; this run is recorded with no engine version',
    );
    return 'unknown';
  };
  try {
    const res = await fetch(`${engineUrl}/engine/v1/health`, {
      headers: internalAuthHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return unknown('http_error', { status: res.status });
    const body = (await res.json()) as { engine_version?: unknown };
    if (typeof body.engine_version === 'string' && body.engine_version !== '') {
      cachedEngineVersion = body.engine_version;
      return cachedEngineVersion;
    }
    return unknown('unreadable_version');
  } catch (err) {
    // The version is provenance, not a dependency — a run must not fail
    // because the health route was momentarily unreachable.
    return unknown('transport_error', { err });
  }
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
        `“${kindLabel(kind)}” does not run through the specialty pipeline — it runs through the ` +
          `409A engine, on the Calculations tab. The kinds this pipeline serves are: ` +
          SPECIALTY_KINDS.map(kindLabel).join(', '),
      );
    }
    return kind;
  };

  // Run the kind's engine and persist the result as a calculation.
  app.post('/api/v1/valuations/:id/specialty', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id, principal);
    refuseIfRetired(valuation, 'accepting changes');
    const kind = requireSpecialty(valuation.kind as ValuationKind);

    const parsed = RunBody.safeParse(req.body ?? {});
    if (!parsed.success) throw invalidBody('Invalid inputs', parsed.error);

    const questionnaire = await findQuestionnaire(deps.pool, id);
    let request;
    try {
      request = specialtyEngineRequest(kind, questionnaire?.answers ?? {}, parsed.data.inputs);
    } catch (err) {
      if (err instanceof SpecialtyInputError) throw problems.unprocessable(err.message);
      throw err;
    }

    const version = await engineVersion(deps.engineUrl, req.log);
    try {
      const result = await postJson<Record<string, unknown>>(
        'engine',
        `${deps.engineUrl}${request.path}`,
        request.body,
        { timeoutMs: 30_000, record: { valuationId: id, name: `engine specialty (${kind})` } },
      );
      const headline = specialtyHeadline(kind, request, result);
      // The engagement as it stands now — see the same guard on the 409A
      // compute in `calculations.ts`. A specialty run writes a `calculations`
      // row exactly as that one does, and it is the row the specialty exhibits
      // read. Only the succeeded arm, for the reason given there.
      await refuseIfRetiredNow(deps.pool, id, 'accepting changes');
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
            // The same column the 409A run writes, drawn by the same two
            // components — see the note in routes/calculations.ts.
            error: describeForUser(err),
            diagnostics: err.issues,
            createdBy: principal.id,
          },
          actorFor(principal),
        );
        req.log.warn({ err, valuationId: id }, 'specialty engine run failed');
        throw toProblem(err);
      }
      throw err;
    }
  });

  /**
   * The kind → engine registry, served rather than duplicated on the client.
   *
   * The map exists once, in `domain/specialty.ts`. A frontend copy would be a
   * second answer to "which engine runs an ASC 820 measurement", and the two
   * would disagree the first time an endpoint moved.
   */
  app.get('/api/v1/specialty/schema', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Specialty calculations are operations-only');
    return { engines: SPECIALTY_ENGINE_LIST, kinds: SPECIALTY_KINDS };
  });

  // Latest specialty result plus the run history — what the workspace tab renders.
  app.get('/api/v1/valuations/:id/specialty', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id, principal);
    const kind = valuation.kind as ValuationKind;
    const supported = isSpecialtyKind(kind);
    // The newest *specialty* run, not the newest run. Nothing stops an EMI or
    // ESOP engagement from also using the Calculations tab's ordinary compute,
    // and that row is newer without being a specialty result — so asking for
    // the latest of any shape made a 409A run hide a perfectly good specialty
    // one, and this handler then reported "No result yet" directly above a run
    // history listing the succeeded run it had just discarded. `history` below
    // has always filtered to specialty runs; this is the same question.
    const latest = await latestSucceededSpecialtyCalculation(deps.pool, id);
    const specialty =
      latest?.results && typeof latest.results.specialty === 'object'
        ? (latest.results.specialty as Record<string, unknown>)
        : null;

    // Failed runs belong in the history as much as successful ones: an analyst
    // reading "why did nothing happen" is looking for the 422 the engine gave
    // back, and a list of only the successes cannot show it.
    // The narrow reader: this list is seven scalar columns and one key of
    // `inputs`, and the full one carried both jsonb documents of all twenty-one
    // runs to produce it. `input_endpoint` is that key, probed in SQL under the
    // same `typeof === 'string'` rule this filter applies.
    const historyPage = await listCalculationSummaries(deps.pool, id);
    const history = historyPage.calculations
      .filter((c) => c.input_endpoint?.startsWith('/engine/v1/') === true)
      .map((c) => ({
        id: c.id,
        status: c.status,
        engine_version: c.engine_version,
        equity_value: c.equity_value,
        fmv_per_share: c.fmv_per_share,
        error: c.error,
        created_at: c.created_at,
      }));

    return {
      kind,
      supported,
      engine: supported ? SPECIALTY_ENGINES[kind as SpecialtyKind] : null,
      calculation: specialty ? latest : null,
      result: specialty,
      history,
      // The window this history was filtered out of, not the filtered list: a
      // run that fell off the twenty is one this tab cannot show whether or not
      // it was a specialty run, and the reader has no other way to learn that.
      truncated: historyPage.truncated,
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
        `No HMRC valuation form applies to this engagement — it is a “${kindLabel(valuation.kind)}”. ` +
          `VAL231 is raised on an “${kindLabel('emi')}” and VAL230 on a “${kindLabel('csop')}”; ` +
          `start one of those if the company needs a form.`,
      );
    }
    return { form };
  });
}
