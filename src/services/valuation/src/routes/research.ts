import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUlid, problems } from '@n409/shared';
import { canReadValuation, isOps, type Principal } from '../auth/rbac.js';
import { InternalServiceError, postJson, toProblem } from '../clients/internal.js';
import { requirePrincipal } from '../plugins/auth.js';
import { findValuationById, type ValuationRow } from '../repos/valuations.js';
import { findParams } from '../repos/params.js';
import { findCompanyProfile } from '../repos/companyProfiles.js';
import { listOverwrites } from '../repos/overwrites.js';
import { findPromptByPipeline } from '../repos/aiPrompts.js';
import { listMarketResearch, recordMarketResearch } from '../repos/marketResearch.js';
import { recordAdminEvent } from '../events/adminRecord.js';
import {
  assertPublic,
  assertSubjectNotClient,
  EMPTY_FACTS,
  isResearchRegion,
  isResearchStale,
  researchStaleAsOf,
  isResearchTopic,
  RESEARCH_REGIONS,
  RESEARCH_STALE_DAYS,
  RESEARCH_TOPIC_DEFS,
  RESEARCH_TOPIC_LIST,
  RESEARCH_TOPICS,
  researchQuestion,
  ResearchInputError,
  type PublicResearchFacts,
  type ResearchRegion,
  type ResearchTopic,
} from '../domain/research.js';
import { refuseIfRetired } from '../domain/retiredEngagement.js';

/**
 * Web-grounded market research (design §12.3).
 *
 * `ai/app/perplexity.py` and `POST /ai/v1/research` were complete, fenced and
 * tested for months, and nothing called them — so industry-conditions and
 * market-outlook paragraphs were still written from the uploaded corpus and
 * analyst knowledge alone, which is the weakest and least defensible part of a
 * generated draft. This is the caller.
 *
 * Three things this route owns that the generic AI route could not:
 *
 *   * Containment. The question is assembled by `domain/research.ts` from a
 *     whitelist of public fields and a fixed template. Nothing on the request
 *     body reaches the search provider except a `subject` that is checked
 *     against the engagement's own company name first.
 *   * Provenance. The answer is stored with the question that produced it and
 *     the sources retrieved for it, append-only, so a report can cite research
 *     that still says what it said when the report was drafted.
 *   * Restraint. Neither provider is unlimited — Sonar bills per request and
 *     the keyless fallback is rate-limited per address — so the refresh-all
 *     sweep stays ops-only and runs each topic once.
 *
 * Which provider answered is not this route's business. The AI service tries
 * Perplexity and falls back to a keyless search path on its own; the response
 * shape is identical either way, and `model` on the stored row records which
 * one it was.
 */

/** Wall clock for one research call — above the AI service's own budget. */
const RESEARCH_TIMEOUT_MS = 150_000;

const RunBody = z
  .object({
    topic: z.enum(RESEARCH_TOPICS),
    region: z.enum(RESEARCH_REGIONS).optional(),
    /**
     * A named *public* guideline company, for `company_overview` only. The one
     * caller-supplied string that reaches the provider, and the reason
     * `assertSubjectNotClient` exists.
     */
    subject: z.string().min(2).max(120).optional(),
  })
  .strict();

export interface ResearchAnswer {
  model: string;
  content: string;
  citations: Array<{ url: string; title?: string; date?: string }>;
  grounded: boolean;
  /**
   * Absent from responses produced before the AI service grew the field, which
   * is why every read of it is `!== false` rather than a truth test.
   */
  synthesized?: boolean;
  tokens: number;
}

/**
 * The public facts this engagement can supply, and nothing else.
 *
 * Read field by field from two sources rather than spread from a row: a spread
 * is how `business_overview` or `cap_table_summary` would end up in a search
 * query the day someone adds a field to `company_profiles`.
 */
