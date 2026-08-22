import { describe, expect, it } from 'vitest';
import { reviewReport } from '../../src/domain/reportReview.js';
import type { ReportContent } from '../../src/domain/report.js';
import { instantiateTemplate, templateForKind, TEMPLATE_VAR_NAMES } from '../../src/domain/report.js';
import { resolveExhibitReferences } from '../../src/domain/reportExhibitIndex.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';

/**
 * Whether the drafted body holds together as a document.
 *
 * Sits between the two checks that already exist and cannot see this class of
 * defect: `qaChecks` grades numbers without opening the report, and
 * `reportReadiness` opens the report but only looks for markers nobody filled.
 * Everything below is a complete sentence carrying a plausible figure — and a
 * report that does not cohere.
 */

const content = (
  sections: Array<{ key: string; heading: string; html: string; hidden?: boolean }>,
): ReportContent => ({
  title: 'IRC 409A Valuation Report — Northwind Robotics, Inc.',
  sections,
});

const EXHIBITS = [
  'Exhibit A — Capitalization Table',
  'Exhibit B — Reconciliation of Valuation Approaches',
  'Exhibit C — Income Approach (Discounted Cash Flow)',
  'Exhibit H — Discounts and Concluded Value',
];

const INCOME_SECTION = {
  key: 'income_approach',
  heading: 'Income Approach',
  html: '<p>The discounted cash-flow computation is set out in <strong>Exhibit C</strong>.</p>',
};

/** Every exhibit above, cited once, so the baseline report is coherent. */
const REFERENCES_ALL = [
  {
    key: 'capital_structure',
    heading: 'Capital Structure',
    html: '<p>The classes are set out in <strong>Exhibit A</strong>.</p>',
  },
  {
    key: 'reconciliation',
    heading: 'Reconciliation of Value Indications',
    html: '<p>The weighting is set out in <strong>Exhibit B</strong>.</p>',
  },
  INCOME_SECTION,
  {
    key: 'conclusion',
    heading: 'Conclusion of Value',
    html: '<p>The derivation is set out in <strong>Exhibit H</strong>.</p>',
  },
];

