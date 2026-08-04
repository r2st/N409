import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadReport, canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import {
  AI_PIPELINES,
  CALCULATION_DEPENDENT_PIPELINES,
  DOCUMENT_DEPENDENT_PIPELINES,
  type AiPipeline,
} from '../domain/pipeline.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { latestSucceededCalculation, type CalculationRow } from '../repos/calculations.js';
import { applyEngineInputs, findParams } from '../repos/params.js';
import { listDocuments, type DocumentRow } from '../repos/documents.js';
import {
  completeAiJob,
  createAiJob,
  latestSucceededJob,
  listAiJobs,
  type AiJobRow,
} from '../repos/aiJobs.js';
import { findPromptByPipeline, latestPromptVersion } from '../repos/aiPrompts.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { decodeFromStorage } from '../storage/documentEncryption.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

/**
 * How long one AI pipeline call may take, end to end.
 *
 * This has to sit *above* the AI service's own whole-call budget
 * (`openrouter.DEFAULT_CALL_BUDGET_S`, 150s) plus the request handling around
 * it, and it did not: the call passed no timeout, took `postJson`'s 120s
 * default, and so gave up on a working pipeline thirty seconds before that
 * pipeline was entitled to finish. Because a timeout used to count as
 * retryable, the response to reaching our deadline was to send the whole
 * payload again — a second set of LLM calls billed for one request, a second of
 * the AI service's forty threadpool slots spent on a job it was already doing,
 * and the analyst waiting out both deadlines to be told it timed out.
 *
 * Sized so the upstream's own deadline is always the one that fires. Whoever
 * moves `DEFAULT_CALL_BUDGET_S` moves this with it.
 */
export const AI_PIPELINE_TIMEOUT_MS = 180_000;

/** Only text-extractable formats are shipped to the AI service. */
export const EXTRACTABLE_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.csv',
  '.tsv',
  '.md',
  '.json',
  '.xlsx',
  '.xlsm',
]);
const MAX_AI_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_AI_DOCUMENTS = 10;

export interface AiPipelineResponse {
  model: string;
  result: Record<string, unknown>;
}

const RunBody = z
  .object({
    // Cap-table anonymization (PII redaction) is on unless explicitly disabled.
    anonymize: z.boolean().default(true),
    // extract only: apply the extracted engine inputs to params on success.
    auto_apply: z.boolean().default(false),
    // Agent-specific context (comp_context, company_profile, comparables,
    // methodology, prior_valuation, new_data, ...) passed straight to the AI
    // service. Kept opaque here so new agents don't need a route change.
    context: z.record(z.unknown()).optional(),
  })
  .default({ anonymize: true, auto_apply: false });

function actorFor(principal: Principal): EventActor {
  return { actorType: 'ai', actorId: principal.id, source: 'ai-service' };
}

async function encodeDocuments(
  documentsDir: string,
  docs: DocumentRow[],
): Promise<Array<Record<string, unknown>>> {
  const eligible = docs
    .filter((d) => EXTRACTABLE_EXTENSIONS.has(path.extname(d.filename).toLowerCase()))
    .filter((d) => Number(d.size_bytes) <= MAX_AI_DOCUMENT_BYTES)
    .slice(0, MAX_AI_DOCUMENTS);
  const encoded: Array<Record<string, unknown>> = [];
  for (const doc of eligible) {
    try {
      const stored = await readFile(path.join(documentsDir, doc.storage_path));
      const buf = decodeFromStorage(stored);
      encoded.push({
        id: doc.id,
        filename: doc.filename,
        kind: doc.kind,
        content_type: doc.content_type,
        content_base64: buf.toString('base64'),
      });
    } catch {
      // A missing blob shouldn't sink the whole pipeline run.
    }
  }
  return encoded;
}

export interface AiPipelineDeps {
  pool: pg.Pool;
  aiUrl: string;
  documentsDir: string;
}

/**
 * Runs one AI pipeline end-to-end: prompt-registry lookup, document encoding,
 * the AI-service call, job persistence, and (extract only) auto-applying the
 * engine inputs to params. Shared by the interactive route below and the
 * auto-pipeline orchestrator. On an upstream failure the job is completed as
 * 'failed' and the InternalServiceError is re-thrown for the caller to map.
 */
