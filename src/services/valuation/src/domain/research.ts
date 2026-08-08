/**
 * Web-grounded market research (migration 0116): which questions may be asked
 * of a live search provider, and how each one is assembled.
 *
 * Pure. The route owns the HTTP call to the AI service and the persistence;
 * this module owns the topic registry and — the part that matters — the fact
 * that a research question is built from a fixed template plus a whitelist of
 * public fields, and never from client text.
 *
 * ## Why the assembly is here and not in the route
 *
 * Every other AI pipeline in this service ships the engagement's own material
 * to the model and relies on `pipelines._ask` redacting it, so the subject of a
 * 409A never leaves the trust boundary. Research inverts that: the whole point
 * is to send the question *outward* to a search engine, and a redacted question
 * is unanswerable anyway — "[COMPANY]" is not a searchable subject.
 *
 * So the containment cannot be a redaction pass. It is structural: there is no
 * code path from a cap table, a financial statement, an intake answer or the
 * company's own name into a question this module builds, because the builders
 * below interpolate only `PublicResearchFacts`, and `PublicResearchFacts` has
 * no field that can hold any of those. The placeholder tripwire inside
 * `ai/app/research.py` stays as a second line of defence rather than the
 * only one.
 *
 * `assertPublic` is the third: it re-reads the assembled question against the
 * strings the caller knows are confidential, so a future edit that widens a
 * template fails a test rather than leaking on a Tuesday.
 */

import type { AiPipeline } from './pipeline.js';

/** An input problem the analyst has to fix — the route maps it to a 422. */
export class ResearchInputError extends Error {}

/**
 * Markets a region-scoped question can name. Mirrors 409.ai's six `market_*`
 * prompts, which are the same question with a different market in it — six
 * rows being six places to fix a wording change.
 */
export const RESEARCH_REGIONS = ['us', 'uk', 'au', 'si', 'ca', 'un'] as const;
export type ResearchRegion = (typeof RESEARCH_REGIONS)[number];

export const REGION_LABELS: Record<ResearchRegion, string> = {
  us: 'the United States',
  uk: 'the United Kingdom',
  au: 'Australia',
  si: 'Singapore',
  ca: 'Canada',
  // Not a country. 409.ai's market_un is the question asked of no particular
  // market, which is the right default for a company that sells everywhere.
  un: 'global markets',
};

export const RESEARCH_TOPICS = [
  'industry_overview',
  'industry_outlook',
  'market_conditions',
  'competitor_analysis',
  'company_overview',
  'industry_finder',
] as const;
export type ResearchTopic = (typeof RESEARCH_TOPICS)[number];

export interface ResearchTopicDef {
  topic: ResearchTopic;
  label: string;
  /** Shown on the tab; also the answer to "why would I run this one?". */
  description: string;
  /** The `ai_prompts` row whose system prompt and synthesis model this topic uses. */
  promptPipeline: AiPipeline;
  /** Whether `region` is meaningful — only `market_conditions` is. */
  regionScoped: boolean;
  /**
   * Whether the topic takes an operator-supplied public subject (a guideline
   * company). Only `company_overview` does, and the route refuses a subject
   * that matches the engagement's own company — see `assertSubjectNotClient`.
   */
  acceptsSubject: boolean;
  /**
   * How far back the search may reach. A multiple from 2019 is worse than no
   * multiple when the question is what a sector trades at today; an industry's
   * structure, by contrast, does not change quarterly.
   */
  recency: 'day' | 'week' | 'month' | 'year' | null;
}

export const RESEARCH_TOPIC_DEFS: Record<ResearchTopic, ResearchTopicDef> = {
  industry_overview: {
    topic: 'industry_overview',
    label: 'Industry overview',
    description:
      'What the industry comprises, how it is structured, and the metrics practitioners value it on.',
    promptPipeline: 'industry_overview',
    regionScoped: false,
    acceptsSubject: false,
    recency: 'year',
  },
  industry_outlook: {
    topic: 'industry_outlook',
    label: 'Industry outlook',
    description: 'Growth expectations, headwinds, and the regulatory and funding environment.',
    promptPipeline: 'industry_outlook',
    regionScoped: false,
    acceptsSubject: false,
    recency: 'month',
  },
  market_conditions: {
    topic: 'market_conditions',
    label: 'Market conditions',
    description:
      'Deal activity, trading multiples and cost of capital in one named market. Run it once per market that matters to the engagement.',
    promptPipeline: 'market_research',
    regionScoped: true,
    acceptsSubject: false,
    recency: 'month',
  },
  competitor_analysis: {
    topic: 'competitor_analysis',
    label: 'Competitor analysis',
    description: 'Who competes in the industry and segment, and on what basis.',
    promptPipeline: 'competitor_analysis',
    regionScoped: false,
    acceptsSubject: false,
    recency: 'year',
  },
  company_overview: {
    topic: 'company_overview',
    label: 'Guideline company overview',
    description:
      'The public record on one named guideline company. Never the engagement’s own subject — that is confidential.',
    promptPipeline: 'company_overview',
    regionScoped: false,
    acceptsSubject: true,
    recency: 'year',
  },
  industry_finder: {
    topic: 'industry_finder',
    label: 'Industry classification',
    description: 'SIC and NAICS codes for the business, plus the tags to screen comparables on.',
    promptPipeline: 'industry_finder',
    regionScoped: false,
    acceptsSubject: false,
    recency: null,
  },
};