describe('reviewing the drafted report', () => {
  it('passes a body whose references all resolve', () => {
    const result = reviewReport({ content: content(REFERENCES_ALL), exhibitHeadings: EXHIBITS });
    expect(result.status).toBe('pass');
    expect(result.findings).toEqual([]);
  });

  it('treats an undrafted report as a pass rather than a failure', () => {
    // A valuation with no report is not a report with holes in it; the publish
    // path refuses that case for its own reasons.
    const result = reviewReport({ content: null, exhibitHeadings: [] });
    expect(result.status).toBe('pass');
  });

  describe('references that go nowhere', () => {
    it('fails a chapter pointing at a schedule the report does not contain', () => {
      const result = reviewReport({
        content: content([
          ...REFERENCES_ALL,
          {
            key: 'asset_approach',
            heading: 'Asset Approach',
            html: '<p>The computation is set out in <strong>Exhibit E</strong>.</p>',
          },
        ]),
        exhibitHeadings: EXHIBITS,
      });
      expect(result.status).toBe('fail');
      const found = result.findings.find((f) => f.check === 'dangling_exhibit_reference');
      expect(found?.severity).toBe('fail');
      expect(found?.section_key).toBe('asset_approach');
      expect(found?.summary).toMatch(/Exhibit E/);
    });

    it('finds a reference the analyst typed without the skeleton’s bold', () => {
      // The check reads rendered prose, so a body edited in the WYSIWYG without
      // the template's markup is graded the same as one that kept it.
      const result = reviewReport({
        content: content([
          { key: 'asset_approach', heading: 'Asset Approach', html: '<p>See Exhibit E for detail.</p>' },
        ]),
        exhibitHeadings: EXHIBITS,
      });
      expect(result.findings.some((f) => f.check === 'dangling_exhibit_reference')).toBe(true);
    });

    it('reports a chapter once however often it repeats the dead reference', () => {
      const result = reviewReport({
        content: content([
          {
            key: 'asset_approach',
            heading: 'Asset Approach',
            html: '<p>See Exhibit E.</p><p>Exhibit E sets it out.</p><p>Per Exhibit E.</p>',
          },
        ]),
        exhibitHeadings: EXHIBITS,
      });
      expect(result.findings.filter((f) => f.check === 'dangling_exhibit_reference')).toHaveLength(1);
    });

    it('checks sub-exhibits at full precision', () => {
      const result = reviewReport({
        content: content([
          {
            key: 'dlom',
            heading: 'Discount for Lack of Marketability',
            html: '<p>The class volatilities are set out in <strong>Exhibit H-1</strong>.</p>',
          },
        ]),
        exhibitHeadings: EXHIBITS,
      });
      expect(result.findings.some((f) => f.summary.includes('Exhibit H-1'))).toBe(true);
    });

    it('ignores a dead reference in a chapter that was hidden', () => {
      // A hidden chapter is genuinely absent from the deliverable, so its
      // references are not on any page a reader reaches.
      const result = reviewReport({
        content: content([
          ...REFERENCES_ALL,
          {
            key: 'asset_approach',
            heading: 'Asset Approach',
            html: '<p>See <strong>Exhibit E</strong>.</p>',
            hidden: true,
          },
        ]),
        exhibitHeadings: EXHIBITS,
      });
      expect(result.status).toBe('pass');
    });
  });

  describe('schedules nobody points at', () => {
    it('warns, without failing, on a printed exhibit no chapter cites', () => {
      const result = reviewReport({
        content: content(REFERENCES_ALL.filter((s) => s.key !== 'capital_structure')),
        exhibitHeadings: EXHIBITS,
      });
      // Still a correct schedule of real figures — untidy, not wrong.
      expect(result.status).toBe('warn');
      const found = result.findings.find((f) => f.check === 'unreferenced_exhibit');
      expect(found?.summary).toMatch(/Exhibit A/);
    });

    it('does not demand the body name every sub-exhibit', () => {
      // C-1 is supporting detail hung off Exhibit C and is reached from it.
      // Requiring a citation would fire on every well-formed DCF report.
      const result = reviewReport({
        content: content(REFERENCES_ALL),
        exhibitHeadings: [...EXHIBITS, 'Exhibit C-1 — Basis of the Cash-Flow Forecast'],
      });
      expect(result.status).toBe('pass');
    });
  });

  describe('an approach with no chapter behind it', () => {
    it('warns when a weighted approach is nowhere explained', () => {
      const result = reviewReport({
        content: content(REFERENCES_ALL),
        exhibitHeadings: EXHIBITS,
        approaches: {
          income: { weight: 0.7, equity_value: 8_000_000 },
          market: { weight: 0.3, equity_value: 9_000_000 },
        },
      });
      const found = result.findings.find((f) => f.check === 'weighted_approach_without_chapter');
      expect(found?.severity).toBe('warn');
      expect(found?.summary).toMatch(/market approach carries 30%/);
    });

    it('accepts a chapter explaining an approach that was given no weight', () => {
      // The skeletons ask for exactly this — "explain the reason for a low
      // weight or for excluding it" — so it must not read as a finding.
      const result = reviewReport({
        content: content([
          ...REFERENCES_ALL,
          {
            key: 'asset_approach',
            heading: 'Asset Approach',
            html: '<p>The asset approach was considered and given no weight.</p>',
          },
        ]),
        exhibitHeadings: EXHIBITS,
        approaches: { income: { weight: 1 }, asset: { weight: 0 } },
      });
      expect(result.status).toBe('pass');
    });

    it('passes over an approach that has no chapter of its own', () => {
      // The backsolve is an allocation mechanism, explained in the allocation
      // chapter; there is no "OPM backsolve approach" chapter to be missing.
      const result = reviewReport({
        content: content(REFERENCES_ALL),
        exhibitHeadings: EXHIBITS,
        approaches: { opm_backsolve: { weight: 1 } },
      });
      expect(result.status).toBe('pass');
    });
  });

  describe('chapters that stopped restating themselves', () => {
    const template = templateForKind('409a');

    /**
     * The whole check rests on telling an instantiation-time variable from a
     * render-time figure. If a skeleton grows a sixth variable and
     * `TEMPLATE_VAR_NAMES` is not updated with it, this check would start
     * reporting every correctly-drafted chapter that used it — so the set is
     * asserted against what instantiation actually consumes, on every kind.
     */
    it('knows every marker instantiation resolves, across all report kinds', () => {
      for (const kind of VALUATION_KINDS) {
        const drafted = instantiateTemplate(templateForKind(kind), {
          company_name: 'Northwind Robotics, Inc.',
          kind,
          valuation_ref: 'N-1001',
          date: '2026-06-30',
          currency: 'USD',
        });
        for (const section of drafted.sections) {
          const left = [...section.html.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
          const leaked = left.filter((name) => TEMPLATE_VAR_NAMES.has(name));
          expect(leaked, `${kind}/${section.key} left an instantiation variable unresolved`).toEqual([]);
        }
      }
    });

    it('warns when a computed figure was replaced with the number it resolved to', () => {
      const drafted = instantiateTemplate(template, {
        company_name: 'Northwind Robotics, Inc.',
        kind: '409a',
        valuation_ref: 'N-1001',
        date: '2026-06-30',
        currency: 'USD',
      });
      const conclusion = drafted.sections.find((s) => s.key === 'conclusion')!;
      // Exactly what an analyst does when they "just put the number in".
      conclusion.html = conclusion.html.replace(/\{\{\w+\}\}/g, '$1.2242');

      const result = reviewReport({
        content: drafted,
        exhibitHeadings: EXHIBITS,
        template,
      });
      const found = result.findings.find((f) => f.check === 'frozen_figure');
      expect(found?.severity).toBe('warn');
      expect(found?.section_key).toBe('conclusion');
      expect(found?.summary).toMatch(/recalculation will leave the numbers in it unchanged/);
    });

    it('says nothing about a chapter that kept its placeholders', () => {
      const drafted = instantiateTemplate(template, {
        company_name: 'Northwind Robotics, Inc.',
        kind: '409a',
        valuation_ref: 'N-1001',
        date: '2026-06-30',
        currency: 'USD',
      });
      const result = reviewReport({ content: drafted, exhibitHeadings: EXHIBITS, template });
      expect(result.findings.some((f) => f.check === 'frozen_figure')).toBe(false);
    });

    it('says nothing about chapters the skeleton never wrote as self-restating', () => {
      const result = reviewReport({
        content: content([
          { key: 'certification', heading: 'Appraiser Certification', html: '<p>We certify that…</p>' },
        ]),
        exhibitHeadings: [],
        template,
      });
      expect(result.findings.some((f) => f.check === 'frozen_figure')).toBe(false);
    });

    it('skips the check when there is no skeleton to compare against', () => {
      // A body drafted from a managed (DB-backed) template has no code
      // skeleton; the check is skipped rather than guessed at.
      const result = reviewReport({
        content: content([
          { key: 'conclusion', heading: 'Conclusion of Value', html: '<p>The value is $1.2242.</p>' },
        ]),
        exhibitHeadings: [],
      });
      expect(result.findings.some((f) => f.check === 'frozen_figure')).toBe(false);
    });
  });

  describe('chapters that ship the skeleton’s instructions', () => {
    const template = templateForKind('409a');
    const pristine = () =>
      instantiateTemplate(template, {
        company_name: 'Northwind Robotics, Inc.',
        kind: '409a',
        valuation_ref: 'N-1001',
        date: '2026-06-30',
        currency: 'USD',
      });

    const guidanceFindings = (content: ReportContent) =>
      reviewReport({ content, exhibitHeadings: EXHIBITS, template }).findings.filter(
        (f) => f.check === 'unedited_template_guidance',
      );

    it('fails a chapter still carrying the template’s instructions to the analyst', () => {
      const found = guidanceFindings(pristine()).find((f) => f.section_key === 'industry_market');
      expect(found?.severity).toBe('fail');
      expect(found?.heading).toBe('Industry & Market Analysis');
      expect(found?.summary).toMatch(/instructions to the analyst/);
    });

    /**
     * The list is a judgement about which skeleton text is a to-do item and
     * which is the report, and it is pinned here so that adding a chapter of
     * instructions to the skeleton without flagging it — which is exactly how
     * these six shipped — fails a test rather than a deliverable.
     */
    it('names every unwritten chapter of a pristine 409A, and only those', () => {
      expect(
        guidanceFindings(pristine())
          .map((f) => f.section_key)
          .sort(),
      ).toEqual([
        'company_analysis',
        'company_overview',
        'economic_outlook',
        'financial_analysis',
        'industry_market',
        'methodology',
        'qualifications',
      ]);
    });

    it('says nothing about the chapters a skeleton delivers verbatim', () => {
      // The standard of value, the safe harbor and the certification are
      // written once and shipped as they are; an unedited one is finished, not
      // unwritten, and a check that could not tell the difference would refuse
      // every report ever drafted.
      const keys = guidanceFindings(pristine()).map((f) => f.section_key);
      for (const key of ['standard_of_value', 'safe_harbor', 'certification', 'use_and_distribution']) {
        expect(keys, `${key} is boilerplate, not guidance`).not.toContain(key);
      }
    });

    it('passes a chapter the analyst has written', () => {
      const drafted = pristine();
      const section = drafted.sections.find((s) => s.key === 'industry_market')!;
      section.html = '<p>Warehouse automation grew 19% in the year to the valuation date.</p>';
      expect(guidanceFindings(drafted).some((f) => f.section_key === 'industry_market')).toBe(false);
    });

    it('fails a chapter that gained prose and kept the instruction under it', () => {
      // The half-edited chapter is the case an equality test misses, and it
      // delivers the instruction just as surely as the untouched one.
      const drafted = pristine();
      const section = drafted.sections.find((s) => s.key === 'financial_analysis')!;
      section.html = `<p>Revenue reached $4.1m with 14 months of runway.</p>${section.html}`;
      expect(guidanceFindings(drafted).some((f) => f.section_key === 'financial_analysis')).toBe(true);
    });

    /**
     * The body this check grades has been through `resolveExhibitReferences`,
     * and the skeleton it is graded against has not.
     *
     * That difference is the whole of this case. `financial_analysis` closes
     * with two `{{#exhibit:…}}` pointers at the financial appendices, and the
     * resolver deletes such a block *whole* when the appendix was not printed.
     * The comparison split the skeleton on its markers and required every
     * literal run to survive — so the runs inside those two blocks were
     * required, were missing for a reason nobody chose, and the chapter read as
     * edited. The instruction went out under a heading the gate had cleared.
     *
     * The cases above never saw it because they grade a body straight out of
     * `instantiateTemplate`, where the markers are still in the text and every
     * fragment therefore matches. Both halves have to be crossed in one test or
     * the hole reopens.
     */
    it('still names an unwritten chapter whose conditional exhibit pointers were dropped', () => {
      const resolved = resolveExhibitReferences(pristine(), ['Exhibit A — Capitalization Table']);
      const section = resolved.sections.find((s) => s.key === 'financial_analysis')!;
      expect(section.html, 'the resolver should have dropped the appendix pointers').not.toContain(
        'Appendix II',
      );
      expect(
        reviewReport({ content: resolved, exhibitHeadings: EXHIBITS, template })
          .findings.filter((f) => f.check === 'unedited_template_guidance')
          .map((f) => f.section_key),
      ).toContain('financial_analysis');
    });

    it('does not invent a finding for a chapter written over a dropped pointer', () => {
      // The other direction: an analyst who replaced the instruction has a
      // finished chapter whether or not the appendices printed, and stripping
      // the conditional runs must not make every rewritten chapter match.
      const drafted = pristine();
      const section = drafted.sections.find((s) => s.key === 'financial_analysis')!;
      section.html = '<p>Revenue reached $8.4m against a $1.2m first-year outflow.</p>';
      const resolved = resolveExhibitReferences(drafted, ['Exhibit A — Capitalization Table']);
      expect(
        reviewReport({ content: resolved, exhibitHeadings: EXHIBITS, template })
          .findings.filter((f) => f.check === 'unedited_template_guidance')
          .map((f) => f.section_key),
      ).not.toContain('financial_analysis');
    });

    it('ignores a chapter the analyst hid', () => {
      // Hiding is the editor's existing answer to "this engagement has nothing
      // to say here", and a hidden chapter is not in the deliverable at all.
      const drafted = pristine();
      for (const section of drafted.sections) section.hidden = true;
      expect(guidanceFindings(drafted)).toEqual([]);
    });

    it('skips the check when there is no skeleton to compare against', () => {
      const result = reviewReport({
        content: content([
          {
            key: 'industry_market',
            heading: 'Industry & Market Analysis',
            html: '<p>Summarize the industry landscape, market size and growth, and competitive positioning.</p>',
          },
        ]),
        exhibitHeadings: [],
      });
      expect(result.findings.some((f) => f.check === 'unedited_template_guidance')).toBe(false);
    });

    /**
     * The qualifications chapter reaches the other fourteen deliverables from
     * `CLOSING_SECTIONS`, so the check has to cover them too — an ESOP report
     * shipping "Name, role and firm" as its analyst credentials is the same
     * defect as the 409A doing it.
     */
    it('covers the qualifications chapter of every report kind', () => {
      for (const kind of VALUATION_KINDS) {
        const skeleton = templateForKind(kind);
        const drafted = instantiateTemplate(skeleton, {
          company_name: 'Northwind Robotics, Inc.',
          kind,
          valuation_ref: 'N-1001',
          date: '2026-06-30',
          currency: 'USD',
        });
        const result = reviewReport({ content: drafted, exhibitHeadings: [], template: skeleton });
        const found = result.findings.filter((f) => f.check === 'unedited_template_guidance');
        expect(
          found.map((f) => f.section_key),
          `${kind} did not flag its unwritten qualifications chapter`,
        ).toContain('qualifications');
      }
    });
  });

  it('fails the whole review when any finding is a dead reference', () => {
    const result = reviewReport({
      content: content([{ key: 'asset_approach', heading: 'Asset Approach', html: '<p>See Exhibit E.</p>' }]),
      exhibitHeadings: EXHIBITS,
      approaches: { market: { weight: 0.3 } },
    });
    // Warnings are present too; the gate reads the worst of them.
    expect(result.findings.length).toBeGreaterThan(1);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/Exhibit E/);
  });
});

