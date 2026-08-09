import { describe, expect, it } from 'vitest';
import {
  assertPublic,
  assertSubjectNotClient,
  EMPTY_FACTS,
  isResearchStale,
  narrativeResearchPayload,
  RESEARCH_REGIONS,
  RESEARCH_STALE_DAYS,
  RESEARCH_TOPIC_DEFS,
  RESEARCH_TOPICS,
  researchQuestion,
  ResearchInputError,
  type PublicResearchFacts,
} from '../../src/domain/research.js';
import { AI_PIPELINES, NON_RUNNABLE_PIPELINES } from '../../src/domain/pipeline.js';

/** Design §12.3 — the public-field research spine. */

const facts = (over: Partial<PublicResearchFacts> = {}): PublicResearchFacts => ({
  ...EMPTY_FACTS,
  industry: 'industrial robotics',
  industryCode: '3559',
  ...over,
});

describe('topic registry', () => {
  it('binds every topic to a seeded prompt-registry pipeline', () => {
    for (const topic of RESEARCH_TOPICS) {
      const def = RESEARCH_TOPIC_DEFS[topic];
      expect(def.topic, topic).toBe(topic);
      expect(AI_PIPELINES as readonly string[]).toContain(def.promptPipeline);
    }
  });

  it('keeps the research prompts out of the generic AI runner', () => {
    // Their route owns the containment rules, the append-only storage and the
    // supersede; the generic runner owns none of them, so a second entry point
    // would be a second, weaker contract.
    for (const topic of RESEARCH_TOPICS) {
      expect(NON_RUNNABLE_PIPELINES.has(RESEARCH_TOPIC_DEFS[topic].promptPipeline)).toBe(true);
    }
  });

  it('scopes exactly one topic by region and one by subject', () => {
    const regional = RESEARCH_TOPICS.filter((t) => RESEARCH_TOPIC_DEFS[t].regionScoped);
    const subjected = RESEARCH_TOPICS.filter((t) => RESEARCH_TOPIC_DEFS[t].acceptsSubject);
    // Six regional market_* prompts collapsed onto one region-parameterised
    // topic: six rows would be six places to fix a wording change.
    expect(regional).toEqual(['market_conditions']);
    expect(subjected).toEqual(['company_overview']);
  });
});

describe('question assembly', () => {
  it('names the industry and the code it was given', () => {
    const q = researchQuestion('industry_overview', facts());
    expect(q).toContain('industrial robotics');
    expect(q).toContain('3559');
  });

  it('names the market for a region-scoped question', () => {
    const q = researchQuestion('market_conditions', facts({ region: 'uk' }));
    expect(q).toContain('the United Kingdom');
    expect(q).toContain('EV/revenue');
  });

  it('refuses a region-scoped question with no region', () => {
    expect(() => researchQuestion('market_conditions', facts())).toThrow(ResearchInputError);
  });

  it('refuses rather than asking a vaguer question when the industry is unknown', () => {
    // A "summarise the industry" with no industry returns a paragraph about
    // industries in general — which reads like research, costs a Sonar call,
    // and would land in an exhibit next to real citations.
    for (const topic of ['industry_overview', 'industry_outlook', 'industry_finder'] as const) {
      expect(() => researchQuestion(topic, facts({ industry: null, industryCode: null })), topic).toThrow(
        ResearchInputError,
      );
    }
  });

  it('industry_finder needs the prose description, not just a code', () => {
    expect(() => researchQuestion('industry_finder', facts({ industry: null }))).toThrow(ResearchInputError);
  });

  it('company_overview needs an explicit subject', () => {
    expect(() => researchQuestion('company_overview', facts())).toThrow(ResearchInputError);
    expect(researchQuestion('company_overview', facts({ subject: 'ABB Ltd' }))).toContain('ABB Ltd');
  });

  it('every region produces a question that names its market', () => {
    for (const region of RESEARCH_REGIONS) {
      const q = researchQuestion('market_conditions', facts({ region }));
      expect(q.length, region).toBeGreaterThan(80);
    }
  });
});

