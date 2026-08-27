import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadReport, canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import {
  AI_PIPELINES,
  CALCULATION_DEPENDENT_PIPELINES,
  DOCUMENT_DEPENDENT_PIPELINES,
  NON_RUNNABLE_PIPELINES,
  type AiPipeline,
} from '../domain/pipeline.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { latestSucceededCalculation, type CalculationRow } from '../repos/calculations.js';
import { applyEngineInputs, findParams } from '../repos/params.js';
import { sanitizeExtractedInputs, type RejectedInput } from './engineInputs.js';
import { findDocumentsByIds, listDocuments, type DocumentRow } from '../repos/documents.js';
import { findUserById } from '../repos/users.js';
import {
  completeAiJob,
  createAiJob,
  latestSucceededJob,
  listAiJobs,
  type AiJobRow,
} from '../repos/aiJobs.js';
import { findPromptByPipeline, latestPromptVersion } from '../repos/aiPrompts.js';
import { listNarrativePromptsForKind } from '../repos/narrativePrompts.js';
import { narrativeSectionsPayload } from '../domain/narrativePrompts.js';
import { narrativeResearchPayload } from '../domain/research.js';
import { listMarketResearch } from '../repos/marketResearch.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { decodeFromStorage } from '../storage/documentEncryption.js';
import { requirePrincipal } from '../plugins/auth.js';
import type { EventActor } from '../events/record.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  COMPARABLE_PAGE_LIMIT,
  listComparableItems,
  replaceMachineComparables,
} from '../repos/comparableItems.js';
import { summarizeSet } from '../domain/comparables.js';
import {
  AiComparablesError,
  mapAgentComparables,
  type MappedComparableSet,
} from '../domain/aiComparables.js';
import { presentComparable } from './comparables.js';
import { findCompanyProfile, upsertCompanyProfile } from '../repos/companyProfiles.js';
import {
  AiCompanyProfileError,
  draftFromAgentResult,
  narrativeProfilePayload,
  type ProfileDraft,
} from '../domain/companyProfile.js';
import {
  mapAgentTags,
  tagCataloguePayload,
  ValuationTagError,
  type MappedTagSet,
} from '../domain/valuationTags.js';
import { listValuationTags, upsertValuationTags } from '../repos/valuationTags.js';
import { presentValuationTag } from './valuationTags.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';
import { invalidBody } from '../domain/validationProblem.js';

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

/**
 * Redaction is a pure string pass with no model behind it, so the AI service
 * answers in milliseconds. Nothing about it justifies the pipeline deadline
 * above, and an operator who has clicked "anonymize" and is watching a spinner
 * should be told the service is down long before three minutes have gone by.
 */
export const AI_ANONYMIZE_TIMEOUT_MS = 30_000;

