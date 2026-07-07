import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { isOps, type Principal } from '../auth/rbac.js';
import { AI_PIPELINES, type AiPipeline } from '../domain/pipeline.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { applyEngineInputs, findParams } from '../repos/params.js';
import { listDocuments, type DocumentRow } from '../repos/documents.js';
import { completeAiJob, createAiJob, latestSucceededJob, listAiJobs } from '../repos/aiJobs.js';
import { findPromptByPipeline, latestPromptVersion } from '../repos/aiPrompts.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';

/** Only text-extractable formats are shipped to the AI service. */
const EXTRACTABLE_EXTENSIONS = new Set([
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
      const buf = await readFile(path.join(documentsDir, doc.storage_path));
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

export function registerAiRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; aiUrl: string; documentsDir: string },
): void {
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
    const valuation = await loadValuation(id);
    const params = await findParams(deps.pool, id);
    const documents = await listDocuments(deps.pool, id);

    if (pipeline === 'extract' && documents.length === 0) {
      throw problems.unprocessable('Upload at least one document before running data extraction');
    }

    const body = RunBody.safeParse(req.body ?? {});
    if (!body.success) throw problems.unprocessable('Invalid options', { errors: body.error.issues });

    // Registry-managed prompt: the stored system prompt + model binding ride
    // along so admins can tune pipelines without a deploy (Bot Prompts view).
    const promptRow = await findPromptByPipeline(deps.pool, pipeline as AiPipeline);
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
      documents: await encodeDocuments(deps.documentsDir, documents),
      prompt: promptRow ? { system: promptRow.system_prompt, model: promptRow.model } : null,
      options: { anonymize: body.data.anonymize },
    };

    const job = await createAiJob(deps.pool, {
      valuationId: id,
      pipeline: pipeline as AiPipeline,
      // Persist provenance, not payloads: which docs went in, not their bytes.
      input: {
        document_ids: documents.map((d) => d.id),
        company_name: valuation.company_name,
      },
      createdBy: principal.id,
      promptVersion,
    });

    const startedAt = Date.now();
    try {
      const response = await postJson<AiPipelineResponse>(
        'ai-service',
        `${deps.aiUrl}/ai/v1/pipelines/${pipeline}`,
        payload,
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
        actorFor(principal),
      );
      // Auto-apply (409.ai "Set Valuation Parameters"): extracted engine
      // inputs land in params without a second manual step.
      let appliedInputs: Record<string, unknown> | null = null;
      if (pipeline === 'extract' && body.data.auto_apply) {
        const extracted = response.result?.engine_inputs;
        if (extracted && typeof extracted === 'object' && Object.keys(extracted).length > 0) {
          appliedInputs = extracted as Record<string, unknown>;
          await applyEngineInputs(deps.pool, id, appliedInputs, actorFor(principal));
        }
      }
      return reply.status(201).send({ job: completed, applied_inputs: appliedInputs });
    } catch (err) {
      if (err instanceof InternalServiceError) {
        await completeAiJob(
          deps.pool,
          job,
          { status: 'failed', error: err.message, latencyMs: Date.now() - startedAt },
          actorFor(principal),
        );
        throw toProblem(err);
      }
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
      throw problems.unprocessable('No successful extraction with engine inputs to apply — run data extraction first');
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
}
