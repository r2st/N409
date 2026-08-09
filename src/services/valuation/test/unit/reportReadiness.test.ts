import { describe, expect, it } from 'vitest';
import { findReportPlaceholders, reportReadiness } from '../../src/domain/reportReadiness.js';
import type { ReportContent } from '../../src/domain/report.js';
import { instantiateTemplate, templateForKind } from '../../src/domain/report.js';

/**
 * Whether the drafted body is finished.
 *
 * Found by rendering a real 409A rather than by reading code. The deliverable
 * carried an executive summary stating $1.2242, an Exhibit H deriving it from
 * the allocated value through both discounts — and, between them, a Conclusion
 * of Value chapter reading "the fair market value of one share of common stock
 * of Northwind Robotics, Inc. as of 2026-06-30 is $ … per share".
 *
 * Every QA check that existed grades a number. None of them opened the report.
 * The skeletons are right to ship fill-me markers — an analyst has to be told
 * what to supply and where — but nothing noticed when one survived to a
 * document a board reads to adopt a share price.
 */

const content = (sections: Array<{ key: string; heading: string; html: string }>): ReportContent => ({
  title: 'IRC 409A Valuation Report — Northwind Robotics, Inc.',
  sections,
});

const CONCLUSION_UNFILLED = {
  key: 'conclusion',
  heading: 'Conclusion of Value',
  html: '<p>Based on the analyses described herein, the fair market value of one share of common stock of Northwind Robotics, Inc. as of 2026-06-30 is $ … per share.</p>',
};

const CONCLUSION_FILLED = {
  key: 'conclusion',
  heading: 'Conclusion of Value',
  html: '<p>Based on the analyses described herein, the fair market value of one share of common stock of Northwind Robotics, Inc. as of 2026-06-30 is $1.2242 per share.</p>',
};

const NARRATIVE_UNFILLED = {
  key: 'qualifications',
  heading: 'Qualifications of the Valuation Analyst',
  html: '<p>Set out the professional qualifications: name, role and firm …</p>',
};

describe('finding unfilled placeholders', () => {
  it('finds the ellipsis a skeleton left behind', () => {
    const found = findReportPlaceholders(content([CONCLUSION_UNFILLED]));
    expect(found).toHaveLength(1);
    expect(found[0]!.heading).toBe('Conclusion of Value');
  });

  it('quotes the sentence, so nobody is sent hunting for the marker', () => {
    // A finding that says "section 17 has a placeholder" makes the analyst read
    // the section. One that says which sentence makes them fix it.
    const [found] = findReportPlaceholders(content([CONCLUSION_UNFILLED]));
    expect(found!.excerpt).toContain('is $ … per share');
  });

  it('finds three dots as well as the ellipsis character', () => {
    const found = findReportPlaceholders(
      content([{ ...CONCLUSION_UNFILLED, html: '<p>The value is $... per share.</p>' }]),
    );
    expect(found).toHaveLength(1);
  });

  it('reads prose, not markup', () => {
    // An ellipsis inside an attribute is not a sentence an analyst has to
    // finish, and a marker split by an inline tag still is one.
    expect(
      findReportPlaceholders(content([{ key: 'a', heading: 'A', html: '<p title="…">Done.</p>' }])),
    ).toEqual([]);
    expect(
      findReportPlaceholders(
        content([{ key: 'conclusion', heading: 'C', html: '<p>is $ <em>…</em> per share.</p>' }]),
      ),
    ).toHaveLength(1);
  });

  it('says nothing about a finished section', () => {
    expect(findReportPlaceholders(content([CONCLUSION_FILLED]))).toEqual([]);
  });
});