export interface AiAnonymizeResponse {
  text: string;
  documents: Array<{
    id: string;
    original_filename: string;
    filename: string;
    kind: string;
    text: string;
    chars: number;
  }>;
  anonymization: Record<string, unknown>;
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

/**
 * `overwrite` is opt-in and explicit: an analyst who classified the business by
 * hand and then ran the agent did not ask to have that reconsidered.
 */
const ApplyProfileBody = z.object({ overwrite: z.boolean().default(false) }).default({ overwrite: false });

/**
 * What an operator hands the anonymizer: pasted text, uploaded documents, or
 * both, plus any names they know that we do not.
 *
 * `known_people` is the field that carries the feature. The issuer's name comes
 * off the engagement automatically and the regexes find emails and phones on
 * their own, but a cap table's holders are the most identifying rows on it and
 * they appear as bare names in a column — no honorific, no "Prepared by",
 * nothing a pattern can key on. Somebody has to say who they are, and this is
 * where they say it.
 */
const AnonymizeBody = z
  .object({
    text: z.string().max(200_000).default(''),
    document_ids: z.array(z.string()).max(MAX_AI_DOCUMENTS).default([]),
    known_companies: z.array(z.string().min(1).max(200)).max(200).default([]),
    known_people: z.array(z.string().min(1).max(200)).max(200).default([]),
  })
  .default({ text: '', document_ids: [], known_companies: [], known_people: [] });

function actorFor(principal: Principal): EventActor {
  return { actorType: 'ai', actorId: principal.id, source: 'ai-service' };
}

/**
 * Reads the eligible documents and base64s them for the AI service.
 *
 * A blob that will not read is skipped rather than failing the run, which is
 * right — one unreadable upload should not cost a firm its whole analysis — and
 * was silent, which is not. The skip changes what the model is reasoning from:
 * the run goes ahead on fewer documents than the firm uploaded and produces a
 * confident answer from the smaller set, with nothing anywhere recording that
 * the set was smaller. That is the same shape as a false empty state, one tier
 * down — a discarded failure re-presented as a fact about the data.
 *
 * It also hides the failure that is worth waking up for. `decodeFromStorage`
 * is envelope decryption, so a key that has gone wrong does not drop one
 * document, it drops every document on every run, and the only outward sign
 * would have been analyses that had quietly stopped citing anything.
 *
 * Logged per document (so the cause is on the line) and tallied (so a
 * one-off is visibly different from all of them). The filename is deliberately
 * not logged: this platform's uploads are offer letters and board consents, and
 * their names carry the people in them.
 */
export async function encodeDocuments(
  documentsDir: string,
  docs: DocumentRow[],
  log?: FastifyBaseLogger,
): Promise<Array<Record<string, unknown>>> {
  const eligible = docs
    .filter((d) => EXTRACTABLE_EXTENSIONS.has(path.extname(d.filename).toLowerCase()))
    .filter((d) => Number(d.size_bytes) <= MAX_AI_DOCUMENT_BYTES)
    .slice(0, MAX_AI_DOCUMENTS);
  const encoded: Array<Record<string, unknown>> = [];
  const unreadable: string[] = [];
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
    } catch (err) {
      unreadable.push(doc.id);
      log?.warn({ err, documentId: doc.id, kind: doc.kind }, 'document unreadable — excluded from AI input');
    }
  }
  if (unreadable.length > 0) {
    log?.warn(
      { unreadable: unreadable.length, eligible: eligible.length, sent: encoded.length },
      'AI input is missing documents',
    );
  }
  return encoded;
}

export interface AiPipelineDeps {
  pool: pg.Pool;
  aiUrl: string;
  documentsDir: string;
  /**
   * Optional so the many test call sites need not supply one. Used to report
   * extracted figures that failed validation — an auto-pipeline run has no
   * response for them to appear in.
   */
  log?: FastifyBaseLogger;
}

