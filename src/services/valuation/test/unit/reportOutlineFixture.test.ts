import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { templateForKind } from '../../src/domain/report.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';

/**
 * The known-good outline of every report this platform issues.
 *
 * What was already pinned, before this file: that each template closes with the
 * four-section block (`report.test.ts`), and that the 409A contains seven named
 * chapters (`sampleReport.test.ts`). What was not pinned is everything between
 * them — and everything about their *order*.
 *
 * That is a real hole rather than a tidy one. Twenty-one of the 409A's
 * twenty-eight chapters are named by no assertion anywhere: `purpose_and_scope`,
 * `standard_of_value`, `sources_of_information`, `company_analysis` — the
 * chapter carrying the Revenue Ruling 59-60 §4.01 factors — `methodology`, the
 * three approach chapters, `reconciliation`, `dloc`, `asc718`,
 * `use_and_distribution`. Any one of them could be deleted in an edit meant to
 * do something else and the whole suite would stay green, because every
 * surviving test asks "does it contain X" and none asks "is it still this".
 *
 * Order is worse, because nothing checked it at all. A skeleton that put
 * Conclusion of Value before Methodology, or the certification in the middle of
 * the analysis, satisfies every existing assertion. A valuation report is read
 * as an argument — sources, then analysis, then approaches, then reconciliation,
 * then conclusion — and one delivered out of order is one a reviewer sends back.
 *
 * So the fixture is the whole ordered list, per kind. It is a *golden file*: it
 * is not derived from the templates at test time, it is a copy taken when the
 * outlines were known good, and a diff against it is the finding. Regenerate it
 * deliberately, never to make a red test green:
 *
 *   node --input-type=module -e "
 *     import { templateForKind } from './src/services/valuation/dist/domain/report.js';
 *     import { VALUATION_KINDS } from './src/services/valuation/dist/domain/valuation.js';
 *     import { writeFileSync } from 'node:fs';
 *     const out = {};
 *     for (const k of VALUATION_KINDS) out[k] = templateForKind(k).sections.map((s) => s.key);
 *     writeFileSync('src/services/valuation/test/fixtures/reportOutlines.json',
 *       JSON.stringify(out, null, 2) + '\n');
 *   "
 *
 * Template *versions* are deliberately not in the fixture. Four assertions
 * already pin `409a.vNN` and a fifth would only add friction to a bump the repo
 * makes every time the skeleton changes — see the note in report.test.ts. This
 * file pins the substance instead: which chapters, in which order.
 */
const OUTLINES = JSON.parse(
  readFileSync(new URL('../fixtures/reportOutlines.json', import.meta.url), 'utf8'),
) as Record<string, string[]>;

describe('report outlines match their known-good fixture', () => {
  it('covers every valuation kind the platform renders', () => {
    // A new kind with no fixture entry is the case that would otherwise slip
    // through: the per-kind test below cannot fail for a kind it never sees.
    expect(Object.keys(OUTLINES).sort()).toEqual([...VALUATION_KINDS].sort());
  });

  it.each([...VALUATION_KINDS])('%s renders its chapters in the recorded order', (kind) => {
    const actual = templateForKind(kind).sections.map((s) => s.key);
    // toEqual on the arrays rather than set membership: the diff then names the
    // chapter that moved as well as the one that went missing.
    expect(actual).toEqual(OUTLINES[kind]);
  });

  it('has no duplicate chapter keys in any kind', () => {
    // A duplicated key renders the chapter twice and makes `sections.find(…)` —
    // which several call sites use — silently pick the first of two.
    for (const kind of VALUATION_KINDS) {
      const keys = templateForKind(kind).sections.map((s) => s.key);
      expect(new Set(keys).size, `${kind} repeats a chapter key`).toBe(keys.length);
    }
  });
});

/**
 * The chapters a 409A cannot be issued without, and why each is there.
 *
 * The fixture above catches *any* change, which makes it a good tripwire and a
 * poor explanation — a reader looking at a failed diff cannot tell which of the
 * twenty-eight chapters is load-bearing for the IRS and which is house style.
 * These are the load-bearing ones, with the authority that requires them, so a
 * future edit that proposes dropping one has to argue with the citation rather
 * than with a list.
 */
