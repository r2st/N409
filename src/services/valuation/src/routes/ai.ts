import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, logFailure, problems } from '@n409/shared';
import { canReadReport, canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import {
  AI_PIPELINES,
  CALCULATION_DEPENDENT_PIPELINES,
  DOCUMENT_DEPENDENT_PIPELINES,
  NON_RUNNABLE_PIPELINES,
  type AiPipeline,
} from '../domain/pipeline.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { latestCalculationForKind, type CalculationRow } from '../repos/calculations.js';
import { applyEngineInputs, findParams } from '../repos/params.js';
import { sanitizeExtractedInputs, type RejectedInput } from './engineInputs.js';
import { findDocumentsByIds, listDocuments, type DocumentRow } from '../repos/documents.js';
import { findRedactionIdentity, findUserById } from '../repos/users.js';
import {
  isIdentityUnavailable,
  ownerRedactionEntities,
  redactionIdentityState,
  type RedactionIdentityResult,
} from '../domain/redactionIdentity.js';
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
import { describeForUser, InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { readStoredBlob } from '../storage/blobFile.js';
import { requirePrincipal } from '../plugins/auth.js';
import { kindLabel } from '../domain/valuationSelector.js';
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
import { quoteForMessage } from '../domain/displayText.js';

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

/**
 * The most base64 this service will put in one AI request.
 *
 * The two caps above bound each document and how many of them go, and nothing
 * bounded the two multiplied together: ten documents at the per-file ceiling is
 * 50 MB of blob, which base64 makes 66.7 MB of JSON. The AI service refuses a
 * request body over 32 MiB (`limits.py`, `MAX_REQUEST_BODY_BYTES`), so five
 * five-megabyte uploads on one engagement — a cap table, two board consents and
 * two offer letters is not an unusual set — were a 413 the moment the pipeline
 * ran. A 413 is not retryable, so the run failed permanently, and what an
 * analyst saw was the AI step failing on an engagement whose only distinguishing
 * feature was that it had documents on it.
 *
 * Two ceilings written on opposite sides of a wire, each sound on its own, with
 * nothing stating the relationship: the sender's own maximum was twice what the
 * receiver would take. This is that relationship, written on the sending side
 * because that is the side that can do something about it.
 *
 * 24 MiB rather than the whole 32: the request also carries the params, the
 * narrative sections, the market research, the company profile and the tag
 * catalogue, and a budget with no headroom for those is the same bug with a
 * smaller margin.
 */
export const MAX_AI_REQUEST_DOCUMENT_BYTES = 24 * 1024 * 1024;

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

/**
 * The payload keys `context` may not name (round 271, methodology M6).
 *
 * `context` is deliberately opaque — that is what lets a new agent take new
 * context without a route change — and it was spread over the payload *last*,
 * which made "opaque" mean "authoritative". Every key this route establishes
 * from the engagement and the prompt registry was a key an authenticated
 * analyst could replace on their own run:
 *
 *   - `prompt`. The AI tier reads `payload["prompt"]["system"]` and
 *     `["model"]` (`_prompt_overrides`, ai/app/pipelines.py) and falls back to
 *     the built-in only when they are absent. So `context.prompt` handed a
 *     tenant user the system prompt — the admin-managed Bot Prompts row is
 *     what the job's `prompt_version` then records, naming a prompt that did
 *     not run — and the model id, which at the time was not allow-listed
 *     downstream either (`configured_models` put the preferred id first), so
 *     any model on the estate's own OpenRouter key was one request away. Round
 *     275 closed that second half at the tier that holds the key
 *     (`openrouter.assert_allowed`); this refusal is still the first door, and
 *     the one that keeps the job record honest about what ran.
 *   - `options`, which carries `anonymize` and the redaction entity lists this
 *     route resolves from the engagement owner. Emptying them left the job row
 *     saying `redaction_identity: 'read'` about a run that was told nothing.
 *   - `documents`, `valuation`, `params` and the research/profile blocks: the
 *     run's record of what it was given, contradicted by what it was sent.
 *
 * Refused by name rather than dropped quietly, because a caller who sent one
 * meant something by it, and the answer to "why did my prompt not apply" must
 * not be silence. The payload spread is ordered so the server's keys win in any
 * case — a rule that holds even if this list is ever short of a key.
 */
const SERVER_OWNED_PAYLOAD_KEYS = [
  'valuation',
  'params',
  'documents',
  'prompt',
  'narrative_sections',
  'market_research',
  'company_profile',
  'tag_catalogue',
  'options',
  /*
   * Not in the literal below — the route attaches it from
   * `latestCalculationForKind` for the calculation-dependent pipelines — but
   * server-established all the same, and the merge there put caller context
   * over it. A QA or explain run reviewing a calculation the caller wrote is
   * not reviewing the engagement's.
   */
  'calculation',
] as const;
const SERVER_OWNED_PAYLOAD_KEY_SET: ReadonlySet<string> = new Set(SERVER_OWNED_PAYLOAD_KEYS);

const RunBody = z
  .object({
    // Cap-table anonymization (PII redaction) is on unless explicitly disabled.
    anonymize: z.boolean().default(true),
    // extract only: apply the extracted engine inputs to params on success.
    auto_apply: z.boolean().default(false),
    // Agent-specific context (comp_context, company_profile, comparables,
    // methodology, prior_valuation, new_data, ...) passed straight to the AI
    // service. Kept opaque here so new agents don't need a route change —
    // opaque, but not authoritative: see SERVER_OWNED_PAYLOAD_KEYS.
    context: z
      .record(z.unknown())
      .superRefine((ctx, refine) => {
        for (const key of Object.keys(ctx)) {
          if (!SERVER_OWNED_PAYLOAD_KEY_SET.has(key)) continue;
          refine.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `context may not set '${key}' — this run establishes it from the engagement and the prompt registry, and the job's record is written from it`,
          });
        }
      })
      .optional(),
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
  const overBudget: string[] = [];
  let budgetUsed = 0;
  for (const doc of eligible) {
    try {
      const stored = await readFile(path.join(documentsDir, doc.storage_path));
      // `readStoredBlob`, not a bare `decodeFromStorage` (round 223). The
      // decryption half only detects damage on a deployment that has a key:
      // where `DOCUMENTS_ENCRYPTION_KEY` is unset, `decodeFromStorage` returns
      // whatever is on disk, so a blob that had been truncated or had a bit
      // flipped went to the model as the document, under its right filename
      // and content type, and whatever the model then read out of it was
      // auto-applied to the engagement's parameters. `documents.sha256` is
      // taken over the plaintext at upload and is the only detector there is.
      // The download route has refused these since round 197; this path, which
      // is the one that feeds a valuation, did not.
      const buf = readStoredBlob(doc, stored, log);
      // Base64 is four characters per three bytes, and the JSON string that
      // carries it needs no escaping — so this is the number of bytes the
      // request will actually weigh, not an estimate of it.
      const encodedBytes = Math.ceil(buf.length / 3) * 4;
      if (budgetUsed + encodedBytes > MAX_AI_REQUEST_DOCUMENT_BYTES) {
        // Skipped rather than sent, because sending it makes the *whole*
        // request a 413 and this engagement's analysis fails on every attempt.
        // Recorded for the same reason the unreadable ones are: the run goes
        // ahead on a smaller set than the firm uploaded.
        overBudget.push(doc.id);
        continue;
      }
      budgetUsed += encodedBytes;
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
  if (overBudget.length > 0) {
    log?.warn(
      {
        overBudget: overBudget.length,
        eligible: eligible.length,
        sent: encoded.length,
        budgetBytes: MAX_AI_REQUEST_DOCUMENT_BYTES,
      },
      'AI input truncated to the request budget',
    );
  }
  return encoded;
}

export interface AiPipelineDeps {
  pool: pg.Pool;
  aiUrl: string;
  documentsDir: string;
  /**
   * Required, and required for a reason this interface once got wrong.
   *
   * It was optional — "so the many test call sites need not supply one" — and
   * the many test call sites turned out to be one. What the option bought
   * instead was a *production* wiring that omitted it: `registerQaRoutes` was
   * handed `{ pool, aiUrl, documentsDir }` and nothing else, so every line
   * below written through `deps.log?.` vanished on the QA pipeline. Not the
   * chatty ones: the run whose failure could not be recorded and was left for
   * the reaper, the run that came back after its job had already been settled,
   * and — since round 233 — the lookup that decides whether the engagement
   * owner's name is struck from the prompt. That last one is the only evidence
   * a prompt went to an external model naming a person, and on this route there
   * was none.
   *
   * A logger that a caller may leave out is a log line that a caller may leave
   * out, and nothing fails when they do. Making it required moves the question
   * to the compiler, which is where the one wiring that got it wrong would have
   * been told.
   */
  log: FastifyBaseLogger;
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

  /*
   * The names the redactor cannot find on its own.
   *
   * `anonymize.py` strikes two kinds of thing: what a pattern can key on
   * (emails, phone numbers, SSNs, honorific-led names) and what the caller
   * *declares*. A bare personal name in a cap table column matches no pattern —
   * "no honorific, no 'Prepared by', nothing a pattern can key on", as
   * `AnonymizeBody` puts it — so declaring it is the only way it is struck.
   *
   * The pipeline payload declared nothing. `_known_entities` reads the subject
   * company off `valuation.company_name` and then looks for
   * `options.known_companies` / `options.known_people`, which only
   * `/ai/anonymize` has ever sent. So every pipeline run — the cap-table agent
   * reading a synced holder list, the extraction pass over an uploaded
   * spreadsheet, the narrative agent — shipped the engagement owner's name and
   * the employer they named at signup to an external model in the clear, while
   * the operator's preview of the *same documents* struck both.
   *
   * Best-effort, like the preview's: a lookup that fails must not cost the run.
   * It does change what is struck, so the failure is logged rather than
   * swallowed — "redaction was applied" and "these entities were applied" are
   * different claims, and this is the one place they can come apart.
   */
  const client: RedactionIdentityResult = await findRedactionIdentity(deps.pool, valuation.user_id).catch(
    (err: unknown) => {
      deps.log.warn(
        { err, valuationId: valuation.id, pipeline },
        'could not read the engagement owner for prompt redaction; their name is not being struck',
      );
      return 'unavailable' as const;
    },
  );
  const { companies: knownCompanies, people: knownPeople } = ownerRedactionEntities(client);

  /*
   * What actually goes to the model, and — below — what the job row says went.
   *
   * These were two different sets. `createAiJob` recorded `document_ids` off
   * `documents`, the engagement's whole corpus, while the payload carried
   * `encodeDocuments`'s output: the extractable formats, under the per-file
   * ceiling, up to ten of them, within the request byte budget, minus anything
   * that would not read. And on the QA and narrative runs, which pass
   * `includeDocuments: false` because those agents judge outputs rather than
   * sources, the payload carried *nothing* while the row still listed every
   * file on the engagement.
   *
   * The field's own comment is "which docs went in". A defensibility record
   * naming documents a run never saw is worse than one naming none: it is the
   * evidence somebody would reach for to say what an extraction was drawn
   * from. `encodeDocuments` already logs each drop; this is the same fact
   * written where it is read back.
   */
  const encoded =
    args.includeDocuments === false ? [] : await encodeDocuments(deps.documentsDir, documents, deps.log);

  const payload = {
    /*
     * Caller context first, so every key below wins over it. `context` is
     * validated against SERVER_OWNED_PAYLOAD_KEYS at the route, and this
     * ordering is the same rule stated where the payload is actually built:
     * an agent-specific block may be added here, never substituted for the
     * run's own account of what it was given.
     */
    ...(args.extraPayload ?? {}),
    valuation: {
      id: valuation.id,
      kind: valuation.kind,
      company_name: valuation.company_name,
      currency: valuation.currency,
      service_countries: valuation.service_countries,
    },
    params,
    documents: encoded,
    prompt: promptRow ? { system: promptRow.system_prompt, model: promptRow.model } : null,
    ...(narrativeSections ? { narrative_sections: narrativeSections } : {}),
    ...(researchPayload ? { market_research: researchPayload } : {}),
    ...(profilePayload ? { company_profile: profilePayload } : {}),
    ...(tagCatalogue ? { tag_catalogue: tagCatalogue } : {}),
    options: {
      anonymize: args.anonymize,
      known_companies: knownCompanies,
      known_people: knownPeople,
    },
  };

  const job = await createAiJob(deps.pool, {
    valuationId: valuation.id,
    pipeline,
    // Persist provenance, not payloads: which docs went in, not their bytes.
    input: {
      document_ids: encoded.map((d) => String(d.id)),
      // How much of the corpus that was, so a reader can tell "the engagement
      // had nothing on it" from "the run was sent a subset" without going to
      // the log line that says which.
      documents_on_file: documents.length,
      company_name: valuation.company_name,
      /*
       * Whether the redactor was told who the engagement is for (round 269,
       * methodology M2).
       *
       * The lookup above is best-effort by design, and its failure changes what
       * left the building: the owner's name and the employer they named at
       * signup go to an external model unstruck. What the run's record then
       * said about it was `declared: {people: 0}` — the same record produced by
       * an account with no name on file, which is an ordinary and permanent
       * shape (`users.first_name` is nullable). So the one reading that means
       * "redaction was short an entity it was supposed to have" was indistin-
       * guishable from the two that do not, on the row a defensibility question
       * is answered from, with only a log line to say otherwise.
       *
       * Written on every run rather than only on the failure, because absence
       * would then be a fourth value meaning "this run predates the field".
       */
      redaction_identity: redactionIdentityState(client),
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
     * R277: "carries a detail the upstream wrote for a caller to read" is true
     * of an `InternalServiceError` only when `opaque` is false, and that flag
     * exists because it often is not — a pydantic error list echoing the
     * payload, a traceback, a proxy's HTML page. `err.message` is
     * `${service}: ${detail}` with nothing consulted, so what was stored on
     * those runs was exactly the text the flag withholds from a 502, in a
     * column that is redrawn every time the job feed is listed.
     * `describeForUser` is the one thing that asks.
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
          err instanceof InternalServiceError
            ? describeForUser(err)
            : 'the run ended before the AI service answered',
        latencyMs: Date.now() - startedAt,
      },
      args.actor,
    ).catch((settleErr: unknown) => {
      deps.log.error(
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
  //
  // Only when this worker is the one that ended the run. `completeAiJob`
  // refuses to write a second ending over the reaper's (round 224) and hands
  // back the ending that stands — but the *write* this run came to make sat
  // below that guard and fired regardless. A run reaped at fifteen minutes
  // whose worker came back at sixteen therefore set the engagement's engine
  // inputs from a run the audit trail records as failed: `params_updated` with
  // an `ai` actor, a changed volatility, and no successful job anywhere to
  // account for it. Whoever went looking would find the run that produced
  // those figures marked `reaped`.
  //
  // Guarding the effect with the same rule as the status keeps the two
  // together: the ending that stands decides whether the work counts. The
  // figures go with the run — the row carries the reaper's ending and no
  // result, so `/ai/extract/apply` cannot reach them either — and the remedy
  // is the one the trail already implies, which is to run it again.
  let appliedInputs: Record<string, unknown> | null = null;
  let rejectedInputs: RejectedInput[] = [];
  if (completed.status !== 'succeeded') {
    deps.log.warn(
      {
        valuationId: valuation.id,
        jobId: job.id,
        pipeline,
        status: completed.status,
        autoApply: args.autoApply,
      },
      'AI run finished after its job had already been settled; nothing applied',
    );
  } else if (pipeline === 'extract' && args.autoApply) {
    const { applied, rejected } = sanitizeExtractedInputs(response.result?.engine_inputs);
    rejectedInputs = rejected;
    if (rejected.length > 0) {
      deps.log.warn(
        { valuationId: valuation.id, jobId: job.id, rejected },
        'ai extraction proposed engine inputs outside the accepted range; dropping them',
      );
    }
    if (Object.keys(applied).length > 0) {
      /*
       * The engagement as it stands now, not as it stood when the run started.
       *
       * `refuseIfRetired` fires on the route before the payload is assembled,
       * and on the auto-pipeline immediately before this call — and then the AI
       * service is given up to three minutes. Somebody withdrawing the
       * engagement inside that window is the ordinary case rather than the
       * exotic one: a run is exactly the length of time in which a decision
       * about a file gets made. R232 closed the same shape one step earlier,
       * where a queued run held a copy of the engagement as old as the queue;
       * this is the step after it, and it is the one that writes.
       *
       * Nobody is watching this write. It is the auto-pipeline's, it lands as
       * `params_updated` with an `ai` actor, and it is precisely what every
       * button in the product has stopped accepting — an extraction applied to
       * work the firm has withdrawn, with the run that produced it recorded as
       * having succeeded.
       *
       * Skipped rather than raised: the job itself is finished and correctly
       * recorded, and turning a completed run into an error would lose that.
       * The response reports nothing applied, which is what happened.
       */
      const live = await findValuationById(deps.pool, valuation.id);
      if (!live || live.archived_at !== null) {
        deps.log.warn(
          { valuationId: valuation.id, jobId: job.id, deleted: !live },
          live
            ? 'the engagement was retired while the extraction ran; its engine inputs were not applied'
            : 'the engagement was deleted while the extraction ran; its engine inputs were not applied',
        );
      } else {
        appliedInputs = applied;
        await applyEngineInputs(deps.pool, valuation.id, applied, args.actor);
      }
    }
  }
  return { job: completed, appliedInputs, rejectedInputs };
}

/**
 * Refuse to build anything on a run that somebody else ended.
 *
 * `runAiPipeline` returns the ending that *stands* rather than the one this
 * worker came to write — `completeAiJob` refuses a second terminal state, and
 * hands back the row as it is. Three things put a run in that position: the
 * reaper closed it as stale, a duplicate settle beat it, or the engagement was
 * deleted underneath it and there is no row left to update at all (in which
 * case the job comes back still reading `running`).
 *
 * R232 taught the extraction auto-apply to check this, because that path
 * *writes*: an engagement's engine inputs were being set from a run the audit
 * trail records as failed. The check was written into that branch rather than
 * into the return, so the two callers that read `job.result` afterwards never
 * got it, and both quietly presented the empty result of a closed run as the
 * agent's answer:
 *
 *  - `routes/qa.ts` filed a QA review with `ai_findings: null` and no verdict,
 *    under an `ai` actor, and that review is what the publish gate consults.
 *    The AI reviewer — whose verdict can only ever tighten the outcome — had
 *    not spoken, and nothing on the review said so.
 *  - `routes/reports.ts` drafted from a null result, found no sections in it,
 *    and answered `changed: false, applied: []` — which reads as "the agent had
 *    nothing to add to your report", not as "the run was closed".
 *
 * Both are the shape this codebase keeps finding: a discarded failure
 * re-presented as a fact. Refused here so the answer names what happened and
 * the remedy, which in every case is to run it again. `runAiPipeline` has
 * already written the warn line that carries the job id.
 *
 * Not folded into `runAiPipeline` itself: the extract path deliberately returns
 * a finished-but-unusable run rather than throwing, because the job *is*
 * correctly recorded and turning that into an error would lose it. This is for
 * the callers whose whole purpose is the result.
 */
export function assertRunStood(job: AiJobRow): void {
  if (job.status === 'succeeded') return;
  throw problems.conflict(
    'This agent run was closed while it was out — its result is not on file, so nothing was drafted ' +
      'from it. Run the agent again.',
  );
}

/**
 * The `explain` run that describes this engagement as it currently stands.
 *
 * The explanation is prose about a *particular* calculation — the pipeline is
 * in `CALCULATION_DEPENDENT_PIPELINES` and the agent is asked for "what was
 * concluded and what it means", so its first paragraph states the concluded
 * equity value and the per-share figure. Nothing recorded which run it was
 * written about, and both readers simply took the newest successful one.
 *
 * So an engagement that was recomputed after its explanation was drafted —
 * a corrected input, a re-weighted approach, any second run — served the
 * superseded conclusion in plain English beside the current figures, to the
 * client, under a card headed "In plain English" with no date on it. That is
 * the report's own conclusion contradicted on the page next to it, and the
 * reader with the least means of noticing is the one it is written for.
 *
 * A run that predates the calculation it would purport to describe is
 * therefore withheld rather than shown. `stale` says which of the two reasons
 * there is nothing to render, so a caller can offer to re-run rather than
 * implying the feature was never used.
 *
 * `created_at`, not `completed_at`: what the agent saw is the calculation that
 * existed when its payload was assembled.
 */
export async function currentExplanation(
  pool: pg.Pool,
  valuation: Pick<ValuationRow, 'id' | 'kind'>,
): Promise<{ job: AiJobRow | null; stale: boolean }> {
  const [job, calculation] = await Promise.all([
    latestSucceededJob(pool, valuation.id, 'explain'),
    latestCalculationForKind(pool, valuation.id, valuation.kind),
  ]);
  if (!job) return { job: null, stale: false };
  const stale = calculation !== null && job.created_at <= calculation.created_at;
  return { job: stale ? null : job, stale };
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
      throw problems.notFound(`Unknown pipeline "${quoteForMessage(pipeline)}"`);
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

    // Agents that narrate or defend a result need a calculation to exist — and
    // it has to be a calculation of the shape this engagement is reported in.
    //
    // `latestSucceededCalculation` is the newest run of *any* shape, and a
    // specialty engagement carries two: the Calculations tab offers the
    // ordinary 409A compute on every kind, so an EMI or ASC 718 file whose
    // analyst pressed that button holds a `{ approaches, discounts, ... }` row
    // interleaved with its `{ kind, specialty }` ones in one `created_at DESC`
    // ordering. Whichever was pressed last is what these three agents were
    // handed, and all three write prose about the concluded figure: `explain`
    // states the equity value and the per-share figure in its opening
    // paragraph, `report_narrative` drafts the body of the deliverable, and
    // `audit_defense` argues for the conclusion in front of an auditor. On an
    // EMI engagement that had also been run through the 409A pipeline, each of
    // them described a §409A conclusion that is not this engagement's answer,
    // in an EMI report, with nothing on the page saying where the number came
    // from.
    //
    // `latestCalculationForKind` is the same question the deliverable itself
    // asks — the kind picks the run, rather than the last button pressed
    // quietly redefining the kind — and it is what `currentExplanation` was
    // already comparing the finished `explain` job against. The two disagreeing
    // is what let the mismatch through as current rather than stale: the job
    // was newer than the specialty run it was never shown, so the staleness
    // gate passed it.
    let extraPayload: Record<string, unknown> | undefined;
    if (CALCULATION_DEPENDENT_PIPELINES.has(typedPipeline)) {
      const calc = await latestCalculationForKind(deps.pool, id, valuation.kind);
      if (!calc) {
        // Named rather than generic: on a specialty engagement a 409A run may
        // well be sitting there succeeded, and "run a calculation" against a
        // Calculations tab that plainly shows one is a refusal nobody can act
        // on.
        throw problems.unprocessable(
          `This engagement has no “${kindLabel(valuation.kind)}” calculation yet — run one before ` +
            'running this agent, which describes the conclusion the engagement is reported on. A ' +
            'run of another kind does not answer for it.',
        );
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
    //
    // And it is logged (round 267, methodology M11). The redactor strikes only
    // what it is told, so a lookup that failed leaves the engagement owner's
    // name standing in material an operator is about to treat as anonymized —
    // and the only signal of it was a count on a 200 response, which is a
    // number nobody has an expectation for. `logFailure` picks the level: a
    // busy pool is a blip, a query that cannot run is not going to start.
    const client: RedactionIdentityResult = await findUserById(deps.pool, valuation.user_id).catch(
      (err: unknown) => {
        logFailure(
          deps.log,
          err,
          { valuationId: valuation.id },
          'engagement contact could not be read — their name will not be struck from the anonymized material',
        );
        return 'unavailable' as const;
      },
    );
    const owner = ownerRedactionEntities(client);
    /*
     * Said out loud, not left to be inferred from a count (round 269, M2).
     *
     * The panel this answers tells the operator "the company and the client
     * contact are already included", and on a failed lookup that sentence is
     * false. The response carried the *counts* of what was applied, which is
     * only a signal to a reader who knows what the number should have been —
     * and one known person short reads as nothing at all beside a list of names
     * the operator typed themselves. The material is about to be treated as
     * anonymized and forwarded, so the shortfall is stated.
     */
    const contactUnavailable = isIdentityUnavailable(client);

    const companyNames = [...new Set([valuation.company_name, ...owner.companies, ...known])].filter(
      (name) => name.trim() !== '',
    );
    const personNames = [...new Set([...owner.people, ...people])];

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
        // The audit record of an extract taken out of the platform says whether
        // the extract was short the entity nobody typed in — see above.
        contact_unavailable: contactUnavailable,
        redacted: result.anonymization?.redacted ?? {},
      },
    });

    return {
      text: result.text,
      documents: result.documents,
      anonymization: result.anonymization,
      known_entities: {
        companies: companyNames.length,
        people: personNames.length,
        contact_unavailable: contactUnavailable,
      },
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
      return { explanation: null, model: null, generated_at: null, stale: false };
    }
    const { job, stale } = await currentExplanation(deps.pool, valuation);
    return {
      explanation: job?.result ?? null,
      model: job?.model ?? null,
      generated_at: job?.completed_at ?? null,
      // True when there is an explanation on file and it describes a run the
      // engagement has since superseded — see `currentExplanation`.
      stale,
    };
  });
}