/**
 * Runs one AI pipeline end-to-end: prompt-registry lookup, document encoding,
 * the AI-service call, job persistence, and (extract only) auto-applying the
 * engine inputs to params. Shared by the interactive route below and the
 * auto-pipeline orchestrator. Any failure of the call completes the job as
 * 'failed' and re-throws for the caller to map — no row is left in flight.
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
): Promise<{
  job: AiJobRow;
  appliedInputs: Record<string, unknown> | null;
  rejectedInputs: RejectedInput[];
}> {
  const { valuation, pipeline } = args;
  const params = await findParams(deps.pool, valuation.id);
  // A page, and that is what the model gets. `encodeDocuments` already spends
  // a bounded character budget over whatever it is handed, so the corpus was
  // never "every file" — the cap makes the bound explicit instead of leaving
  // it to whichever document the budget happened to run out on.
  const { documents } = await listDocuments(deps.pool, valuation.id);

  // Registry-managed prompt: the stored system prompt + model binding ride
  // along so admins can tune pipelines without a deploy (Bot Prompts view).
  const promptRow = await findPromptByPipeline(deps.pool, pipeline);
  // On/off toggle (migration 0060): a disabled agent is refused before any job
  // is created or LLM call is made.
  if (promptRow && promptRow.enabled === false) {
    throw problems.unprocessable(`The "${pipeline}" agent is disabled`);
  }
  const promptVersion = promptRow ? await latestPromptVersion(deps.pool, promptRow.id) : null;

  // The narrative agent's *sections* are a second, per-report-type registry
  // (migration 0114). Only that pipeline reads them, and only it pays for the
  // query. Null on an un-migrated database, where the agent's built-in eight
  // are the correct fallback.
  let narrativeSections: Array<{ key: string; label: string; guidance: string }> | null = null;
  // The market research this deliverable was drafted from (migration 0116).
  // Only the narrative agent receives it, and only grounded rows travel — see
  // `narrativeResearchPayload`. This is where the research adapter's value is
  // actually collected: everything upstream of it is plumbing.
  let researchPayload: ReturnType<typeof narrativeResearchPayload> = null;
  // The structured company profile (migration 0151). The `company_overview`
  // section has always been asked for what the company does with nothing in
  // front of the model that says it — the calculation carries share counts and
  // discount rates, not a business description — so it was drafted from
  // whatever the params implied. Null until somebody fills the profile, by hand
  // or from the `company_profile` agent.
  let profilePayload: Record<string, unknown> | null = null;
  if (pipeline === 'report_narrative') {
    const [rows, researchPage, profile] = await Promise.all([
      listNarrativePromptsForKind(deps.pool, valuation.kind),
      listMarketResearch(deps.pool, valuation.id),
      findCompanyProfile(deps.pool, valuation.id),
    ]);
    narrativeSections = narrativeSectionsPayload(rows, valuation.kind);
    // The live rows only — one per (topic, region), so this branch is bounded
    // by the two enums and the page never bites.
    researchPayload = narrativeResearchPayload(researchPage.research);
    profilePayload = narrativeProfilePayload(profile);
  }

  // The tag vocabulary, for the one agent whose prompt needs a platform
  // constant rather than the engagement's own material. Shipped from here
  // because the AI service holds no copy of it: the catalogue is the analyst's
  // tooltip and the model's specification at once, and a second copy would be
  // silently wrong the first time a tag was added on this side.
  const tagCatalogue = pipeline === 'tagging' ? tagCataloguePayload() : null;

  const payload = {
    valuation: {
      id: valuation.id,
      kind: valuation.kind,
      company_name: valuation.company_name,
      currency: valuation.currency,
      service_countries: valuation.service_countries,
    },
    params,
    documents:
      args.includeDocuments === false ? [] : await encodeDocuments(deps.documentsDir, documents, deps.log),
    prompt: promptRow ? { system: promptRow.system_prompt, model: promptRow.model } : null,
    ...(narrativeSections ? { narrative_sections: narrativeSections } : {}),
    ...(researchPayload ? { market_research: researchPayload } : {}),
    ...(profilePayload ? { company_profile: profilePayload } : {}),
    ...(tagCatalogue ? { tag_catalogue: tagCatalogue } : {}),
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
  let response: AiPipelineResponse;
  try {
    response = await postJson<AiPipelineResponse>(
      'ai-service',
      `${deps.aiUrl}/ai/v1/pipelines/${pipeline}`,
      payload,
      {
        timeoutMs: AI_PIPELINE_TIMEOUT_MS,
        record: { valuationId: valuation.id, name: `ai ${pipeline}` },
      },
    );
  } catch (err) {
    /*
     * Any failure of the call closes the row (round 186, methodology M5).
     *
     * This used to settle the job only for an `InternalServiceError`, and
     * rethrow everything else over a row left at `status = 'running'`. Nothing
     * ever comes back for one of those: `ai_jobs` had no reaper, `due_at` on
     * the unified job feed is the row's `created_at`, and `oldestActiveJobs`
     * counts anything active and due. So a single non-upstream throw — the
     * breaker's `acquire` raising something other than `CircuitOpenError`, an
     * `AbortError` escaping the fetch, an out-of-memory on a large payload —
     * produced a job that reads as in flight forever, ages forever, and opens a
     * queue-stall alert that cannot be resolved by anything except a DELETE.
     *
     * Settling the row and publishing a *message* are separate questions, and
     * conflating them is what produced the narrowing. Whether the run is over
     * does not depend on the error's class: it is over. Whether its wording can
     * be shown to somebody does — `error` is read back onto the AI tab and the
     * ops job feed, and `errorBodyDisclosure` states one rule for every
     * property that reaches a person: text taken from a caught error is
     * publishable only when something vouched for it. An `InternalServiceError`
     * carries a detail the upstream wrote for a caller to read; a bare throw
     * carries one written for whoever is holding the stack, constraint names
     * and internal topology included. So the row is always settled, only the
     * vouched-for wording is stored, and the rest is in the log line the caller
     * already writes around this.
     *
     * Best-effort, and the original error is what propagates. A settlement
     * write that itself fails leaves the row for the reaper, which is exactly
     * the case the reaper exists for.
     */
    await completeAiJob(
      deps.pool,
      job,
      {
        status: 'failed',
        error:
          err instanceof InternalServiceError ? err.message : 'the run ended before the AI service answered',
        latencyMs: Date.now() - startedAt,
      },
      args.actor,
    ).catch((settleErr: unknown) => {
      deps.log?.error(
        { err: settleErr, cause: err, jobId: job.id, valuationId: valuation.id },
        'could not record a failed AI job; left running for the reaper',
      );
    });
    throw err;
  }

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
  //
  // Nobody is watching this one — the auto-pipeline runs it on upload — so
  // it is the path that most needs the values checked against the same
  // bounds hand-entry enforces. `sanitizeExtractedInputs` drops the figures
  // an analyst could not have typed and reports them rather than the whole
  // extraction being lost to one bad field.
  let appliedInputs: Record<string, unknown> | null = null;
  let rejectedInputs: RejectedInput[] = [];
  if (pipeline === 'extract' && args.autoApply) {
    const { applied, rejected } = sanitizeExtractedInputs(response.result?.engine_inputs);
    rejectedInputs = rejected;
    if (rejected.length > 0) {
      deps.log?.warn(
        { valuationId: valuation.id, jobId: job.id, rejected },
        'ai extraction proposed engine inputs outside the accepted range; dropping them',
      );
    }
    if (Object.keys(applied).length > 0) {
      appliedInputs = applied;
      await applyEngineInputs(deps.pool, valuation.id, applied, args.actor);
    }
  }
  return { job: completed, appliedInputs, rejectedInputs };
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
    if (NON_RUNNABLE_PIPELINES.has(pipeline as AiPipeline)) {
      // The research prompts are registry rows, not pipelines this route can
      // run. Their route builds the question from public fields only and
      // persists the answer with its citations; this one would do neither.
      throw problems.unprocessable(
        `"${pipeline}" is a research prompt — run it via POST /valuations/:id/research`,
      );
    }
    const typedPipeline = pipeline as AiPipeline;
    const valuation = await loadValuation(id);
    // A retired engagement does not spend the firm's AI budget. Checked before
    // the body is parsed, so the answer names the state of the file rather than
    // whatever else the request got wrong.
    refuseIfRetired(valuation, 'running AI pipelines');
    const { documents } = await listDocuments(deps.pool, id);

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
    if (!body.success) throw invalidBody('Invalid options', body.error);

    // Merge the auto-attached calculation with any caller-supplied agent context.
    const merged = { ...(extraPayload ?? {}), ...(body.data.context ?? {}) };

    try {
      const { job, appliedInputs, rejectedInputs } = await runAiPipeline(deps, {
        valuation,
        pipeline: typedPipeline,
        anonymize: body.data.anonymize,
        autoApply: body.data.auto_apply,
        createdBy: principal.id,
        actor: actorFor(principal),
        extraPayload: Object.keys(merged).length > 0 ? merged : undefined,
      });
      return reply.status(201).send({ job, applied_inputs: appliedInputs, rejected_inputs: rejectedInputs });
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
    refuseIfRetired(await loadValuation(id), 'applying AI results');

    const job = await latestSucceededJob(deps.pool, id, 'extract');
    const extracted = job?.result?.engine_inputs;
    if (!extracted || typeof extracted !== 'object' || Object.keys(extracted).length === 0) {
      throw problems.unprocessable(
        'No successful extraction with engine inputs to apply — run data extraction first',
      );
    }
    // Same bounds as hand-entry; see sanitizeExtractedInputs. A stored job can
    // predate that check, so it is applied on read rather than trusted.
    const { applied, rejected } = sanitizeExtractedInputs(extracted);
    if (Object.keys(applied).length === 0) {
      throw problems.unprocessable(
        'Every extracted engine input is outside the accepted range — review the extraction before applying it',
        { rejected },
      );
    }
    const params = await applyEngineInputs(deps.pool, id, applied, actorFor(principal));
    return { params, applied_inputs: applied, rejected_inputs: rejected, source_job_id: job!.id };
  });

  /**
   * Apply the latest successful `comp_selection` run to the peer set.
   *
   * The manual twin of `/ai/extract/apply`, and the half of AI comparable
   * discovery that was missing: the agent has suggested, verified and refined a
   * guideline set since it was written, and the answer stayed in `ai_jobs`.
   * `COMPARABLE_SOURCES` has carried `'ai'` with no caller that writes one, so
   * the market approach never saw a comp the agent found unless somebody
   * retyped it.
   *
   * `replaceMachineComparables` is what makes this safe to run twice: it carries
   * the analyst's include/exclude decisions forward by ticker and leaves their
   * own rows alone, so re-applying a re-run of the agent refreshes the data
   * without re-admitting a comp somebody excluded on purpose.
   */
  app.post(
    '/api/v1/valuations/:id/ai/comp_selection/apply',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      if (!isOps(principal)) throw problems.forbidden('AI pipelines are operations-only');
      const { id } = req.params as { id: string };
      const valuation = await loadValuation(id);
      refuseIfRetired(valuation, 'applying AI results');

      const job = await latestSucceededJob(deps.pool, id, 'comp_selection');
      if (!job) {
        throw problems.unprocessable(
          'No successful comparable-selection run to apply — run the comp_selection agent first',
        );
      }

      let mapped: MappedComparableSet;
      try {
        // The moment the figures were observed is the moment the engine was
        // asked for them, which is the run — not now. Stamping a row applied
        // six weeks later with today's date would date month-old multiples to
        // this morning.
        mapped = mapAgentComparables(job.result, job.completed_at ?? job.created_at);
      } catch (err) {
        if (err instanceof AiComparablesError) throw problems.unprocessable(err.message);
        throw err;
      }

      const written = await replaceMachineComparables(deps.pool, id, 'ai', mapped.rows);
      await recordAdminEvent(deps.pool, {
        type: 'comparables_ai_applied',
        actor: { actorType: 'human', actorId: principal.id },
        subjectType: 'valuation',
        subjectId: valuation.id,
        subjectLabel: valuation.company_name,
        payload: { ...mapped.summary, written: written.length, source_job_id: job.id },
      });

      const { items, truncated } = await listComparableItems(deps.pool, id);
      return {
        comparables: items.map(presentComparable),
        statistics: summarizeSet(items),
        truncated,
        page_limit: COMPARABLE_PAGE_LIMIT,
        applied: mapped.summary,
        written: written.length,
        source_job_id: job.id,
      };
    },
  );

  /**
   * Apply the latest successful `company_profile` run to the company profile.
   *
   * The agent drafts the business description, the SIC / NAICS classification
   * and the scale metrics from the engagement's own documents (migrations
   * 0151/0152); this writes the four typed fields into `company_profiles`,
   * where the workbook, the HMRC forms, the package view and the narrative
   * agent's company section all read them.
   *
   * Blanks only, unless `overwrite` says otherwise — see `draftFromAgentResult`.
   * The metrics and the ranked runner-up codes stay in the job result rather
   * than being written anywhere: they are the analyst's evidence for the choice,
   * and the profile has one field per answer.
   */
  app.post(
    '/api/v1/valuations/:id/ai/company_profile/apply',
    { preHandler: app.authenticate },
    async (req) => {
      const principal = requirePrincipal(req);
      if (!isOps(principal)) throw problems.forbidden('AI pipelines are operations-only');
      const { id } = req.params as { id: string };
      refuseIfRetired(await loadValuation(id), 'applying AI results');

      const body = ApplyProfileBody.safeParse(req.body ?? {});
      if (!body.success) {
        throw invalidBody('Invalid options', body.error);
      }

      const job = await latestSucceededJob(deps.pool, id, 'company_profile');
      if (!job) {
        throw problems.unprocessable(
          'No successful company-profile run to apply — run the company_profile agent first',
        );
      }

      const existing = await findCompanyProfile(deps.pool, id);
      let draft: ProfileDraft;
      try {
        draft = draftFromAgentResult(job.result, existing, { overwrite: body.data.overwrite });
      } catch (err) {
        if (err instanceof AiCompanyProfileError) throw problems.unprocessable(err.message);
        throw err;
      }

      const profile = await upsertCompanyProfile(deps.pool, id, draft.fields, actorFor(principal));
      return {
        profile,
        applied_fields: Object.keys(draft.fields),
        skipped_fields: draft.skipped,
        source_job_id: job.id,
      };
    },
  );

  /**
   * Apply the latest successful `tagging` run to the engagement's tags —
   * 409.ai parity gap #23, and the caller `mapAgentTags` was written for.
   *
   * Everything the agent proposes lands as `suggested`, never as `accepted`,
   * and that is the whole shape of this route. A tag is a claim — the filter
   * reads it, the precedent query reasons from it, and `going_concern_doubt`
   * says which checklist a file needs — so a model's classification entering the
   * firm's records unreviewed is a claim nobody made. The analyst accepts it
   * through PATCH, which is where exclusivity is enforced and where the decision
   * gets a name against it.
   *
   * Safe to run twice, and that is `upsertValuationTag`'s asymmetric conflict
   * clause rather than anything here: an `ai` write onto a row a human has
   * already decided refreshes the model's reasoning and leaves the status alone.
   * Without it, re-running the agent after a review would reopen every question
   * the review closed — a tag rejected in March comes back as a suggestion in
   * April — which is the failure that makes people stop re-running agents.
   *
   * `unknown` is returned rather than logged. Slugs the model proposed that the
   * catalogue does not carry are a request to extend the vocabulary, and the
   * operator holding the response is the person who can act on it.
   */
  app.post('/api/v1/valuations/:id/ai/tagging/apply', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('AI pipelines are operations-only');
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id);
    refuseIfRetired(valuation, 'applying results');

    const job = await latestSucceededJob(deps.pool, id, 'tagging');
    if (!job) {
      throw problems.unprocessable('No successful tagging run to apply — run the tagging agent first');
    }

    let mapped: MappedTagSet;
    try {
      mapped = mapAgentTags(job.result);
    } catch (err) {
      if (err instanceof ValuationTagError) throw problems.unprocessable(err.message);
      throw err;
    }

    await upsertValuationTags(
      deps.pool,
      id,
      mapped.tags.map((tag) => ({
        slug: tag.slug,
        source: 'ai' as const,
        status: 'suggested' as const,
        confidence: tag.confidence,
        rationale: tag.rationale,
        evidence: tag.evidence,
      })),
      // The operator who ran the apply, not the model. `created_by` answers
      // "who caused this row to exist", and `source` already records that the
      // reasoning behind it is a model's — conflating the two would lose the
      // one fact an audit of this table is asking for.
      principal.id,
    );

    await recordAdminEvent(deps.pool, {
      type: 'valuation_tags_ai_applied',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      payload: {
        slugs: mapped.tags.map((t) => t.slug),
        unknown: mapped.unknown,
        source_job_id: job.id,
      },
    });

    // Re-read rather than returning what was written: the upsert leaves a
    // human's decision alone, so the rows that came back from it are not
    // necessarily the state of the engagement. Returning the write would report
    // every tag as `suggested` including the ones an analyst had already
    // accepted, which is a lie about what just happened.
    const rows = await listValuationTags(deps.pool, id);
    return {
      tags: rows.map(presentValuationTag),
      applied: mapped.tags.map((t) => t.slug),
      unknown: mapped.unknown,
      source_job_id: job.id,
    };
  });

  /**
   * Anonymize a cap table (or any client text) on this engagement — 409.ai
   * parity gap #22, `Ai:AnoymizeCaptable`.
   *
   * The redactor has run on every prompt this platform sends since it was
   * written, and there was no way to run it on purpose. That is the gap, and it
   * is not cosmetic: the two things an operator actually needs are to produce a
   * sample or demo report from a real engagement without its client in it, and
   * to see — before sending anything anywhere — what redaction would and would
   * not catch on this particular sheet. Both need the redacted text in hand,
   * and neither is served by a pipeline that redacts on its way to asking a
   * model something else.
   *
   * The issuer's name is supplied from the engagement rather than typed,
   * because the one entity guaranteed to be on a 409A cap table is the company
   * the 409A is for, and an operator who forgot to type it would get a
   * confident report saying redaction was applied. The client contact's name
   * and their own stated company come along for the same reason: they are known,
   * they are on the sheet, and nothing about the request would reveal that they
   * had been missed.
   *
   * Nothing is persisted but the fact that it happened. The redacted text is a
   * work product the operator asked for and is holding; storing a second copy
   * of client material — even a struck-through one — buys nothing and adds a
   * place for it to leak from. The admin event is not optional in the same way:
   * an operator taking an extract of client documents out of the platform is
   * exactly the action an audit of this system should be able to see.
   */
  app.post('/api/v1/valuations/:id/ai/anonymize', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('AI pipelines are operations-only');
    const { id } = req.params as { id: string };
    const valuation = await loadValuation(id);
    refuseIfRetired(valuation, 'accepting changes');

    const body = AnonymizeBody.safeParse(req.body ?? {});
    if (!body.success) throw invalidBody('Invalid options', body.error);
    const { text, document_ids: documentIds, known_companies: known, known_people: people } = body.data;

    if (text.trim() === '' && documentIds.length === 0) {
      throw problems.unprocessable('Provide text or document_ids to anonymize');
    }

    // Selected by id, not "everything on the engagement". An operator
    // anonymizing a cap table for a demo wants that sheet, and shipping the
    // whole corpus would silently blow the AI service's character budget on
    // documents nobody asked about — the earlier ones would come back redacted
    // and the rest would come back truncated, with nothing saying which.
    let documents: DocumentRow[] = [];
    if (documentIds.length > 0) {
      // Looked up by id rather than filtered out of the list. Answering this
      // from a capped page turns a document that is on the valuation into one
      // the caller is told is not — a refusal naming ids the user can see on
      // the screen they copied them from.
      const byId = await findDocumentsByIds(deps.pool, documentIds);
      for (const [docId, doc] of byId) {
        if (doc.valuation_id !== id || doc.deleted_at !== null) byId.delete(docId);
      }
      const missing = documentIds.filter((docId) => !byId.has(docId));
      if (missing.length > 0) {
        // Named rather than skipped: a request that asked for four documents
        // and silently anonymized three is the shape of an accident.
        throw problems.unprocessable('Some documents are not on this valuation', { missing });
      }
      documents = documentIds.map((docId) => byId.get(docId)!);
    }
    const encoded = await encodeDocuments(deps.documentsDir, documents, deps.log);
    if (documents.length > 0 && encoded.length === 0) {
      throw problems.unprocessable(
        'None of the selected documents are in a text-extractable format under the size limit',
      );
    }

    // The engagement's own contact. A failed lookup is not worth refusing the
    // request over — the issuer name and the operator's own list still travel —
    // but it does change what gets struck, so the response says how many
    // entities were actually applied rather than letting the caller assume.
    const client = await findUserById(deps.pool, valuation.user_id).catch(() => null);
    const clientName = [client?.first_name, client?.last_name].filter(Boolean).join(' ').trim();

    const companyNames = [
      ...new Set([valuation.company_name, ...(client?.company_name ? [client.company_name] : []), ...known]),
    ].filter((name) => name.trim() !== '');
    const personNames = [...new Set([...(clientName ? [clientName] : []), ...people])];

    let result: AiAnonymizeResponse;
    try {
      result = await postJson<AiAnonymizeResponse>(
        'ai-service',
        `${deps.aiUrl}/ai/v1/anonymize`,
        { text, documents: encoded, company_names: companyNames, person_names: personNames },
        {
          timeoutMs: AI_ANONYMIZE_TIMEOUT_MS,
          record: { valuationId: valuation.id, name: 'ai anonymize' },
        },
      );
    } catch (err) {
      if (err instanceof InternalServiceError) throw toProblem(err);
      throw err;
    }

    await recordAdminEvent(deps.pool, {
      type: 'cap_table_anonymized',
      actor: { actorType: 'human', actorId: principal.id },
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      // Counts and ids only. The payload of an audit record about handling
      // client text must not itself be a copy of that text.
      payload: {
        document_ids: documents.map((d) => d.id),
        text_chars: text.length,
        known_companies: companyNames.length,
        known_people: personNames.length,
        redacted: result.anonymization?.redacted ?? {},
      },
    });

    return {
      text: result.text,
      documents: result.documents,
      anonymization: result.anonymization,
      known_entities: { companies: companyNames.length, people: personNames.length },
    };
  });

  app.get('/api/v1/valuations/:id/ai', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('AI pipelines are operations-only');
    const { id } = req.params as { id: string };
    await loadValuation(id);
    return listAiJobs(deps.pool, id);
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
