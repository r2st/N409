import { describe, expect, it } from 'vitest';
import {
  EXCLUSIVE_TAG_CATEGORIES,
  TAG_CATALOGUE,
  TAG_CATEGORIES,
  TAG_CATEGORY_LABELS,
  TAGS_BY_SLUG,
  ValuationTagError,
  isTagSlug,
  mapAgentTags,
  tagCataloguePayload,
} from '../../src/domain/valuationTags.js';
import { ValuationFilterQuery, toRepoFilters } from '../../src/routes/valuations.js';
import { presentValuationTag } from '../../src/routes/valuationTags.js';

/**
 * The engagement tag vocabulary, and everything that reads it without a
 * database (migration 0153, 409.ai parity gap #23).
 *
 * The module's central decision is that the vocabulary is *closed*, and closing
 * it is only worth anything if the closure holds at every boundary: the model's
 * output, the analyst's POST, and the list filter's query string. So the tests
 * below are mostly about what is turned away and what happens to it — a dropped
 * slug that nobody can see is how a vocabulary quietly stops covering the book
 * of work, which is the failure the `unknown` channel exists to prevent.
 */

// ── The catalogue itself ─────────────────────────────────────────────────────

describe('the tag catalogue', () => {
  it('has no duplicate slugs', () => {
    // The map is built from the list, so a duplicate would not error — the
    // later entry would silently win and one label would never be rendered.
    expect(TAGS_BY_SLUG.size).toBe(TAG_CATALOGUE.length);
  });

  it('places every tag in a declared category', () => {
    for (const tag of TAG_CATALOGUE) {
      expect(TAG_CATEGORIES).toContain(tag.category);
    }
  });

  it('gives every category at least two tags', () => {
    // A category with one tag is not a choice; it is a checkbox that has been
    // given a heading.
    for (const category of TAG_CATEGORIES) {
      expect(TAG_CATALOGUE.filter((t) => t.category === category).length).toBeGreaterThan(1);
    }
  });

  it('labels every category', () => {
    for (const category of TAG_CATEGORIES) {
      expect(TAG_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it('gives every tag a label and a definition', () => {
    // The definition is load-bearing in two directions at once: it is the
    // analyst's tooltip and it is the model's specification. A blank one leaves
    // the agent guessing at what the slug asserts.
    for (const tag of TAG_CATALOGUE) {
      expect(tag.label.trim()).not.toBe('');
      expect(tag.definition.trim().length).toBeGreaterThan(20);
      expect(tag.definition.trim().endsWith('.')).toBe(true);
    }
  });

  it('uses snake_case slugs throughout', () => {
    // The slug travels in a query string and in the agent's JSON; a stray
    // hyphen or capital is the kind of near-miss the closed vocabulary exists
    // to make impossible.
    for (const tag of TAG_CATALOGUE) {
      expect(tag.slug).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('marks only the ladder categories exclusive', () => {
    // Stage and revenue are rungs — a company is at one. The other four are
    // genuinely multi-valued: a fintech marketplace with warrants and a
    // participating stack is one company, not four.
    expect([...EXCLUSIVE_TAG_CATEGORIES].sort()).toEqual(['revenue', 'stage']);
  });
});

describe('isTagSlug', () => {
  it('accepts a catalogue slug and nothing else', () => {
    expect(isTagSlug('saas')).toBe(true);
    expect(isTagSlug('going_concern_doubt')).toBe(true);
    // The four spellings of one fact the closed vocabulary exists to prevent.
    expect(isTagSlug('SaaS')).toBe(false);
    expect(isTagSlug('b2b-saas')).toBe(false);
    expect(isTagSlug('software-as-a-service')).toBe(false);
    expect(isTagSlug('')).toBe(false);
    expect(isTagSlug(null)).toBe(false);
    expect(isTagSlug(42)).toBe(false);
    expect(isTagSlug(['saas'])).toBe(false);
  });

  it('does not accept an inherited Object property as a tag', () => {
    // A plain-object lookup would answer true for 'constructor'; the Map does
    // not, and the filter reads unvalidated query text.
    expect(isTagSlug('constructor')).toBe(false);
    expect(isTagSlug('toString')).toBe(false);
    expect(isTagSlug('__proto__')).toBe(false);
  });
});

// ── tagCataloguePayload ──────────────────────────────────────────────────────

describe('tagCataloguePayload', () => {
  it('groups the whole catalogue in declared category order', () => {
    const payload = tagCataloguePayload();
    expect(payload.map((g) => g.category)).toEqual([...TAG_CATEGORIES]);
    expect(payload.flatMap((g) => g.tags).length).toBe(TAG_CATALOGUE.length);
  });

  it('carries the definitions, because the agent is given this exact structure', () => {
    // One function, two consumers — the UI's tooltip and the model's spec. The
    // AI service holds no vocabulary of its own precisely so these cannot
    // diverge, which only works if the definitions actually travel.
    const payload = tagCataloguePayload();
    for (const group of payload) {
      for (const tag of group.tags) {
        expect(tag.definition).toBe(TAGS_BY_SLUG.get(tag.slug)?.definition);
      }
    }
  });

  it('flags the exclusive categories for the picker', () => {
    const payload = tagCataloguePayload();
    const exclusive = payload.filter((g) => g.exclusive).map((g) => g.category);
    expect(exclusive.sort()).toEqual(['revenue', 'stage']);
  });

  it('preserves each category order within its group', () => {
    const stage = tagCataloguePayload().find((g) => g.category === 'stage');
    expect(stage?.tags.map((t) => t.slug)).toEqual(
      TAG_CATALOGUE.filter((t) => t.category === 'stage').map((t) => t.slug),
    );
  });
});

// ── mapAgentTags ─────────────────────────────────────────────────────────────

const tag = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  confidence: 0.8,
  rationale: 'Read from the deck.',
  evidence: ['deck.pdf'],
  ...extra,
});

describe('mapAgentTags', () => {
  it('maps a well-formed result', () => {
    const out = mapAgentTags({ tags: [tag('saas'), tag('pre_revenue')] });
    expect(out.tags.map((t) => t.slug)).toEqual(['saas', 'pre_revenue']);
    expect(out.tags[0]).toEqual({
      slug: 'saas',
      confidence: 0.8,
      rationale: 'Read from the deck.',
      evidence: ['deck.pdf'],
    });
    expect(out.unknown).toEqual([]);
  });

  it('surfaces a slug outside the catalogue rather than eating it', () => {
    // A drop nobody can see is how the vocabulary stops covering the book of
    // work: if the model keeps proposing `ai_infrastructure` and the platform
    // keeps swallowing it, the only symptom is that the tags feel thin.
    const out = mapAgentTags({ tags: [tag('saas'), tag('ai_infrastructure')] });
    expect(out.tags.map((t) => t.slug)).toEqual(['saas']);
    expect(out.unknown).toEqual(['ai_infrastructure']);
  });

  it('does not normalise a near-miss into a catalogue slug', () => {
    // The tempting half-fix, and a trap: slugify('B2B SaaS') is 'b2b-saas',
    // still not 'saas', and the cases it catches teach a reader to trust the
    // cases it does not.
    const out = mapAgentTags({ tags: [tag('SaaS'), tag('b2b-saas'), tag('saas')] });
    expect(out.tags.map((t) => t.slug)).toEqual(['saas']);
    expect(out.unknown).toEqual(['SaaS', 'b2b-saas']);
  });

  it('deduplicates a repeated slug, keeping the first', () => {
    const out = mapAgentTags({
      tags: [tag('saas', { rationale: 'first' }), tag('saas', { rationale: 'second' })],
    });
    expect(out.tags).toHaveLength(1);
    expect(out.tags[0]!.rationale).toBe('first');
  });

  it('deduplicates unknown slugs too', () => {
    const out = mapAgentTags({
      tags: [tag('saas'), ...Array.from({ length: 40 }, () => tag('ai_infrastructure'))],
    });
    expect(out.unknown).toEqual(['ai_infrastructure']);
  });

  it('caps what survives rather than what was offered', () => {
    // Truncating first would let twelve invented slugs spend the whole budget
    // and return nothing — reading as "the documents did not classify this
    // engagement" when the model in fact proposed usable tags after them.
    const invented = Array.from({ length: 12 }, (_, i) => tag(`invented_${i}`));
    const real = TAG_CATALOGUE.slice(0, 6).map((t) => tag(t.slug));
    const out = mapAgentTags({ tags: [...invented, ...real] });
    expect(out.tags.map((t) => t.slug)).toEqual(real.map((t) => t.slug));
  });

  it('writes at most twelve tags', () => {
    const out = mapAgentTags({ tags: TAG_CATALOGUE.map((t) => tag(t.slug)) });
    expect(out.tags).toHaveLength(12);
  });

  it('lists at most twelve unknown slugs', () => {
    const out = mapAgentTags({
      tags: [tag('saas'), ...Array.from({ length: 30 }, (_, i) => tag(`invented_${i}`))],
    });
    expect(out.unknown).toHaveLength(12);
  });

  it('stops scanning a pathological list', () => {
    // 60 entries deep is the bound; a real tag past it is not reached, which is
    // the point — the alternative is an unbounded walk over model output.
    const filler = Array.from({ length: 60 }, (_, i) => tag(`invented_${i}`));
    expect(() => mapAgentTags({ tags: [...filler, tag('saas')] })).toThrow(ValuationTagError);
  });

  it('clamps confidence into [0, 1] and coerces a numeric string', () => {
    const out = mapAgentTags({
      tags: [
        tag('saas', { confidence: 1.4 }),
        tag('pre_revenue', { confidence: -0.2 }),
        tag('fintech', { confidence: '0.65' }),
      ],
    });
    expect(out.tags.map((t) => t.confidence)).toEqual([1, 0, 0.65]);
  });

  it('reads an unusable confidence as absent rather than as zero', () => {
    // Zero is a claim — "the model is certain this does not apply" — and the
    // list sorts on it. Absent is the honest reading of "high".
    const out = mapAgentTags({
      tags: [
        tag('saas', { confidence: 'high' }),
        tag('pre_revenue', { confidence: null }),
        tag('fintech', { confidence: Number.NaN }),
      ],
    });
    expect(out.tags.map((t) => t.confidence)).toEqual([null, null, null]);
  });

  it('trims and bounds the rationale', () => {
    const out = mapAgentTags({
      tags: [
        tag('saas', { rationale: `  ${'x'.repeat(900)}  ` }),
        tag('fintech', { rationale: '   ' }),
        tag('pre_revenue', { rationale: 17 }),
      ],
    });
    expect(out.tags[0]!.rationale).toHaveLength(600);
    expect(out.tags[1]!.rationale).toBeNull();
    expect(out.tags[2]!.rationale).toBeNull();
  });

  it('bounds the evidence list and drops what is not a usable string', () => {
    const out = mapAgentTags({
      tags: [
        tag('saas', { evidence: ['a.pdf', '', null, 42, { file: 'b.pdf' }, 'c.pdf'] }),
        tag('fintech', { evidence: Array.from({ length: 20 }, (_, i) => `doc${i}.pdf`) }),
        tag('pre_revenue', { evidence: 'deck.pdf' }),
      ],
    });
    expect(out.tags[0]!.evidence).toEqual(['a.pdf', 'c.pdf']);
    expect(out.tags[1]!.evidence).toHaveLength(8);
    expect(out.tags[2]!.evidence).toEqual([]); // not an array — not evidence
  });

  it('truncates an over-long evidence citation', () => {
    const out = mapAgentTags({ tags: [tag('saas', { evidence: ['y'.repeat(400)] })] });
    expect(out.tags[0]!.evidence[0]).toHaveLength(300);
  });

  it('skips an entry with no usable slug', () => {
    const out = mapAgentTags({ tags: [null, 'saas', { slug: 42 }, { slug: '  ' }, tag('fintech')] });
    expect(out.tags.map((t) => t.slug)).toEqual(['fintech']);
  });

  it('refuses a run that proposed nothing', () => {
    for (const doc of [{}, { tags: [] }, { tags: 'saas' }, null, 'nope', 42]) {
      expect(() => mapAgentTags(doc)).toThrow(/proposed no tags/);
    }
  });

  it('names the invented slugs when none of them were in the catalogue', () => {
    // The actionable version of the failure: it tells the analyst the model had
    // an opinion and what it was, rather than "no usable tags".
    expect(() => mapAgentTags({ tags: [tag('ai_infrastructure'), tag('vertical_saas')] })).toThrow(
      /returned ai_infrastructure, vertical_saas/,
    );
  });

  it('reports unusable entries as no usable tags', () => {
    expect(() => mapAgentTags({ tags: [null, { slug: '' }] })).toThrow(/no usable tags/);
  });

  it('throws the error type the route maps to a 422', () => {
    expect(() => mapAgentTags({ tags: [] })).toThrow(ValuationTagError);
  });
});

// ── presentValuationTag ──────────────────────────────────────────────────────

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: '01JTAG00000000000000000000',
    valuation_id: '01JVAL00000000000000000000',
    slug: 'saas',
    source: 'ai',
    status: 'suggested',
    confidence: 0.9,
    rationale: 'Subscription revenue in the deck.',
    evidence: ['deck.pdf'],
    created_by: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
    decided_by: null,
    decided_at: null,
    ...over,
  }) as Parameters<typeof presentValuationTag>[0];

describe('presentValuationTag', () => {
  it('resolves the catalogue entry onto the stored row', () => {
    const out = presentValuationTag(row());
    expect(out.label).toBe('SaaS');
    expect(out.category).toBe('business_model');
    expect(out.known).toBe(true);
    expect(out.definition).toBe(TAGS_BY_SLUG.get('saas')!.definition);
  });

  it('presents a retired slug rather than dropping it', () => {
    // A slug that has left the catalogue still describes something an analyst
    // concluded; dropping it from the response would make a decision disappear
    // with no symptom at all.
    const out = presentValuationTag(row({ slug: 'web3_native', source: 'manual', status: 'accepted' }));
    expect(out.known).toBe(false);
    expect(out.label).toBe('web3_native');
    expect(out.definition).toBeNull();
    expect(out.category).toBeNull();
    expect(out.status).toBe('accepted');
  });

  it('carries the source through so agreement and judgement stay distinguishable', () => {
    expect(presentValuationTag(row({ source: 'ai', status: 'accepted' })).source).toBe('ai');
    expect(presentValuationTag(row({ source: 'manual', status: 'accepted' })).source).toBe('manual');
  });

  it('does not leak the internal ids', () => {
    const out = presentValuationTag(row({ created_by: '01JUSR0000000000000000000A' }));
    expect(out).not.toHaveProperty('id');
    expect(out).not.toHaveProperty('created_by');
    expect(out).not.toHaveProperty('decided_by');
    expect(out).not.toHaveProperty('valuation_id');
  });
});

// ── The list filter's query parsing ──────────────────────────────────────────

const parseTags = (query: Record<string, string>) => toRepoFilters(ValuationFilterQuery.parse(query)).tags;

describe('the tags list filter', () => {
  it('splits a comma-separated list', () => {
    expect(parseTags({ tags: 'saas,pre_revenue' })).toEqual(['saas', 'pre_revenue']);
  });

  it('tolerates the whitespace a hand-written URL carries', () => {
    expect(parseTags({ tags: ' saas , pre_revenue ' })).toEqual(['saas', 'pre_revenue']);
  });

  it('drops an unknown slug rather than refusing the request', () => {
    // The same call the `ids` filter makes about malformed ULIDs: a saved view
    // written against a tag later retired should keep working on the tags it
    // still names. A 422 on a bookmark from six months ago is a worse answer
    // than a narrower result.
    expect(parseTags({ tags: 'saas,web3_native,pre_revenue' })).toEqual(['saas', 'pre_revenue']);
  });

  it('yields no filter at all when nothing in the list is a tag', () => {
    // Not an empty array — an empty `tags` array would build zero EXISTS
    // clauses and read as "unfiltered", which is what `toRepoFilters` is
    // collapsing to undefined here.
    expect(parseTags({ tags: 'web3_native,quantum' })).toBeUndefined();
    expect(parseTags({ tags: '' })).toBeUndefined();
    expect(parseTags({ tags: ',,,' })).toBeUndefined();
  });

  it('caps the conjunction at twelve slugs', () => {
    const many = TAG_CATALOGUE.slice(0, 20).map((t) => t.slug);
    expect(parseTags({ tags: many.join(',') })).toHaveLength(12);
  });

  it('refuses a query string long enough to be an attack', () => {
    expect(() => ValuationFilterQuery.parse({ tags: 'saas,'.repeat(200) })).toThrow();
  });

  it('leaves the filter absent when the parameter is not given', () => {
    expect(parseTags({})).toBeUndefined();
  });
});