const MANDATED_409A: ReadonlyArray<{ key: string; why: string }> = [
  {
    key: 'purpose_and_scope',
    why: 'Treas. Reg. §1.409A-1(b)(5)(iv)(B) — the safe harbour is available only to a valuation made for this purpose; the report has to say which purpose that is.',
  },
  {
    key: 'standard_of_value',
    why: 'Rev. Rul. 59-60 §2.02 — fair market value is the standard the ruling defines, and a report that does not state its standard has not stated what it concluded.',
  },
  {
    key: 'sources_of_information',
    why: 'Rev. Rul. 59-60 §4.01 opens on the information relied upon; USPAP SR 10-2(a)(viii) requires it to be disclosed.',
  },
  {
    key: 'company_analysis',
    why: 'Rev. Rul. 59-60 §4.01(a)-(h) — the eight factors. This chapter is where they are addressed one by one.',
  },
  {
    key: 'capital_structure',
    why: 'The preferences and conversion rights the allocation stands on. Without it the concluded common value cannot be checked.',
  },
  {
    key: 'financial_analysis',
    why: 'Rev. Rul. 59-60 §4.01(b),(d) — book value, financial condition and earning capacity.',
  },
  {
    key: 'methodology',
    why: 'Treas. Reg. §1.409A-1(b)(5)(iv)(B)(1) — the valuation method must be described for the presumption of reasonableness to apply.',
  },
  {
    key: 'reconciliation',
    why: 'Where the approaches are weighed against each other. A report that runs three approaches and does not reconcile them has three conclusions.',
  },
  {
    key: 'allocation',
    why: 'AICPA Practice Aid — how enterprise value is allocated across the classes to reach common. The step that makes a 409A a 409A.',
  },
  {
    key: 'dlom',
    why: 'Rev. Rul. 77-287 — the marketability discount on non-marketable stock, and the largest single adjustment in most 409A conclusions.',
  },
  {
    key: 'conclusion',
    why: 'The concluded per-share fair market value. The one figure the whole document exists to state.',
  },
  {
    key: 'safe_harbor',
    why: 'Treas. Reg. §1.409A-1(b)(5)(iv)(B) — the independent-appraisal presumption being claimed, stated as claimed.',
  },
  {
    key: 'limiting_conditions',
    why: 'USPAP SR 10-2(a)(iv) — the assumptions and limiting conditions the opinion is subject to.',
  },
  {
    key: 'certification',
    why: 'USPAP SR 10-3 — the signed certification. Without it the document is an analysis, not an appraisal report.',
  },
  {
    key: 'qualifications',
    why: 'USPAP SR 10-2(a)(xii) — the appraiser’s qualifications, which is what "independent appraiser" is tested against.',
  },
];

describe('the 409A carries every chapter its authority requires', () => {
  const keys = templateForKind('409a').sections.map((s) => s.key);

  it.each(MANDATED_409A)('includes $key — $why', ({ key }) => {
    expect(keys).toContain(key);
  });

  /**
   * The argument runs forwards. Each of these is a chapter that would be
   * unreadable — or unsupportable — if it appeared before the one it rests on.
   */
  it.each([
    ['sources_of_information', 'company_analysis', 'the analysis rests on the sources it names'],
    ['company_analysis', 'methodology', 'method is chosen in light of the company, not before it'],
    ['methodology', 'income_approach', 'the approaches follow the method that selected them'],
    ['income_approach', 'reconciliation', 'nothing is reconciled before it is computed'],
    ['reconciliation', 'allocation', 'enterprise value is settled before it is allocated'],
    ['allocation', 'dlom', 'the discount applies to the allocated common value'],
    ['dlom', 'conclusion', 'the conclusion is what survives the discounts'],
    ['conclusion', 'certification', 'the certification signs a conclusion already stated'],
  ])('places %s before %s — %s', (first, second) => {
    expect(keys.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf(second)).toBeGreaterThan(keys.indexOf(first));
  });

  /**
   * The closing block is the back matter and belongs at the back. A
   * certification page in the middle of the analysis is the shape this catches.
   */
  it('keeps the closing block in the last four positions', () => {
    expect(keys.slice(-4)).toEqual([
      'safe_harbor',
      'certification',
      'qualifications',
      'exhibit_index',
    ]);
  });
});