export async function runAiPipeline(
  deps: AiPipelineDeps,
  args: {
    valuation: ValuationRow;
    pipeline: AiPipeline;
    anonymize: boolean;
    autoApply: boolean;
    createdBy: string;
    actor: EventActor;
    /** QA reviews output, not source documents — lets callers skip the corpus. */
    includeDocuments?: boolean;
    /** Extra payload fields (e.g. the calculation for 'qa'/'explain' runs). */
    extraPayload?: Record<string, unknown>;
  },
): Promise<{ job: AiJobRow; appliedInputs: Record<string, unknown> | null }> {
  const { valuation, pipeline } = args;
  const params = await findParams(deps.pool, valuation.id);
  const documents = await listDocuments(deps.pool, valuation.id);

  // Registry-managed prompt: the stored system prompt + model binding ride
  // along so admins can tune pipelines without a deploy (Bot Prompts view).
  const promptRow = await findPromptByPipeline(deps.pool, pipeline);
  // On/off toggle (migration 0060): a disabled agent is refused before any job
  // is created or LLM call is made.
  if (promptRow && promptRow.enabled === false) {
    throw problems.unprocessable(`The "${pipeline}" agent is disabled`);
  }
  const promptVersion = promptRow ? await latestPromptVersion(deps.pool, promptRow.id) : null;
  const payload = {
    valuation: {
      id: valuation.id,
      kind: valuation.kind,
      company_name: valuation.company_name,
      currency: valuation.currency,
      service_countries: valuation.service_countries,
    },
    params,
    documents: args.includeDocuments === false ? [] : await encodeDocuments(deps.documentsDir, documents),
    prompt: promptRow ? { system: promptRow.system_prompt, model: promptRow.model } : null,
    options: { anonymize: args.anonymize },
    ...(args.extraPayload ?? {}),
  };

  const job = await createAiJob(deps.pool, {
    valuationId: valuation.id,
    pipeline,
    // Persist provenance, not payloads: which docs went in, not their bytes.
    input: {
      document_ids: documents.map((d) => d.id),
      company_name: valuation.company_name,
    },
    createdBy: args.createdBy,
    promptVersion,
  });

  const startedAt = Date.now();
  try {
    const response = await postJson<AiPipelineResponse>(
      'ai-service',
      `${deps.aiUrl}/ai/v1/pipelines/${pipeline}`,
      payload,
      { timeoutMs: AI_PIPELINE_TIMEOUT_MS },
    );
    const completed = await completeAiJob(
      deps.pool,
      job,
      {
        status: 'succeeded',
        model: response.model,
        result: response.result,
        latencyMs: Date.now() - startedAt,
      },
      args.actor,
    );
    // Auto-apply (409.ai "Set Valuation Parameters"): extracted engine
    // inputs land in params without a second manual step.
    let appliedInputs: Record<string, unknown> | null = null;
    if (pipeline === 'extract' && args.autoApply) {
      const extracted = response.result?.engine_inputs;
      if (extracted && typeof extracted === 'object' && Object.keys(extracted).length > 0) {
        appliedInputs = extracted as Record<string, unknown>;
        await applyEngineInputs(deps.pool, valuation.id, appliedInputs, args.actor);
      }
    }
    return { job: completed, appliedInputs };
  } catch (err) {
    if (err instanceof InternalServiceError) {
      await completeAiJob(
        deps.pool,
        job,
        { status: 'failed', error: err.message, latencyMs: Date.now() - startedAt },
        args.actor,
      );
    }
    throw err;
  }
}

/** The slice of a calculation the 'qa'/'explain' pipelines receive. */
export function calculationPayload(calc: CalculationRow): Record<string, unknown> {
  return {
    equity_value: calc.equity_value,
    fmv_per_share: calc.fmv_per_share,
    results: calc.results,
    inputs: calc.inputs,
  };
}

