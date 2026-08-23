import { describe, expect, it } from 'vitest';
import { REPORT_TEMPLATES, templateForKind } from '../../src/domain/report.js';
import { VALUATION_KINDS, type ValuationKind } from '../../src/domain/valuation.js';

/**
 * The `authored` flag, and whether the skeletons still tell the truth with it.
 *
 * `authored` is one half of a pair. The other half is `checkUneditedGuidance`
 * in `domain/reportReview.ts`, which refuses to publish a chapter that still
 * carries the skeleton's instructions to the analyst — and it can only refuse
 * what the skeleton declares. Nothing crossed between the two: the flag was set
 * on TEMPLATE_409A when the check was written and on no skeleton since, so a
 * gate whose whole purpose is "an instruction to the analyst is not the report"
 * read one of the fifteen deliverables. The other fourteen published a
 * Conclusion of Value reading "State the concluded fair market value…" through
 * a gate that had cleared them.
 *
 * Two guards, because the flag can drift in two different ways.
 *
 * The census is the exhaustive one: the flagged keys of every skeleton, listed
 * literally. Add a chapter, rename one, decide a chapter is or is not guidance,
 * and this test fails until the list here is changed to match — which is the
 * point. It is not asking whether the decision was right; it is making the
 * decision visible in a diff.
 *
 * The detector is the semantic one, and it is what would have caught this had
 * it existed: a chapter in which *every* sentence is an instruction cannot be
 * anything but guidance, whatever anybody forgot to flag. It is deliberately
 * one-directional — all-imperative implies `authored`, never the reverse. A
 * chapter that states a standard and asks one question beside it ("The asset
 * approach measures value as… State whether the approach was applied") is a
 * judgement call the skeleton makes and this file does not second-guess, which
 * is the same line `reportReview.ts` draws when it refuses to gate on imperative
 * sentences.
 */

/**
 * Sections flagged `authored` in each skeleton, exactly.
 *
 * `qualifications` appears in all sixteen because it reaches every kind from
 * `CLOSING_SECTIONS`; for a long time it was the only entry for fourteen of
 * them, which is what this test exists to stop happening again quietly.
 */
const CENSUS: Record<string, readonly string[]> = {
  '409a': [
    'company_overview',
    'company_analysis',
    'economic_outlook',
    'industry_market',
    'financial_analysis',
    'methodology',
    'qualifications',
  ],
  fmv: ['company_overview', 'earnings_normalization', 'valuation_methods', 'conclusion', 'qualifications'],
  '718': [
    'awards',
    'underlying_value',
    'model_and_assumptions',
    'expense_recognition',
    'schedule',
    'qualifications',
  ],
  '820': ['methodology', 'portfolio_summary', 'unobservable_inputs', 'conclusion', 'qualifications'],
  gifts: [
    'interest_description',
    'company_overview',
    'valuation_analysis',
    'discounts',
    'chapter_14',
    'conclusion',
    'qualifications',
  ],
  qsbs: [
    'entity_test',
    'gross_asset_test',
    'active_business_test',
    'issuance_and_holding',
    'exclusion_cap',
    'conclusion',
    'qualifications',
  ],
  csop: ['company_overview', 'valuation_analysis', 'scheme_limits', 'conclusion', 'qualifications'],
  emi: ['company_overview', 'valuation_analysis', 'umv_amv', 'scheme_limits', 'conclusion', 'qualifications'],
  ifrs2: ['awards', 'model_and_assumptions', 'expense_recognition', 'schedule', 'qualifications'],
  ppa: [
    'transaction_overview',
    'tangible_assets',
    'intangible_assets',
    'goodwill',
    'conclusion',
    'qualifications',
  ],
  goodwill: [
    'reporting_units',
    'qualitative_assessment',
    'quantitative_tests',
    'conclusion',
    'qualifications',
  ],
  esop: [
    'company_overview',
    'valuation_approaches',
    'level_of_value',
    'repurchase_obligation',
    'conclusion',
    'qualifications',
  ],
  ip: ['asset_description', 'valuation_methods', 'conclusion', 'qualifications'],
  fund: [
    'unit_of_account',
    'hierarchy',
    'significant_inputs',
    'nav_conclusion',
    'lp_economics',
    'qualifications',
  ],
  debt: [
    'instrument_terms',
    'credit_assessment',
    'discount_rate',
    'sensitivity',
    'conclusion',
    'qualifications',
  ],
};

/** The fallback skeleton, which no kind selects but any new one would. */
const GENERIC_CENSUS = ['company_overview', 'analysis', 'conclusion', 'qualifications'];