/**
 * A figure the prose froze, and the calculation has since moved past.
 *
 * `frozen_figure` is about a chapter that *will* go stale — it fires on a
 * chapter with nothing left to resolve, and says a recalculation will change
 * nothing on the page. Neither it nor `reportReadiness` ever compares a number
 * in the body against the number the engine currently concludes, so the case
 * this describes — the report already states two different values, three pages
 * apart — was invisible to every deterministic check:
 *
 *   * the marker is gone, so a marker search has nothing to find;
 *   * other markers remain in the chapter, so `frozen_figure` passes it over;
 *   * the exhibits render from the live calculation and are correct, so no
 *     figure check is looking at the wrong one.
 *
 * The evidence is what makes this decidable rather than a guess: the literal in
 * the prose is not merely *a* number, it is the value this engagement's own
 * superseded run concluded. Nothing but a freeze puts that string there.
 */
describe('a figure the body froze before the calculation moved', () => {
  const CONCLUSION = (html: string) => content([{ key: 'conclusion', heading: 'Conclusion of Value', html }]);

  it('reports prose still stating the value a superseded run concluded', () => {
    const result = reviewReport({
      content: CONCLUSION(
        '<p>The fair market value of one share is <strong>$1.4947</strong> per share. ' +
          'It derives from a concluded total equity value of {{equity_value}}, less a discount ' +
          'for lack of marketability of {{dlom}}.</p>',
      ),
      exhibitHeadings: EXHIBITS,
      figures: { fmv_per_share: '$1.6120', equity_value: '$42,000,000', dlom: '23.5%' },
      supersededFigures: [{ fmv_per_share: '$1.4947', equity_value: '$38,000,000', dlom: '23.5%' }],
    });
    const stale = result.findings.filter((f) => f.check === 'stale_figure');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.section_key).toBe('conclusion');
    expect(stale[0]!.summary).toMatch(/\$1\.4947/);
    expect(stale[0]!.summary).toMatch(/\$1\.6120/);
    expect(result.status).toBe('warn');
  });

  it('says nothing when the chapter still resolves the figure from the calculation', () => {
    const result = reviewReport({
      content: CONCLUSION('<p>The fair market value of one share is {{fmv_per_share}} per share.</p>'),
      exhibitHeadings: EXHIBITS,
      figures: { fmv_per_share: '$1.6120' },
      supersededFigures: [{ fmv_per_share: '$1.4947' }],
    });
    expect(result.findings.filter((f) => f.check === 'stale_figure')).toEqual([]);
  });

  /**
   * "Revised from $1.4947 to $1.6120" is a chapter doing its job, and it
   * contains a superseded figure by design. The current value being present is
   * what separates a deliberate comparison from a freeze.
   */
  it('says nothing when the body states the current figure alongside the old one', () => {
    const result = reviewReport({
      content: CONCLUSION('<p>Revised from $1.4947 at the prior measurement date to $1.6120 per share.</p>'),
      exhibitHeadings: EXHIBITS,
      figures: { fmv_per_share: '$1.6120' },
      supersededFigures: [{ fmv_per_share: '$1.4947' }],
    });
    expect(result.findings.filter((f) => f.check === 'stale_figure')).toEqual([]);
  });

  /** A figure the run did not move is not stale, however it got into the prose. */
  it('says nothing about a frozen figure the recalculation left where it was', () => {
    const result = reviewReport({
      content: CONCLUSION('<p>A discount for lack of marketability of 23.5% was applied.</p>'),
      exhibitHeadings: EXHIBITS,
      figures: { dlom: '23.5%' },
      supersededFigures: [{ dlom: '23.5%' }],
    });
    expect(result.findings.filter((f) => f.check === 'stale_figure')).toEqual([]);
  });

  /**
   * `$1.49` is not `$1.4947`. Matching on a bare substring would report the
   * current figure as its own superseded one on any run that added a decimal.
   */
  it('does not read a superseded figure out of a longer number', () => {
    const result = reviewReport({
      content: CONCLUSION('<p>The concluded value is $1.4947 per share.</p>'),
      exhibitHeadings: EXHIBITS,
      figures: { fmv_per_share: '$1.4947' },
      supersededFigures: [{ fmv_per_share: '$1.49' }],
    });
    expect(result.findings.filter((f) => f.check === 'stale_figure')).toEqual([]);
  });

  /** With no prior run there is no evidence, and the check must not guess. */
  it('says nothing when the engagement has no superseded run', () => {
    const result = reviewReport({
      content: CONCLUSION('<p>The concluded value is $1.4947 per share.</p>'),
      exhibitHeadings: EXHIBITS,
      figures: { fmv_per_share: '$1.6120' },
      supersededFigures: [],
    });
    expect(result.findings.filter((f) => f.check === 'stale_figure')).toEqual([]);
  });
});