describe('the verdict', () => {
  it('fails a report that will not state what the shares are worth', () => {
    // The case this exists for.
    const verdict = reportReadiness(content([CONCLUSION_UNFILLED]));
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).toContain('Conclusion of Value');
  });

  it('fails an ASC 718 table of empty cells', () => {
    // A client's auditor reads that table as the measured expense.
    const verdict = reportReadiness(
      content([
        CONCLUSION_FILLED,
        { key: 'asc718', heading: 'ASC 718 Stock-Based Compensation', html: '<p>Expected term … years</p>' },
      ]),
    );
    expect(verdict.status).toBe('fail');
  });

  it('only warns about a section that does not state the answer', () => {
    // An unwritten qualifications section is an incomplete report somebody may
    // still have reason to publish; an unwritten conclusion is a report that
    // contradicts itself. Grading both as fatal would make the gate something
    // people route around.
    const verdict = reportReadiness(content([CONCLUSION_FILLED, NARRATIVE_UNFILLED]));
    expect(verdict.status).toBe('warn');
    expect(verdict.detail).toContain('Qualifications');
  });

  it('fails when a blocking section is unfilled alongside a narrative one', () => {
    const verdict = reportReadiness(content([CONCLUSION_UNFILLED, NARRATIVE_UNFILLED]));
    expect(verdict.status).toBe('fail');
    // Both are reported — the analyst fixes the document once.
    expect(verdict.placeholders).toHaveLength(2);
  });

  it('blocks on the heading when the section has no key to match', () => {
    // A report drafted from a managed (DB-backed) template carries no
    // code-authored key, and the conclusion chapter is called the same thing in
    // both kinds.
    const verdict = reportReadiness(
      content([{ key: 'sec-4', heading: 'Conclusion of Value', html: '<p>is $ … per share</p>' }]),
    );
    expect(verdict.status).toBe('fail');
  });

  it('passes a finished report', () => {
    expect(reportReadiness(content([CONCLUSION_FILLED])).status).toBe('pass');
  });

  it('passes a valuation with no report drafted at all', () => {
    // Not the same failure. A valuation with no report is not a report with
    // holes in it, and the publish path refuses that case for its own reasons.
    expect(reportReadiness(null).status).toBe('pass');
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

  it('a freshly drafted 409A does not pass — it has not been written yet', () => {
    // The point of the skeleton is that an analyst fills it in. The check has
    // to agree with that, or it is grading nothing.
    expect(reportReadiness(drafted).status).toBe('fail');
  });

  it('and the conclusion is one of the sections it names', () => {
    // With no calculation behind it, the conclusion's `{{fmv_per_share}}`
    // resolves to nothing and would reach the page as literal braces — the same
    // defect the ellipsis was, so it is graded the same way.
    const verdict = reportReadiness(drafted);
    expect(verdict.placeholders.some((p) => p.key === 'conclusion' && p.blocking)).toBe(true);
  });

  it('stops naming the conclusion once the calculation supplies its figures', () => {
    // The computed markers are *supposed* to sit in the stored body — that is
    // what lets a re-render restate the prose after a recalculation. Flagging
    // them on sight would make a finished 409A permanently unpublishable.
    const figures = {
      fmv_per_share: '$1.4947',
      equity_value: '$42,664,610',
      marketable_value_per_share: '$2.1514',
      dloc: '8.0%',
      dlom: '24.5%',
      combined_discount: '30.5%',
      volatility: '62.0%',
      risk_free_rate: '4.21%',
      time_to_exit_years: '4.00',
      asc718_underlying: '$1.4947',
      market_movement_factor: 'none applied',
      market_movement_return: 'not measured',
      market_movement_index: 'no benchmark selected',
      fully_diluted_common: '9,250,000',
      common_equity_value: '$19,900,045',
    };
    const verdict = reportReadiness(drafted, figures);
    expect(verdict.placeholders.some((p) => p.key === 'conclusion')).toBe(false);
    // ASC 718 still blocks: its per-grant rows are ellipses an analyst fills in,
    // and the calculation cannot supply them.
    expect(verdict.placeholders.some((p) => p.key === 'asc718' && p.blocking)).toBe(true);
  });

  it('does not grade a chapter the analyst hid', () => {
    /*
     * The skeleton's own instructions are written with fill-me markers in them,
     * and hiding a chapter is exactly what an analyst does when it does not
     * apply — a company with no option plan has nothing to say under ASC 718.
     * Grading the hidden text would make the toggle useless where it is most
     * wanted: the gate would refuse to publish over prose no reader will see.
     */
    const hidden = {
      title: 'T',
      sections: [
        { ...CONCLUSION_UNFILLED, hidden: true },
        { key: 'introduction', heading: 'Introduction', html: '<p>Finished prose.</p>' },
      ],
    };
    const verdict = reportReadiness(hidden);
    expect(verdict.placeholders).toEqual([]);
    expect(verdict.status).toBe('pass');
  });

  it('grades the same chapter again once it is unhidden', () => {
    // The text survived the save, so the finding has to come back with it —
    // otherwise hiding a chapter to clear the gate and unhiding it afterwards
    // would publish the unfilled marker.
    const shown = content([CONCLUSION_UNFILLED]);
    expect(findReportPlaceholders(shown).some((p) => p.key === 'conclusion' && p.blocking)).toBe(true);
  });

  it('names a computed marker no calculation resolves', () => {
    const content = {
      title: 'T',
      sections: [
        { key: 'conclusion', heading: 'Conclusion of Value', html: '<p>FMV is {{made_up_key}}.</p>' },
      ],
    };
    const verdict = reportReadiness(content, { fmv_per_share: '$1' });
    expect(verdict.status).toBe('fail');
    expect(verdict.placeholders[0]!.key).toBe('conclusion');
  });
});