/**
 * The verbs a chapter opens a sentence with when it is talking to the analyst.
 *
 * Drawn from the skeletons rather than from grammar: these are the words the
 * fifteen outlines actually use to ask for something. A verb missing from here
 * costs a detection, never a false failure, which is the direction to be wrong
 * in — the census above is what makes an omission visible anyway.
 */
const IMPERATIVE = new Set([
  'address',
  'build',
  'cite',
  'confirm',
  'describe',
  'disclose',
  'discuss',
  'document',
  'explain',
  'give',
  'identify',
  'include',
  'list',
  'note',
  'outline',
  'present',
  'provide',
  'say',
  'set',
  'show',
  'state',
  'summarize',
  'weigh',
]);

/**
 * The chapter's sentences, as a reader meets them.
 *
 * Block-level tags end a sentence whether or not a full stop does, so a list of
 * bullets is a list of sentences rather than one run-on. Markers become a word:
 * `{{company_name}}` opening a sentence must not make its first word "company".
 * Fragments under three words are dropped — table headings, mostly, which carry
 * no mood to read.
 */
function sentences(html: string): string[] {
  const blocks = html
    .replace(/\{\{[^}]*\}\}/g, ' X ')
    .split(/<\/(?:p|li|td|th|h[1-3])>|<br\s*\/?>/i)
    .map((b) =>
      b
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;|&#\d+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  const out: string[] = [];
  for (const block of blocks) {
    for (const sentence of block.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim();
      if (trimmed.split(/\s+/).filter(Boolean).length >= 3) out.push(trimmed);
    }
  }
  return out;
}

function isImperative(sentence: string): boolean {
  return IMPERATIVE.has((/^[A-Za-z]+/.exec(sentence)?.[0] ?? '').toLowerCase());
}

/** A chapter with something to read and nothing in it but instructions. */
function isAllGuidance(html: string): boolean {
  const read = sentences(html);
  return read.length > 0 && read.every(isImperative);
}

const EVERY_TEMPLATE: readonly [string, ReturnType<typeof templateForKind>][] = [
  ...VALUATION_KINDS.map((kind: ValuationKind): [string, ReturnType<typeof templateForKind>] => [
    kind,
    templateForKind(kind),
  ]),
  ['generic', REPORT_TEMPLATES.get('generic.v3')!],
];

describe('the authored-chapter census', () => {
  it('covers every kind, so a new report type cannot arrive unlisted', () => {
    expect(Object.keys(CENSUS).sort()).toEqual([...VALUATION_KINDS].sort());
  });

  for (const [name, template] of EVERY_TEMPLATE) {
    it(`${name} flags exactly the chapters it is recorded as flagging`, () => {
      const flagged = template.sections.filter((s) => s.authored === true).map((s) => s.key);
      expect(flagged).toEqual(name === 'generic' ? GENERIC_CENSUS : [...CENSUS[name]!]);
    });
  }
});

describe('a chapter that is nothing but instructions', () => {
  /*
   * Non-vacuity, and it is not a formality here: the detector below reports
   * nothing at all if `sentences` stops finding sentences — a change to the
   * markup helper, a skeleton written in a tag the splitter does not know — and
   * a guard that passes by having nothing left to ask is the failure mode this
   * codebase keeps finding. Fifty-two chapters read as pure guidance today.
   */
  it('is what most of these skeletons are made of', () => {
    const total = EVERY_TEMPLATE.flatMap(([, t]) => t.sections).filter((s) => isAllGuidance(s.html));
    expect(total.length).toBeGreaterThanOrEqual(50);
  });

  it('reads as guidance in the chapters the 409A already flagged', () => {
    const t = templateForKind('409a');
    const overview = t.sections.find((s) => s.key === 'company_overview')!;
    expect(isAllGuidance(overview.html)).toBe(true);
  });

  it('is not what a chapter stating a standard reads as', () => {
    // "The asset approach measures value as… State whether the approach was
    // applied" — one instruction inside a chapter that is otherwise the report.
    const t = templateForKind('409a');
    const asset = t.sections.find((s) => s.key === 'asset_approach')!;
    expect(asset.html).toContain('State whether');
    expect(isAllGuidance(asset.html)).toBe(false);
    expect(asset.authored).toBeUndefined();
  });

  it('is flagged authored in every skeleton', () => {
    const unflagged: string[] = [];
    for (const [name, template] of EVERY_TEMPLATE) {
      for (const section of template.sections) {
        if (isAllGuidance(section.html) && section.authored !== true)
          unflagged.push(`${name}.${section.key}`);
      }
    }
    expect(unflagged).toEqual([]);
  });
});