describe('confidentiality containment', () => {
  /**
   * The load-bearing test. Nothing about a company reaches a live web search
   * except the industry and the classification code, and this is what says so
   * when someone widens a template later.
   */
  it('never puts the engagement’s company name in a question', () => {
    const company = 'Zorblatt Dynamics Incorporated';
    for (const topic of RESEARCH_TOPICS) {
      const f = facts({
        region: 'us',
        subject: topic === 'company_overview' ? 'ABB Ltd' : null,
        comparableSet: 'Robotics GPC set',
      });
      const question = researchQuestion(topic, f);
      expect(question.toLowerCase(), topic).not.toContain('zorblatt');
      // …and the assertion the route actually runs agrees.
      expect(() => assertPublic(question, [company]), topic).not.toThrow();
    }
  });

  it('assertPublic catches a leak case-insensitively and as a substring', () => {
    expect(() => assertPublic('Overview of Acme Robotics', ['acme'])).toThrow(ResearchInputError);
    expect(() => assertPublic('Overview of ACME', ['Acme'])).toThrow(ResearchInputError);
  });

  it('assertPublic ignores terms too short to identify anyone', () => {
    // "Co" would match "cost of capital" and refuse every question.
    expect(() => assertPublic('the cost of capital environment', ['Co'])).not.toThrow();
  });

  it('refuses a guideline-company subject that is the engagement’s own company', () => {
    expect(() => assertSubjectNotClient('Acme Robotics', 'Acme Robotics')).toThrow(ResearchInputError);
    expect(() => assertSubjectNotClient('acme robotics inc', 'Acme Robotics')).toThrow(ResearchInputError);
    expect(() => assertSubjectNotClient('ABB Ltd', 'Acme Robotics')).not.toThrow();
  });
});

describe('staleness', () => {
  it('flags research older than the window before the measurement date', () => {
    const asOf = new Date('2026-08-08T00:00:00Z');
    const old = new Date(asOf.getTime() - (RESEARCH_STALE_DAYS + 5) * 86_400_000);
    const fresh = new Date(asOf.getTime() - 10 * 86_400_000);
    expect(isResearchStale(old, asOf)).toBe(true);
    expect(isResearchStale(fresh, asOf)).toBe(false);
  });
});

describe('narrative payload', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    topic: 'industry_overview',
    region: null,
    answer: 'The sector consolidated in 2025.',
    citations: [{ url: 'https://example.com/report' }],
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...over,
  });

  it('passes grounded rows through with an ISO retrieval stamp', () => {
    const payload = narrativeResearchPayload([row()]);
    expect(payload).toHaveLength(1);
    expect(payload![0]!.retrieved_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('drops ungrounded answers entirely', () => {
    // An answer with no citations is an expensive completion. Threading it into
    // a draft would put an unsourced claim beside sourced ones with nothing to
    // tell them apart.
    expect(narrativeResearchPayload([row({ citations: [] })])).toBeNull();
    expect(narrativeResearchPayload([row({ citations: null })])).toBeNull();
  });

  it('returns null rather than an empty block when there is nothing to send', () => {
    expect(narrativeResearchPayload([])).toBeNull();
  });

  it('drops rows whose sources were never summarised', () => {
    // The subtle one: real citations, non-empty answer, and the answer is a
    // placeholder saying the synthesis model was unavailable. Handing that to
    // the drafting agent gives it a paragraph about a service outage attached
    // to a topic, with citations beside it.
    const unsynthesized = row({
      answer: 'Sources were retrieved for this question but could not be summarised.',
      synthesized: false,
    });
    expect(narrativeResearchPayload([unsynthesized])).toBeNull();
  });

  it('keeps a synthesised row alongside one that was not', () => {
    // The filter has to be per-row: one topic failing synthesis must not cost
    // the report the topics that succeeded.
    const payload = narrativeResearchPayload([
      row({ synthesized: false, topic: 'industry_outlook' }),
      row({ synthesized: true }),
    ]);
    expect(payload).toHaveLength(1);
    expect(payload![0]!.topic).toBe('industry_overview');
  });

  it('treats a row with no synthesized field as an answer', () => {
    // Every row written before migration 0125 predates the flag, and each one
    // is an answer some model actually wrote. Reading `undefined` as "not
    // synthesised" would empty the market discussion of every report drafted
    // from research retrieved before the upgrade.
    const legacy = row();
    expect('synthesized' in legacy).toBe(false);
    expect(narrativeResearchPayload([legacy])).toHaveLength(1);
  });
});