export const RESEARCH_TOPIC_LIST: readonly ResearchTopicDef[] = RESEARCH_TOPICS.map(
  (t) => RESEARCH_TOPIC_DEFS[t],
);

export function isResearchTopic(value: string): value is ResearchTopic {
  return (RESEARCH_TOPICS as readonly string[]).includes(value);
}

export function isResearchRegion(value: string): value is ResearchRegion {
  return (RESEARCH_REGIONS as readonly string[]).includes(value);
}

/**
 * Research older than this many days before the measurement date is a finding,
 * not a footnote: an opinion that cites market conditions from two quarters ago
 * is one an auditor will ask about.
 */
export const RESEARCH_STALE_DAYS = 90;

/**
 * Everything a research question is allowed to know.
 *
 * This type is the containment boundary. There is deliberately no
 * `companyName`, no `businessOverview`, no financial figure and no
 * questionnaire answer — not because the builders below choose not to use one,
 * but because there is nowhere to put one. Widening this interface is the
 * change that needs a second reader.
 */
export interface PublicResearchFacts {
  /** Freeform industry description from the company profile, e.g. "robotics". */
  industry: string | null;
  /** The `industry_id` overwrite — an SIC-style numeric classification. */
  industryCode: string | null;
  /** Named guideline-company set from the `comparable_set` overwrite. */
  comparableSet: string | null;
  /** Market to scope a region-scoped question to. */
  region: ResearchRegion | null;
  /** Operator-supplied public company, for `company_overview` only. */
  subject: string | null;
}

export const EMPTY_FACTS: PublicResearchFacts = {
  industry: null,
  industryCode: null,
  comparableSet: null,
  region: null,
  subject: null,
};

