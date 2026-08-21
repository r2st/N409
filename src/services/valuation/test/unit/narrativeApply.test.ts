import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyNarrative,
  draftedSectionsFrom,
  MIN_DRAFT_LENGTH,
  NARRATIVE_SECTION_MAP,
  narrativeSectionMap,
  paragraphsToHtml,
} from '../../src/domain/narrativeApply.js';
import { resolveNarrativeSections } from '../../src/domain/narrativePrompts.js';
import type { NarrativePromptLike } from '../../src/domain/narrativePrompts.js';
import { instantiateTemplate, templateForKind } from '../../src/domain/report.js';
import type { ReportContent } from '../../src/domain/report.js';
import { VALUATION_KINDS, type ValuationKind } from '../../src/domain/valuation.js';

/**
 * Putting the drafted narrative into the report.
 *
 * The generation was never the missing piece — `report_narrative` has drafted
 * these chapters from the finished calculation for as long as the agent has
 * existed, and the research topics behind them retrieve and synthesise the
 * public record. What was missing is any path from `ai_jobs.result` into
 * `report_versions.content`, so an analyst read the draft in one tab and
 * retyped it into another. When nobody did, the 409A shipped with the
 * skeleton's instructional text where its Company Overview belonged.
 *
 * Two properties make writing it automatically defensible, and they are what
 * these tests are about: it never overwrites prose somebody wrote, and what it
 * writes goes through the same sanitizer as anything else that reaches stored
 * report HTML.
 */

const PROSE = 'A'.repeat(MIN_DRAFT_LENGTH + 20);

const doc = (sections: Array<{ key: string; heading: string; html: string }>): ReportContent => ({
  title: 'IRC 409A Valuation Report — Northwind Robotics, Inc.',
  sections,
});

const UNWRITTEN = {
  key: 'company_overview',
  heading: 'Company Overview',
  html: '<p>Describe the business of Northwind Robotics, Inc.: products, customers, stage …</p>',
};

const WRITTEN = {
  key: 'company_overview',
  heading: 'Company Overview',
  html: '<p>Northwind builds warehouse robots and sells them to third-party logistics operators.</p>',
};

describe('mapping the agent’s keys onto the report’s', () => {
  it('routes each drafted chapter to the section it belongs in', () => {
    // The two vocabularies were designed independently. Where they disagree the
    // pairing is a judgement, written out so a wrong one is arguable.
    expect(NARRATIVE_SECTION_MAP.valuation_methodology).toBe('methodology');
    expect(NARRATIVE_SECTION_MAP.allocation_methodology).toBe('allocation');
    expect(NARRATIVE_SECTION_MAP.dlom_analysis).toBe('dlom');
    expect(NARRATIVE_SECTION_MAP.industry_overview).toBe('industry_market');
  });

  it('leaves the executive summary out on purpose', () => {
    // The PDF builds its own summary page from the calculation — headline FMV,
    // the figures grid, the charts. A drafted prose summary would sit beside it
    // saying the same things in a voice nothing verified. Written as an
    // explicit null so the outcome reads `suppressed` — a decision — rather
    // than `unmatched`, which is what a mapping bug looks like.
    expect(NARRATIVE_SECTION_MAP.executive_summary).toBeNull();
    const out = applyNarrative(doc([UNWRITTEN]), [{ key: 'executive_summary', body: PROSE }]);
    expect(out.applied[0]).toMatchObject({ section_key: null, outcome: 'suppressed' });
    expect(out.changed).toBe(false);
  });

  it('falls through to the key itself when the two already agree', () => {
    const out = applyNarrative(doc([{ key: 'conclusion', heading: 'C', html: '<p>… </p>' }]), [
      { key: 'conclusion', body: PROSE },
    ]);
    expect(out.applied[0]!.section_key).toBe('conclusion');
    expect(out.applied[0]!.outcome).toBe('written');
  });

  it('reports a chapter this report has no home for', () => {
    const out = applyNarrative(doc([UNWRITTEN]), [{ key: 'repurchase_obligation', body: PROSE }]);
    expect(out.applied[0]).toMatchObject({ section_key: null, outcome: 'unmatched' });
    expect(out.changed).toBe(false);
  });
});

