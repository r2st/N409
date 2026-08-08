import { describe, expect, it } from 'vitest';
import {
  narrativeSectionsPayload,
  resolveNarrativeSections,
  type NarrativePromptLike,
} from '../../src/domain/narrativePrompts.js';

/**
 * Narrative prompt library resolution (migration 0114).
 *
 * The property under test is that a report type gets *its own* sections: the
 * base library where it has said nothing, and its override where it has. The
 * failure this guards against is the one the specialty deliverables already
 * had once — every kind drafted from one list, so a QSBS memorandum came back
 * discussing a marketability discount it does not have.
 */

const row = (over: Partial<NarrativePromptLike>): NarrativePromptLike => ({
  kind: null,
  section_key: 'executive_summary',
  label: 'Executive Summary',
  guidance: 'the engagement and the concluded value',
  sort_order: 10,
  enabled: true,
  ...over,
});

/** A two-section base library, enough to show ordering and displacement. */
const BASE: NarrativePromptLike[] = [
  row({ section_key: 'executive_summary', sort_order: 10 }),
  row({
    section_key: 'dlom_analysis',
    label: 'Discount for Lack of Marketability',
    guidance: 'the DLOM method chosen',
    sort_order: 70,
  }),
];

const keys = (rows: NarrativePromptLike[], kind: Parameters<typeof resolveNarrativeSections>[1]) =>
  resolveNarrativeSections(rows, kind).map((s) => s.key);

describe('resolveNarrativeSections', () => {
  it('gives a kind with no overrides the base library, in sort order', () => {
    expect(keys(BASE, '409a')).toEqual(['executive_summary', 'dlom_analysis']);
  });

  it('replaces a base section with the same-key override rather than merging', () => {
    const rows = [
      ...BASE,
      row({
        kind: 'qsbs',
        section_key: 'executive_summary',
        guidance: 'whether the stock qualifies under IRC 1202',
      }),
    ];
    const sections = resolveNarrativeSections(rows, 'qsbs');
    const summary = sections.find((s) => s.key === 'executive_summary');
    expect(summary?.guidance).toBe('whether the stock qualifies under IRC 1202');
    expect(summary?.overridden).toBe(true);
    // Exactly one executive_summary — a merge would have produced two, or one
    // saying both things.
    expect(sections.filter((s) => s.key === 'executive_summary')).toHaveLength(1);
  });

  it('adds override-only sections and orders them among the base ones', () => {
    const rows = [
      ...BASE,
      row({
        kind: 'qsbs',
        section_key: 'gross_asset_test',
        label: 'Gross Assets Test',
        guidance: 'the $50m ceiling',
        sort_order: 30,
      }),
    ];
    expect(keys(rows, 'qsbs')).toEqual([
      'executive_summary',
      'gross_asset_test',
      'dlom_analysis',
    ]);
  });

  it('drops a disabled base section', () => {
    const rows = [...BASE.slice(0, 1), row({ ...BASE[1]!, enabled: false })];
    expect(keys(rows, '409a')).toEqual(['executive_summary']);
  });

  it('lets a disabled override suppress its base section outright', () => {
    // "This deliverable has no DLOM discussion" is what turning the override
    // off means. Falling back to the base row would make the toggle a no-op on
    // exactly the kinds that need it.
    const rows = [
      ...BASE,
      row({ kind: 'ppa', section_key: 'dlom_analysis', enabled: false, sort_order: 70 }),
    ];
    expect(keys(rows, 'ppa')).toEqual(['executive_summary']);
    // ...and no other kind is affected by it.
    expect(keys(rows, '409a')).toEqual(['executive_summary', 'dlom_analysis']);
  });

  it('ignores rows belonging to a different kind', () => {
    const rows = [
      ...BASE,
      row({
        kind: 'ifrs2',
        section_key: 'vesting_conditions',
        label: 'Vesting Conditions',
        guidance: 'service, performance and market conditions',
        sort_order: 45,
      }),
    ];
    expect(keys(rows, '409a')).toEqual(['executive_summary', 'dlom_analysis']);
    expect(keys(rows, 'ifrs2')).toContain('vesting_conditions');
  });

  it('breaks a sort_order tie on section_key so the order is stable', () => {
    const rows = [
      row({ section_key: 'zulu', sort_order: 50 }),
      row({ section_key: 'alpha', sort_order: 50 }),
    ];
    expect(keys(rows, '409a')).toEqual(['alpha', 'zulu']);
  });

  it('marks base-library sections as not overridden', () => {
    expect(resolveNarrativeSections(BASE, '409a').every((s) => !s.overridden)).toBe(true);
  });
});

describe('narrativeSectionsPayload', () => {
  it('ships key/label/guidance and drops the resolution bookkeeping', () => {
    const payload = narrativeSectionsPayload(BASE, '409a');
    expect(payload).toEqual([
      { key: 'executive_summary', label: 'Executive Summary', guidance: BASE[0]!.guidance },
      { key: 'dlom_analysis', label: BASE[1]!.label, guidance: BASE[1]!.guidance },
    ]);
  });

  it('is null on an empty library, so the agent keeps its built-in sections', () => {
    // An un-migrated database should produce a complete 409A narrative, not a
    // report with no prose in it.
    expect(narrativeSectionsPayload([], '409a')).toBeNull();
    expect(narrativeSectionsPayload([row({ enabled: false })], '409a')).toBeNull();
  });
});