/** The industry phrase a template names, or null when we do not know one. */
function industryPhrase(facts: PublicResearchFacts): string | null {
  const parts: string[] = [];
  if (facts.industry) parts.push(facts.industry);
  if (facts.industryCode) parts.push(`SIC/industry code ${facts.industryCode}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The question for one topic, or a `ResearchInputError` naming what is missing.
 *
 * Refusing rather than asking a vaguer question is deliberate. "Summarise the
 * industry" with no industry named returns a paragraph about industries in
 * general, which reads like research, spends a search call, and would land in a
 * report exhibit next to real citations with nothing distinguishing it.
 */
export function researchQuestion(topic: ResearchTopic, facts: PublicResearchFacts): string {
  const industry = industryPhrase(facts);
  const needIndustry = (): string => {
    if (!industry) {
      throw new ResearchInputError(
        'This research topic needs the industry. Set it on the Company tab, or set the ' +
          '“Industry ID” overwrite, before running it.',
      );
    }
    return industry;
  };

  switch (topic) {
    case 'industry_overview':
      return (
        `Give an overview of the ${needIndustry()} industry: what it comprises, how it is ` +
        'structured, who the major participants are, the usual revenue models, and the ' +
        'metrics and valuation multiples practitioners use for it. Cite every source.'
      );

    case 'industry_outlook':
      return (
        `What is the forward outlook for the ${needIndustry()} industry? Cover growth ` +
        'expectations and who is forecasting them, the principal headwinds and tailwinds, ' +
        'the regulatory environment, and the state of private funding for the sector. ' +
        'Attribute each forecast to its publisher and give its date.'
      );

    case 'market_conditions': {
      const region = facts.region;
      if (!region) {
        throw new ResearchInputError(
          `Market conditions are asked of one market — pass a region (${RESEARCH_REGIONS.join(', ')}).`,
        );
      }
      return (
        `What are current market conditions for the ${needIndustry()} industry in ` +
        `${REGION_LABELS[region]}? Cover recent M&A and financing activity, prevailing ` +
        'EV/revenue and EV/EBITDA trading multiples for listed participants, the cost of ' +
        'capital environment, and overall investor sentiment. Give each figure with its ' +
        'as-of date and publisher.'
      );
    }

    case 'competitor_analysis': {
      const set = facts.comparableSet ? ` The analyst’s guideline set is named “${facts.comparableSet}”.` : '';
      return (
        `Which companies compete in the ${needIndustry()} industry? List both listed and ` +
        'private participants. For each give the name, a stock ticker where it is listed, ' +
        'roughly where it sits by scale, and the basis on which it competes.' +
        set
      );
    }

    case 'company_overview': {
      if (!facts.subject) {
        throw new ResearchInputError(
          'A guideline company overview needs the company to look up — pass `subject` with the ' +
            'name or ticker of a public guideline company.',
        );
      }
      return (
        `What does the public record say about ${facts.subject}? Cover what the company does, ` +
        'its stage, its disclosed funding or listing status, and its reported scale. If the ' +
        'public record holds little about it, say so rather than inferring.'
      );
    }

    case 'industry_finder': {
      if (!facts.industry) {
        throw new ResearchInputError(
          'Classification needs a description of what the business does. Set the industry on ' +
            'the Company tab before running it.',
        );
      }
      return (
        `A business is described as: ${facts.industry}. Which SIC and NAICS codes best ` +
        'classify it? Give each code with its official title and a one-line justification, ' +
        'most likely first, and list the search tags an analyst would screen guideline ' +
        'public companies on.'
      );
    }
  }
}

/**
 * Refuse an assembled question that contains any of `confidential`.
 *
 * The structural containment above is what actually keeps client text out of a
 * web search. This is the assertion that says so out loud, so that a template
 * edit which reaches for a field it should not have is caught here — where the
 * message names the problem — rather than at the research client's placeholder
 * tripwire, which only fires when the text happened to go through the redactor
 * first, or not at all.
 *
 * Case-insensitive and substring-based: "Acme" must not slip through inside
 * "acme robotics".
 */
export function assertPublic(question: string, confidential: readonly (string | null | undefined)[]): void {
  const haystack = question.toLowerCase();
  for (const term of confidential) {
    const needle = (term ?? '').trim().toLowerCase();
    // Very short terms match by accident ("Co", "AI") and would refuse every
    // question; the caller passes the company name, which is never that short
    // in practice, and a two-character company name is not identifying anyway.
    if (needle.length < 3) continue;
    if (haystack.includes(needle)) {
      throw new ResearchInputError(
        'The assembled research question contains confidential engagement text and was not sent. ' +
          'Research questions are built from public fields only.',
      );
    }
  }
}

/**
 * A `company_overview` subject must not be the engagement's own company.
 *
 * The topic exists for guideline companies, which are public by definition. The
 * subject of a 409A is not, and "look up what the internet says about my
 * client" is exactly the request this whole module is fenced against — however
 * reasonable it looks in the moment.
 */
export function assertSubjectNotClient(subject: string, companyName: string): void {
  const a = subject.trim().toLowerCase();
  const b = companyName.trim().toLowerCase();
  if (!a || !b) return;
  if (a === b || a.includes(b) || b.includes(a)) {
    throw new ResearchInputError(
      'That is the engagement’s own company. Guideline company research is for public ' +
        'comparables; the subject of a valuation is confidential and is never sent to a search provider.',
    );
  }
}

/** Whether a stored row is older than RESEARCH_STALE_DAYS before `asOf`. */
export function isResearchStale(createdAt: Date | string, asOf: Date = new Date()): boolean {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const days = (asOf.getTime() - created.getTime()) / 86_400_000;
  return days > RESEARCH_STALE_DAYS;
}

/**
 * The research block the `report_narrative` agent receives.
 *
 * Only grounded rows travel: an answer with no citations was written without
 * retrieved sources, and the whole reason to take this path is the citation
 * list. Threading an ungrounded answer into a drafted report would put an
 * unsourced claim next to sourced ones with nothing to tell them apart — which
 * is the failure mode `research.research` declines to call the model at all to
 * prevent, undone one layer up.
 */
export function narrativeResearchPayload(
  rows: ReadonlyArray<{
    topic: string;
    region: string | null;
    answer: string;
    citations: unknown;
    created_at: Date | string;
  }>,
): Array<{ topic: string; region: string | null; answer: string; citations: unknown; retrieved_at: string }> | null {
  const grounded = rows.filter((r) => Array.isArray(r.citations) && r.citations.length > 0);
  if (grounded.length === 0) return null;
  return grounded.map((r) => ({
    topic: r.topic,
    region: r.region,
    answer: r.answer,
    citations: r.citations,
    retrieved_at:
      r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
  }));
}