export async function publicFacts(
  pool: pg.Pool,
  valuationId: string,
  extra: { region?: ResearchRegion | null; subject?: string | null } = {},
): Promise<PublicResearchFacts> {
  const [profile, overwrites] = await Promise.all([
    findCompanyProfile(pool, valuationId),
    listOverwrites(pool, valuationId),
  ]);
  const overwriteValue = (key: string): string | null => {
    const row = overwrites.find((o) => o.field_key === key);
    if (!row || row.value === null || row.value === undefined) return null;
    const text = String(row.value).trim();
    return text === '' ? null : text;
  };
  return {
    ...EMPTY_FACTS,
    industry: profile?.industry?.trim() || null,
    industryCode: overwriteValue('industry_id'),
    comparableSet: overwriteValue('comparable_set'),
    region: extra.region ?? null,
    subject: extra.subject ?? null,
  };
}

function actorFor(principal: Principal) {
  return { actorType: 'human' as const, actorId: principal.id };
}

export function registerResearchRoutes(app: FastifyInstance, deps: { pool: pg.Pool; aiUrl: string }): void {
  const loadOps = async (id: string, principal: Principal): Promise<ValuationRow> => {
    if (!isOps(principal)) throw problems.forbidden('Market research is operations-only');
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (!valuation) throw problems.notFound();
    return valuation;
  };

  /**
   * One research run.
   *
   * The order below is the contract: assemble, assert, ask, persist. Asserting
   * after assembling and before asking is the whole point — a question that
   * fails the check has cost nothing and reached nobody.
   */
  const runOne = async (
    valuation: ValuationRow,
    topic: ResearchTopic,
    facts: PublicResearchFacts,
    principal: Principal,
  ) => {
    const def = RESEARCH_TOPIC_DEFS[topic];
    const question = researchQuestion(topic, facts);
    // The company's name is the one confidential string a template could
    // plausibly reach for, and the one an operator might paste into `subject`.
    assertPublic(question, [valuation.company_name]);

    const prompt = await findPromptByPipeline(deps.pool, def.promptPipeline);
    if (prompt && prompt.enabled === false) {
      throw problems.unprocessable(`The "${def.label}" research prompt is disabled`);
    }

    const answer = await postJson<ResearchAnswer>(
      'ai-service',
      `${deps.aiUrl}/ai/v1/research`,
      {
        query: question,
        ...(prompt?.system_prompt ? { system: prompt.system_prompt } : {}),
        ...(prompt?.model ? { model: prompt.model } : {}),
        ...(def.recency ? { recency: def.recency } : {}),
      },
      {
        timeoutMs: RESEARCH_TIMEOUT_MS,
        record: { valuationId: valuation.id, name: `ai research (${def.label})` },
      },
    );

    const row = await recordMarketResearch(deps.pool, {
      valuationId: valuation.id,
      topic,
      region: def.regionScoped ? facts.region : null,
      question,
      answer: answer.content,
      citations: answer.citations,
      synthesized: answer.synthesized !== false,
      model: answer.model,
      requestedBy: principal.id,
    });
    await recordAdminEvent(deps.pool, {
      type: 'market_research_run',
      actor: actorFor(principal),
      subjectType: 'valuation',
      subjectId: valuation.id,
      subjectLabel: valuation.company_name,
      // Never the question or the answer: this is the audit spine, not a
      // second copy of the research, and `market_research` already holds both.
      payload: { topic, region: row.region, grounded: answer.grounded, model: answer.model },
    });
    return row;
  };

  /** The topic registry — the tab renders its cards from this, not a copy. */
  app.get('/api/v1/research/topics', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    if (!isOps(principal)) throw problems.forbidden('Market research is operations-only');
    return {
      topics: RESEARCH_TOPIC_LIST,
      regions: RESEARCH_REGIONS.map((key) => ({ key, label: key.toUpperCase() })),
      stale_days: RESEARCH_STALE_DAYS,
    };
  });

  app.post('/api/v1/valuations/:id/research', { preHandler: app.authenticate }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadOps(id, principal);
    // A retired engagement does not spend the firm's AI budget or engine time.
    // Placed before the body is parsed so the reason a caller gets back is the
    // state of the file rather than whatever else was wrong with the request.
    refuseIfRetired(valuation, 'accepting research runs');

    const parsed = RunBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw problems.unprocessable('Invalid research request', { errors: parsed.error.issues });
    }
    const { topic } = parsed.data;
    const def = RESEARCH_TOPIC_DEFS[topic];
    if (parsed.data.subject && !def.acceptsSubject) {
      throw problems.unprocessable(`The "${def.label}" topic does not take a subject company`);
    }
    if (parsed.data.subject) {
      try {
        assertSubjectNotClient(parsed.data.subject, valuation.company_name);
      } catch (err) {
        if (err instanceof ResearchInputError) throw problems.unprocessable(err.message);
        throw err;
      }
    }

    const facts = await publicFacts(deps.pool, id, {
      region: def.regionScoped ? (parsed.data.region ?? null) : null,
      subject: parsed.data.subject ?? null,
    });

    try {
      const research = await runOne(valuation, topic, facts, principal);
      return reply.status(201).send({ research });
    } catch (err) {
      if (err instanceof ResearchInputError) throw problems.unprocessable(err.message);
      if (err instanceof InternalServiceError) throw toProblem(err);
      throw err;
    }
  });

  app.get('/api/v1/valuations/:id/research', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    if (!isUlid(id)) throw problems.notFound();
    const valuation = await findValuationById(deps.pool, id);
    if (
      !valuation ||
      !canReadValuation(principal, { userId: valuation.user_id, partnerId: valuation.partner_id })
    ) {
      throw problems.notFound();
    }
    // Readable by anyone who can read the valuation — the citations are the
    // provenance behind the report's market discussion, and a client asking
    // "where did this multiple come from" is asking a fair question. Running
    // it, which spends money, stays ops-only.
    // Staleness is measured against the engagement's measurement date, not
    // today — see `researchStaleAsOf`. The params read is worth the round trip
    // for that alone: without it every finished engagement flags all of its
    // research stale forever, which is the tab's own copy contradicted by the
    // field beside it.
    const [rows, params] = await Promise.all([listMarketResearch(deps.pool, id), findParams(deps.pool, id)]);
    const asOf = researchStaleAsOf(params?.inception_date);
    return {
      research: rows.map((row) => ({
        ...row,
        stale: isResearchStale(row.created_at, asOf),
        // Same rule the report gates apply, computed in one place the tab can
        // read: sources are necessary and not sufficient. `row.synthesized`
        // travels alongside via the spread, so the tab can say *which* of the
        // two reasons a row is not grounded.
        grounded: row.citations.length > 0 && row.synthesized !== false,
      })),
      stale_days: RESEARCH_STALE_DAYS,
      can_run: isOps(principal),
    };
  });

  /**
   * Re-run every non-subject topic.
   *
   * `company_overview` is skipped: it needs a guideline company named by an
   * analyst, and there is no defensible way to guess one. Region-scoped topics
   * run for the region asked for, or `un` — the global question — when none is.
   *
   * Each topic's failure is reported rather than thrown, because the alternative
   * is that one provider 503 discards the four answers already retrieved.
   */
  app.post('/api/v1/valuations/:id/research/refresh-all', { preHandler: app.authenticate }, async (req) => {
    const principal = requirePrincipal(req);
    const { id } = req.params as { id: string };
    const valuation = await loadOps(id, principal);
    refuseIfRetired(valuation, 'accepting research runs');

    const parsed = z.object({ region: z.enum(RESEARCH_REGIONS).default('un') }).safeParse(req.body ?? {});
    if (!parsed.success) throw problems.unprocessable('Invalid region');

    const results: Array<{ topic: ResearchTopic; ok: boolean; error?: string }> = [];
    for (const def of RESEARCH_TOPIC_LIST) {
      if (def.acceptsSubject) continue;
      const facts = await publicFacts(deps.pool, id, {
        region: def.regionScoped ? parsed.data.region : null,
      });
      try {
        await runOne(valuation, def.topic, facts, principal);
        results.push({ topic: def.topic, ok: true });
      } catch (err) {
        const message =
          err instanceof ResearchInputError || err instanceof InternalServiceError
            ? err.message
            : 'Research run failed';
        req.log.warn({ err, topic: def.topic }, 'research refresh-all: topic failed');
        results.push({ topic: def.topic, ok: false, error: message });
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  });
}

/** Re-exported for the tests and the narrative thread. */
export { isResearchRegion, isResearchTopic };