export function registerAiRoutes(app: FastifyInstance, deps: AiPipelineDeps): void {
  const loadValuation = async (id: string): Promise<ValuationRow> => {
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  app.post('/api/v1/valuations/:id/ai/:pipeline', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('AI pipelines are operations-only');

    const { id, pipeline } = req.params as { id: string; pipeline: string };
    if (!(AI_PIPELINES as readonly string[]).includes(pipeline)) {
      throw problems.notFound(`Unknown pipeline "${pipeline}"`);
    }
    if (pipeline === 'qa') {
      // QA runs through its own route so the deterministic checks and the
      // gate-visible review row always accompany the AI reviewer.
      throw problems.unprocessable('Run the QA reviewer via POST /valuations/:id/qa');
    }
    const typedPipeline = pipeline as AiPipeline;
    const valuation = await loadValuation(id);
    const documents = await listDocuments(deps.pool, id);

    if (pipeline === 'extract' && documents.length === 0) {
      throw problems.unprocessable('Upload at least one document before running data extraction');
    }
    // Agents that read the corpus (e.g. cap-table structuring) need documents.
    if (DOCUMENT_DEPENDENT_PIPELINES.has(typedPipeline) && documents.length === 0) {
      throw problems.unprocessable('Upload at least one document before running this agent');
    }

    // Agents that narrate or defend a result need a calculation to exist.
    let extraPayload: Record<string, unknown> | undefined;
    if (CALCULATION_DEPENDENT_PIPELINES.has(typedPipeline)) {
      const calc = await latestSucceededCalculation(deps.pool, id);
      if (!calc) {
        throw problems.unprocessable('Run a calculation before running this agent');
      }
      extraPayload = { calculation: calculationPayload(calc) };
    }

    const body = RunBody.safeParse(req.body ?? {});
    if (!body.success) throw problems.unprocessable('Invalid options', { errors: body.error.issues });

    // Merge the auto-attached calculation with any caller-supplied agent context.
    const merged = { ...(extraPayload ?? {}), ...(body.data.context ?? {}) };

    try {
      const { job, appliedInputs } = await runAiPipeline(deps, {
        valuation,
        pipeline: typedPipeline,
        anonymize: body.data.anonymize,
        autoApply: body.data.auto_apply,
        createdBy: principal.id,
        actor: actorFor(principal),
        extraPayload: Object.keys(merged).length > 0 ? merged : undefined,
      });
      return reply.status(201).send({ job, applied_inputs: appliedInputs });
    } catch (err) {
      if (err instanceof InternalServiceError) throw toProblem(err);
      throw err;
    }
  });

  // Apply the latest successful extraction to params on demand — the manual
  // twin of auto_apply (remaining-gaps §2 "Set Valuation Parameters").
  app.post('/api/v1/valuations/:id/ai/extract/apply', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('AI pipelines are operations-only');
    const { id } = req.params as { id: string };
    await loadValuation(id);

    const job = await latestSucceededJob(deps.pool, id, 'extract');
    const extracted = job?.result?.engine_inputs;
    if (!extracted || typeof extracted !== 'object' || Object.keys(extracted).length === 0) {
      throw problems.unprocessable(
        'No successful extraction with engine inputs to apply — run data extraction first',
      );
    }
    const params = await applyEngineInputs(
      deps.pool,
      id,
      extracted as Record<string, unknown>,
      actorFor(principal),
    );
    return { params, applied_inputs: extracted, source_job_id: job!.id };
  });

  app.get('/api/v1/valuations/:id/ai', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('AI pipelines are operations-only');
    const { id } = req.params as { id: string };
    await loadValuation(id);
    return { jobs: await listAiJobs(deps.pool, id) };
  });

  // Plain-English methodology summary (IMPROVEMENTS_RESEARCH §4.5). Readable
  // by anyone who can see the valuation, but the content follows the report's
  // visibility: clients get it once a draft has been shared, never before.
  app.get('/api/v1/valuations/:id/explanation', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    const ref = valuation
      ? { userId: valuation.user_id, partnerId: valuation.partner_id, state: valuation.state }
      : null;
    if (!valuation || !ref || !canReadValuation(principal, ref)) throw problems.notFound();
    if (!canReadReport(principal, ref)) {
      return { explanation: null, model: null, generated_at: null };
    }
    const job = await latestSucceededJob(deps.pool, id, 'explain');
    return {
      explanation: job?.result ?? null,
      model: job?.model ?? null,
      generated_at: job?.completed_at ?? null,
    };
  });
}