/**
 * The map above is the 409A's vocabulary, and it was applied to all fifteen
 * deliverables. The prompt library has drafted per-kind sections since it was
 * seeded and the skeletons have carried per-kind chapters for as long; nothing
 * joined the two, so an ASC 820 report's hierarchy chapter — the classification
 * an auditor tests first — was drafted, found no section of that name, recorded
 * `unmatched`, and thrown away with a success reported to the route.
 *
 * The seeded library is the input to that, so it is what these tests read: the
 * migration itself, parsed, rather than a copy of it that can fall out of step
 * with the rows a database actually holds.
 */
describe('every deliverable’s own vocabulary', () => {
  // All three parts of the library: 0114 seeded the base and five kinds, 0141
  // five more, 0145 the last six. Read together because that is how the
  // database holds them — testing 0114 alone would assert the state of a
  // schema no deployment is in.
  const SEED = [
    '0114_narrative_prompt_library',
    '0141_specialty_narrative_prompts',
    '0145_specialty_narrative_prompts_part_two',
  ]
    .map((name) => readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8'))
    .join('\n');

  /**
   * The seeded rows, as `resolveNarrativeSections` takes them. Ids are prefixed
   * `01N409NARR`, which is what makes them findable; a row's `enabled` is the
   * trailing `false` on its tuple, and its absence means the column default.
   * Every seeded tuple opens `(id, kind, section_key, label,` on one line, so
   * the label comes off the same match rather than a second parse.
   */
  const seededRows = (): NarrativePromptLike[] => {
    const starts = [...SEED.matchAll(/\('01N409NARR\d+',\s*(NULL|'[^']*'),\s*'([^']+)',\s*'([^']+)'/g)];
    return starts.map((m, i) => {
      const tuple = SEED.slice(m.index, starts[i + 1]?.index ?? SEED.length);
      return {
        kind: m[1] === 'NULL' ? null : (m[1]!.slice(1, -1) as ValuationKind),
        section_key: m[2]!,
        label: m[3]!,
        guidance: '',
        sort_order: 0,
        enabled: !/,\s*false\s*\)/.test(tuple),
      };
    });
  };

  it('reads the seeded library, so a mis-parse cannot pass these tests', () => {
    const rows = seededRows();
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.kind === null)).toHaveLength(8);
    // The suppressions — a disabled kind row is how a deliverable says "not
    // this section", and reading them as enabled would make the sweep below
    // demand a home for chapters nobody drafts.
    expect(rows.some((r) => r.kind === 'qsbs' && r.section_key === 'dlom_analysis' && !r.enabled)).toBe(true);
  });

  /**
   * The sweep that would have caught this. Every section the library drafts for
   * a kind must land in a chapter that kind's skeleton actually has, or be
   * suppressed in so many words — silently discarding it is the one outcome
   * that is never a decision anybody made.
   */
  it('gives every drafted section a home, or says why it has none', () => {
    const rows = seededRows();
    for (const kind of VALUATION_KINDS) {
      const map = narrativeSectionMap(kind);
      const chapters = new Set(templateForKind(kind).sections.map((s) => s.key));
      for (const { key } of resolveNarrativeSections(rows, kind)) {
        const target = Object.hasOwn(map, key) ? map[key] : key;
        if (target === null) continue;
        expect(
          chapters.has(target!),
          `${kind}: drafted “${key}” → “${target}”, which it has no chapter for`,
        ).toBe(true);
      }
    }
  });

  /**
   * Routing a section into a chapter of another name gets the prose to the
   * right page. It does not make the prose right: the guidance behind it is
   * still the base library's, which is the 409A's. A fund's Valuation
   * Techniques chapter was drafted from "which approaches were used and how
   * they were weighted", and a debt report's Credit Assessment from "what the
   * company does, its stage and traction, and the industry it competes in" —
   * both filed under a heading that wanted something else entirely.
   *
   * So: wherever a kind renames a section, it must also own that section's
   * guidance. The exceptions are named rather than implied, because the list
   * shrinking is the point and a silent addition to it is the regression.
   */
  it('gives a renamed chapter its own guidance, not the 409A’s', () => {
    const rows = seededRows();
    const stillGeneric = new Set<ValuationKind>();
    for (const kind of VALUATION_KINDS) {
      const map = narrativeSectionMap(kind);
      for (const { key, overridden } of resolveNarrativeSections(rows, kind)) {
        const target = Object.hasOwn(map, key) ? map[key] : key;
        const base = Object.hasOwn(NARRATIVE_SECTION_MAP, key) ? NARRATIVE_SECTION_MAP[key] : key;
        // Only a rename matters here — an identity route keeps the base
        // section's own subject, which is what the base guidance describes.
        if (target === null || target === base) continue;
        if (!overridden) stillGeneric.add(kind);
      }
    }
    // 0141 removed five kinds from this list and 0145 the last six. It is
    // empty, and it is meant to stay empty: a kind that starts renaming a
    // chapter without owning its guidance fails here.
    expect([...stillGeneric].sort()).toEqual([]);
  });

  /**
   * The chapters only these five skeletons have. Before 0141 no library row
   * named any of them, so nothing was drafted and they shipped carrying the
   * skeleton's instructions to the analyst.
   */
  it.each([
    ['718' as const, ['measurement_objective', 'awards', 'expense_recognition']],
    ['fund' as const, ['standard_of_value', 'unit_of_account', 'lp_economics']],
    ['debt' as const, ['instrument_terms', 'standard_of_value', 'sensitivity']],
    ['goodwill' as const, ['reporting_units', 'qualitative_assessment']],
    ['ip' as const, ['asset_description']],
  ])('drafts %s’s own chapters', (kind, expected) => {
    const drafted = resolveNarrativeSections(seededRows(), kind).map((s) => s.key);
    for (const key of expected) expect(drafted, `${kind} does not draft ${key}`).toContain(key);
  });

  /**
   * The same for the six 0145 closed. Each has chapters the 409A does not — the
   * scheme conditions HMRC tests first, the ESOP's repurchase liability, the
   * normalisation an SMB conclusion is struck on, the §§2701–2704 tests, the
   * awards an IFRS 2 report measures — and none of them had a library row, so
   * nothing was drafted and they shipped carrying the skeleton's instructions.
   */
  it.each([
    ['csop' as const, ['scheme_limits']],
    ['emi' as const, ['scheme_limits']],
    ['esop' as const, ['repurchase_obligation']],
    ['fmv' as const, ['earnings_normalization']],
    ['gifts' as const, ['chapter_14']],
    ['ifrs2' as const, ['awards']],
  ])('drafts %s’s own chapters too', (kind, expected) => {
    const drafted = resolveNarrativeSections(seededRows(), kind).map((s) => s.key);
    for (const key of expected) expect(drafted, `${kind} does not draft ${key}`).toContain(key);
  });

  /**
   * The renames 0145 gave a subject to, checked against the words that make
   * each one this deliverable's rather than the 409A's. A row seeded with the
   * base wording under a specialty label would pass the sweep above — it is
   * `overridden` either way — and these are what catch that.
   */
  it.each([
    ['emi' as const, 'dlom_analysis', 'UMV and AMV', /s\.531|unrestricted market value/],
    ['esop' as const, 'dlom_analysis', 'Level of Value & Discounts', /409\(h\)|level of value/],
    ['esop' as const, 'valuation_methodology', 'Valuation Approaches', /S corporation/],
    ['csop' as const, 'valuation_methodology', 'Valuation Analysis', /Schedule 4|unrestricted/],
    ['fmv' as const, 'valuation_methodology', 'Valuation Methods', /SDE|capitalization rate/],
    ['gifts' as const, 'valuation_methodology', 'Valuation of the Underlying Entity', /entity/],
    ['ifrs2' as const, 'valuation_methodology', 'Valuation Model & Assumptions', /Monte-Carlo/],
  ])('gives %s’s %s the label and the subject its chapter wants', (kind, key, label, matcher) => {
    // Read from the migration text rather than the parsed rows: `seededRows`
    // deliberately drops guidance, and the guidance is the whole point here.
    const tuple = new RegExp(
      String.raw`\('01N409NARR\d+',\s*'${kind}',\s*'${key}',\s*'([^']+)',\s*'((?:[^']|'')*)'`,
    ).exec(SEED);
    expect(tuple, `no seeded row for ${kind}/${key}`).not.toBeNull();
    expect(tuple![1]).toBe(label);
    expect(tuple![2], `${kind}/${key} still reads as a 409A`).toMatch(matcher);
  });

  /**
   * The other half of 0141. A section the map routes to NULL is drafted on
   * every run and discarded on every run — and asking the model to discuss a
   * marketability discount on a bond, an award or a reporting unit is an
   * invitation to invent one.
   */
  it.each(['718' as const, 'fund' as const, 'debt' as const, 'goodwill' as const, 'ip' as const])(
    'stops asking %s for the equity sections it has no chapter for',
    (kind) => {
      const drafted = resolveNarrativeSections(seededRows(), kind).map((s) => s.key);
      expect(drafted).not.toContain('allocation_methodology');
      expect(drafted).not.toContain('dlom_analysis');
      expect(drafted).not.toContain('market_approach');
    },
  );

  /**
   * The sweep that makes the rule general rather than a list. Any section a
   * kind's map sends to NULL is drafted on every run and thrown away on every
   * run, and the expensive half of that is not the tokens — it is asking a
   * model to discuss a marketability discount on an award or an HMRC scheme,
   * which is an invitation to invent one.
   */
  it('never drafts a section its own map suppresses', () => {
    const rows = seededRows();
    for (const kind of VALUATION_KINDS) {
      const map = narrativeSectionMap(kind);
      for (const { key } of resolveNarrativeSections(rows, kind)) {
        // The base map's own nulls are the exception: `executive_summary` is
        // drafted for every kind and consumed outside the deliverable.
        if (NARRATIVE_SECTION_MAP[key] === null) continue;
        expect(map[key], `${kind} drafts “${key}”, which its map discards`).not.toBeNull();
      }
    }
  });

  it('keeps the sections a specialty kind genuinely does route somewhere', () => {
    const rows = seededRows();
    // Debt is the one kind whose issuer discussion and income approach are not
    // suppressed but redirected — a blanket "specialty kinds drop these" rule
    // would have deleted the credit assessment and the discount-rate build-up.
    const debt = resolveNarrativeSections(rows, 'debt').map((s) => s.key);
    expect(debt).toContain('company_overview');
    expect(debt).toContain('income_approach');
    // And they carry debt's subject, not a startup's.
    const credit = resolveNarrativeSections(rows, 'debt').find((s) => s.key === 'company_overview');
    expect(credit?.label).toBe('Credit Assessment');
    expect(credit?.overridden).toBe(true);
  });

  it('routes the sections whose two names disagreed', () => {
    // The two the audit named. Both were drafted on every run and discarded on
    // every run.
    expect(narrativeSectionMap('820').fair_value_hierarchy).toBe('hierarchy');
    expect(narrativeSectionMap('ifrs2').measurement_basis).toBe('measurement_principles');
    // And the renames the same mismatch produced elsewhere.
    expect(narrativeSectionMap('esop').valuation_methodology).toBe('valuation_approaches');
    expect(narrativeSectionMap('fmv').valuation_methodology).toBe('valuation_methods');
    expect(narrativeSectionMap('fund').conclusion).toBe('nav_conclusion');
    expect(narrativeSectionMap('debt').income_approach).toBe('discount_rate');
  });

  it('leaves the 409A’s mapping exactly as it was', () => {
    // Its keys are what the base map was written from, and it is the one kind
    // that was never broken; a fix that moved it would be a regression.
    expect(narrativeSectionMap('409a')).toEqual(NARRATIVE_SECTION_MAP);
    expect(narrativeSectionMap()).toEqual(NARRATIVE_SECTION_MAP);
  });

  it('calls an inapplicable section suppressed rather than unmatched', () => {
    // A §1202 attestation weights no approaches and takes no discount. The
    // prose is not misrouted; there is nothing for it to say.
    const out = applyNarrative(
      doc([{ key: 'entity_test', heading: 'Eligible Corporation', html: '<p>Describe …</p>' }]),
      [
        { key: 'dlom_analysis', body: PROSE },
        { key: 'entity_test', body: PROSE },
      ],
      { kind: 'qsbs' },
    );
    expect(out.applied[0]).toMatchObject({ source_key: 'dlom_analysis', outcome: 'suppressed' });
    expect(out.applied[1]).toMatchObject({ section_key: 'entity_test', outcome: 'written' });
  });

  it('appends where a deliverable argues two drafted sections in one chapter', () => {
    // A gift report argues both discounts under "Interest-Level Discounts".
    // Writing the second over the first, or keeping the first and dropping the
    // second, each loses one of them — which is the defect being fixed.
    const dloc = 'D'.repeat(MIN_DRAFT_LENGTH + 1);
    const dlom = 'M'.repeat(MIN_DRAFT_LENGTH + 1);
    const out = applyNarrative(
      doc([{ key: 'discounts', heading: 'Interest-Level Discounts', html: '<p>State the …</p>' }]),
      [
        { key: 'dloc', body: dloc },
        { key: 'dlom_analysis', body: dlom },
      ],
      { kind: 'gifts' },
    );
    expect(out.applied.map((a) => a.outcome)).toEqual(['written', 'appended']);
    const html = out.content.sections[0]!.html;
    expect(html).toContain(dloc);
    expect(html).toContain(dlom);
    expect(html.indexOf(dloc)).toBeLessThan(html.indexOf(dlom));
  });

  it('still refuses to append onto prose an analyst wrote', () => {
    // Appending is only ever onto text this same call produced. A chapter
    // somebody has written is kept, exactly as before.
    const written = {
      key: 'discounts',
      heading: 'Interest-Level Discounts',
      html: '<p>A 22% minority discount was concluded from the control-premium studies cited.</p>',
    };
    const out = applyNarrative(
      doc([written]),
      [
        { key: 'dloc', body: PROSE },
        { key: 'dlom_analysis', body: PROSE },
      ],
      { kind: 'gifts' },
    );
    expect(out.applied.map((a) => a.outcome)).toEqual(['kept', 'kept']);
    expect(out.content.sections[0]!.html).toBe(written.html);
    expect(out.changed).toBe(false);
  });

  /**
   * The end of the story the mapping bug is: prose drafted, discarded, and the
   * skeleton's instructions delivered in its place. Asserted on the real
   * skeletons so it stays true as they grow chapters.
   */
  it('writes prose into the specialty skeletons it used to leave untouched', () => {
    const rows = seededRows();
    for (const kind of ['820', 'ifrs2', 'esop', 'fund', 'debt', 'goodwill'] as const) {
      const skeleton = instantiateTemplate(templateForKind(kind), {
        company_name: 'Northwind Robotics, Inc.',
        kind,
        valuation_ref: 'N-1001',
        date: '2026-06-30',
        currency: 'USD',
      });
      const out = applyNarrative(
        skeleton,
        resolveNarrativeSections(rows, kind).map(({ key }) => ({ key, body: PROSE })),
        { baseline: skeleton, kind },
      );
      const written = out.applied.filter((a) => a.outcome === 'written' || a.outcome === 'appended');
      expect(written.length, `${kind} had no chapter drafted into`).toBeGreaterThan(0);
      expect(
        out.applied.filter((a) => a.outcome === 'unmatched'),
        `${kind} discarded a section`,
      ).toEqual([]);
    }
  });
});

describe('what it will and will not overwrite', () => {
  it('writes into a chapter nobody has written', () => {
    const out = applyNarrative(doc([UNWRITTEN]), [{ key: 'company_overview', body: PROSE }]);
    expect(out.applied[0]!.outcome).toBe('written');
    expect(out.content.sections[0]!.html).toContain(PROSE);
    expect(out.changed).toBe(true);
  });

  it('keeps prose an analyst wrote', () => {
    // The property the whole feature rests on. A re-run silently discarding an
    // afternoon's editing is what would stop anybody using this, in a document
    // whose value is that a named appraiser stands behind it.
    const out = applyNarrative(doc([WRITTEN]), [{ key: 'company_overview', body: PROSE }]);
    expect(out.applied[0]!.outcome).toBe('kept');
    expect(out.content.sections[0]!.html).toBe(WRITTEN.html);
    expect(out.changed).toBe(false);
  });

  it('replaces written prose only when explicitly told to', () => {
    const out = applyNarrative(doc([WRITTEN]), [{ key: 'company_overview', body: PROSE }], {
      overwrite: true,
    });
    expect(out.applied[0]!.outcome).toBe('written');
    expect(out.content.sections[0]!.html).toContain(PROSE);
  });

  it('does not treat a resolvable computed marker as an unwritten chapter', () => {
    // `{{fmv_per_share}}` in the conclusion is *supposed* to be in the stored
    // body — it is what lets a re-render restate the sentence after a
    // recalculation. Reading it as a hole would have the narrative overwrite
    // the conclusion the report assembles from the run.
    const conclusion = {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: '<p>The fair market value is {{fmv_per_share}} per share.</p>',
    };
    const out = applyNarrative(doc([conclusion]), [{ key: 'conclusion', body: PROSE }], {
      figures: { fmv_per_share: '$1.4947' },
    });
    expect(out.applied[0]!.outcome).toBe('kept');
  });

  it('does treat an unresolvable one as unwritten', () => {
    // With no calculation behind it the marker reaches the page as literal
    // braces, which is a hole by any reading.
    const conclusion = {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: '<p>The fair market value is {{fmv_per_share}} per share.</p>',
    };
    const out = applyNarrative(doc([conclusion]), [{ key: 'conclusion', body: PROSE }]);
    expect(out.applied[0]!.outcome).toBe('written');
  });

  it('leaves every other chapter untouched', () => {
    const content = doc([UNWRITTEN, { key: 'dlom', heading: 'DLOM', html: '<p>Describe the DLOM …</p>' }]);
    const out = applyNarrative(content, [{ key: 'company_overview', body: PROSE }]);
    expect(out.content.sections[1]!.html).toBe(content.sections[1]!.html);
  });
});

describe('what counts as a draft worth writing', () => {
  it('refuses a fragment', () => {
    // A model with nothing to say about an unused approach returns "N/A".
    // Writing that into a chapter is worse than the instruction it replaces:
    // the instruction is visibly unfinished, "N/A." reads as a position.
    const out = applyNarrative(doc([UNWRITTEN]), [{ key: 'company_overview', body: 'N/A.' }]);
    expect(out.applied[0]!.outcome).toBe('empty');
    expect(out.content.sections[0]!.html).toBe(UNWRITTEN.html);
  });

  it('refuses an empty body', () => {
    const out = applyNarrative(doc([UNWRITTEN]), [{ key: 'company_overview', body: '   ' }]);
    expect(out.applied[0]!.outcome).toBe('empty');
  });
});

describe('what reaches stored report HTML', () => {
  it('turns blank-line-separated paragraphs into markup', () => {
    const html = paragraphsToHtml(`First paragraph.\n\nSecond paragraph.`);
    expect(html).toBe('<p>First paragraph.</p><p>Second paragraph.</p>');
  });

  it('escapes the model’s output rather than trusting it', () => {
    // These bodies land in stored report HTML and the auditor portal renders
    // stored section HTML directly — the same path that made a company named
    // `<img onerror=…>` script execution in an external reviewer's browser.
    const body = `${PROSE}\n\n<script>alert(1)</script> and 5 < 6 & rising.`;
    const out = applyNarrative(doc([UNWRITTEN]), [{ key: 'company_overview', body }]);
    const html = out.content.sections[0]!.html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('5 &lt; 6 &amp; rising');
  });

  it('folds a single newline into the paragraph rather than breaking it', () => {
    expect(paragraphsToHtml('One line\nsame paragraph.')).toBe('<p>One line same paragraph.</p>');
  });
});

describe('reading the agent’s result', () => {
  it('takes the sections it returned', () => {
    const out = draftedSectionsFrom({
      sections: [{ key: 'company_overview', title: 'Company Overview', body: 'text' }],
    });
    expect(out).toEqual([{ key: 'company_overview', title: 'Company Overview', body: 'text' }]);
  });

  it('survives a shape it did not expect', () => {
    // The result is whatever a language model produced through a parser; the
    // route must not 500 on a malformed one.
    expect(draftedSectionsFrom(null)).toEqual([]);
    expect(draftedSectionsFrom({ sections: 'nope' })).toEqual([]);
    expect(draftedSectionsFrom({ sections: [null, 42, { body: 'no key' }] })).toEqual([]);
  });

  it('defaults a missing body to empty rather than dropping the key', () => {
    // Which then reports as `empty`, so the caller is told the agent said
    // nothing about that chapter rather than the chapter silently vanishing.
    expect(draftedSectionsFrom({ sections: [{ key: 'dlom_analysis' }] })).toEqual([
      { key: 'dlom_analysis', title: undefined, body: '' },
    ]);
  });
});

describe('against the real 409A skeleton', () => {
  const drafted = instantiateTemplate(templateForKind('409a'), {
    company_name: 'Northwind Robotics, Inc.',
    kind: '409a',
    valuation_ref: '01J8Z9WQ5T7K2M4N6P8R0S1V3X',
    date: '2026-06-30',
    currency: 'USD',
  });

  it('fills the chapters the agent drafts, on a freshly drafted report', () => {
    // A freshly drafted report *is* its own baseline, so every chapter is
    // unwritten — which is exactly the state this feature exists for.
    const out = applyNarrative(
      drafted,
      Object.keys(NARRATIVE_SECTION_MAP).map((key) => ({ key, body: PROSE })),
      { baseline: drafted },
    );
    const written = out.applied.filter((a) => a.outcome === 'written').map((a) => a.section_key);
    // The chapters a 409A is actually argued in.
    for (const key of ['company_overview', 'methodology', 'income_approach', 'market_approach', 'dlom']) {
      expect(written, `${key} was not drafted into`).toContain(key);
    }
  });

  it('does not invent a chapter the skeleton does not have', () => {
    const keys = new Set(drafted.sections.map((s) => s.key));
    const out = applyNarrative(
      drafted,
      Object.keys(NARRATIVE_SECTION_MAP).map((key) => ({ key, body: PROSE })),
      { baseline: drafted },
    );
    expect(out.content.sections).toHaveLength(drafted.sections.length);
    for (const section of out.content.sections) expect(keys.has(section.key)).toBe(true);
  });
});
