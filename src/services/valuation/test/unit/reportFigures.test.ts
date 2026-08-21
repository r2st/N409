import { describe, expect, it } from 'vitest';
import { fillFigures, reportFigures } from '../../src/domain/reportFigures.js';
import { instantiateTemplate, templateForKind } from '../../src/domain/report.js';
import { resolveExhibitReferences } from '../../src/domain/reportExhibitIndex.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

/**
 * The schedules a fully-populated 409A run produces, titled as the builders
 * title them (`domain/reportExhibits.ts`). The body's exhibit pointers and its
 * index are resolved against this list, so a heading that drifts from the
 * builder's drops the pointer that names it — which is the behaviour under test.
 */
const EXHIBITS_BUILT = [
  'Exhibit A — Capitalization Table',
  'Exhibit B — Reconciliation of Valuation Approaches',
  'Exhibit C — Income Approach (Discounted Cash Flow)',
  'Exhibit C-1 — Basis of the Cash-Flow Forecast',
  'Exhibit D — Market Approach (Guideline Multiples)',
  'Exhibit D-1 — Guideline Company Set',
  'Exhibit E — Asset Approach',
  'Exhibit F — Allocation of Equity Value',
  'Exhibit F-1 — Selected Volatility',
  'Exhibit G — Probability-Weighted Expected Return Scenarios',
  'Exhibit H — Discounts and Concluded Value',
  'Exhibit H-1 — Marketability Discount: Derivation',
  'Appendix I — Discount Rate Build-Up (WACC)',
  'Appendix II — Historical Financial Statements',
];

/**
 * The defect these cover shipped on every 409A this platform produced: the
 * Conclusion of Value chapter read "the fair market value … is $ … per share"
 * three pages after the summary page printed the concluded figure. Every test
 * in the suite passed while it did, because nothing asserted on the body.
 */

const RESULTS = {
  equity_value: 42_664_609.74,
  fmv_per_share: 1.4947,
  common_equity_value: 19_900_044.87,
  fully_diluted_common: 9_250_000,
  allocation: { common_per_share: 2.151356 },
  assumptions: { time_to_exit_years: 4, risk_free_rate: 0.0421, volatility: 0.62 },
  discounts: { dloc: 0.08, dlom: 0.2448, dlom_method: 'finnerty' },
  market_movement: { factor: 0.899, index_return: -0.0878, index_name: 'S&P Software' },
};

function calculation(over: Partial<CalculationRow> = {}): CalculationRow {
  return {
    id: '01J000000000000000000000',
    valuation_id: '01J000000000000000000001',
    engine_version: 'py-1.0.0',
    status: 'succeeded',
    inputs: { params: {}, inputs: {} },
    results: RESULTS,
    equity_value: '42664609.74',
    fmv_per_share: '1.4947',
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...over,
  } as CalculationRow;
}

describe('reportFigures', () => {
  it('formats the concluded figures the body names', () => {
    const figures = reportFigures(calculation(), 'USD');
    // Four decimals on a per-share figure and none on an aggregate — the same
    // convention Exhibit H and the summary page use, so the body agrees with
    // them digit for digit rather than merely in value.
    expect(figures.fmv_per_share).toBe('$1.4947');
    expect(figures.equity_value).toBe('$42,664,610');
    expect(figures.marketable_value_per_share).toBe('$2.1514');
    expect(figures.fully_diluted_common).toBe('9,250,000');
    // Exactly, not to a tenth: the conclusion chapter states both rates in a
    // sentence that derives the concluded value from them, and Exhibit H states
    // the same two beside the money each took out. A rate rounded for reading
    // does not reconcile in either place.
    expect(figures.dloc).toBe('8.0%');
    expect(figures.dlom).toBe('24.48%');
    expect(figures.volatility).toBe('62.0%');
    expect(figures.time_to_exit_years).toBe('4.00');
    expect(figures.risk_free_rate).toBe('4.21%');
  });

  it('computes the combined discount rather than adding the two', () => {
    // 8% then 24.48% multiplicatively is 30.5216%, not 32.48%. On a per-share
    // figure that gap is the difference between two defensible conclusions, and
    // the prose states it in words where nothing else does.
    expect(reportFigures(calculation(), 'USD').combined_discount).toBe('30.5216%');
  });

  /**
   * The conclusion chapter is a derivation, not a summary: it names the
   * allocated value, both discounts and the combined rate, and ends on the
   * concluded figure. A reader with a calculator has to arrive at the same
   * place, and until the rates were stated exactly they did not — the body
   * rounded them for reading while Exhibit H, five pages later, printed them to
   * the precision they were applied at.
   */
  it('states discounts a reader can reproduce the conclusion from', () => {
    const figures = reportFigures(calculation(), 'USD');
    const pct = (s: string) => Number(s.replace('%', '')) / 100;
    // The allocated value as the engine holds it, not as the page rounds it —
    // so what is under test is the precision of the rates and nothing else.
    const base = RESULTS.allocation.common_per_share;

    // Applied in turn, as Exhibit H applies them.
    const stepwise = base * (1 - pct(figures.dloc!)) * (1 - pct(figures.dlom!));
    expect(stepwise).toBeCloseTo(1.4947, 4);

    // And as the conclusion sentence states them, in one move.
    const combined = base * (1 - pct(figures.combined_discount!));
    expect(combined).toBeCloseTo(1.4947, 4);
  });

  it('keeps the body and Exhibit H stating one rate rather than two', () => {
    // The two are formatted by different modules against the same result, and
    // the only thing keeping them in step is that both call `formatExactPercent`.
    const results = { ...RESULTS, discounts: { ...RESULTS.discounts, dloc: 0.1234, dlom: 0.3142 } };
    const figures = reportFigures(calculation({ results } as Partial<CalculationRow>), 'USD');
    expect(figures.dloc).toBe('12.34%');
    expect(figures.dlom).toBe('31.42%');
    expect(figures.combined_discount).toBe('39.882772%');
  });

  it('carries the market movement adjustment', () => {
    const figures = reportFigures(calculation(), 'USD');
    expect(figures.market_movement_factor).toBe('0.8990x');
    expect(figures.market_movement_return).toBe('-8.8%');
    // Escaped on the way in — the renderer decodes entities, so the page reads
    // "S&P Software". See the note on `esc` in the module.
    expect(figures.market_movement_index).toBe('S&amp;P Software');
  });

  it('inverts the discount chain when the allocation reports no per-share value', () => {
    const results = { ...RESULTS, allocation: null };
    const figures = reportFigures(calculation({ results } as Partial<CalculationRow>), 'USD');
    // fmv / ((1 − dloc)(1 − dlom)) — the identity `compute` guarantees, so the
    // body's derivation sentence still closes. A cent-fraction off the direct
    // figure ($2.1514), because the engine rounds `fmv_per_share` to four
    // decimals before this inverts it; the allocation's own value is used
    // whenever it reports one, which is every run with a cap table.
    expect(figures.marketable_value_per_share).toBe('$2.1513');
  });

  it('returns nothing for a calculation that has not succeeded', () => {
    expect(reportFigures(calculation({ status: 'failed' }), 'USD')).toEqual({});
    expect(reportFigures(calculation({ status: 'running' }), 'USD')).toEqual({});
    expect(reportFigures(null, 'USD')).toEqual({});
  });

  it('omits a figure the results do not carry rather than printing a placeholder value', () => {
    const results = { fmv_per_share: 1.5 };
    const figures = reportFigures(calculation({ results } as Partial<CalculationRow>), 'USD');
    expect(figures.fmv_per_share).toBe('$1.5000');
    expect(figures.equity_value).toBeUndefined();
    expect(figures.dloc).toBeUndefined();
  });

  it('says no market movement was applied rather than leaving the placeholder', () => {
    // Not adjusting the round indication is the ordinary case, not a gap, so an
    // unresolved `{{market_movement_factor}}` would flag a defect where there
    // is none. Words rather than "1.0000x", which would claim a measurement.
    const results = { fmv_per_share: 1.5 };
    const figures = reportFigures(calculation({ results } as Partial<CalculationRow>), 'USD');
    expect(figures.market_movement_factor).toBe('none applied');
    expect(figures.market_movement_return).toBe('not measured');
    expect(figures.market_movement_index).toBe('no benchmark selected');
  });

  it('follows the engagement currency', () => {
    expect(reportFigures(calculation(), 'GBP').fmv_per_share).toBe('£1.4947');
  });
});

describe('fillFigures', () => {
  const content = {
    title: 'Report',
    sections: [
      { key: 'conclusion', heading: 'Conclusion', html: '<p>FMV is {{fmv_per_share}} per share.</p>' },
    ],
  };

  it('resolves the placeholders the body carries', () => {
    const out = fillFigures(content, reportFigures(calculation(), 'USD'));
    expect(out.sections[0]!.html).toBe('<p>FMV is $1.4947 per share.</p>');
  });

  it('leaves a placeholder alone when nothing resolves it', () => {
    // Deliberate: an unresolved `{{fmv_per_share}}` is a draft nobody can
    // mistake for a conclusion, whereas an em-dash or a zero reads as an answer.
    expect(fillFigures(content, {}).sections[0]!.html).toContain('{{fmv_per_share}}');
    expect(fillFigures(content, { equity_value: '$1' }).sections[0]!.html).toContain('{{fmv_per_share}}');
  });

  it('does not mutate the stored content', () => {
    const before = JSON.stringify(content);
    fillFigures(content, reportFigures(calculation(), 'USD'));
    // The version row keeps its placeholders, so a re-render after a
    // recalculation restates the prose instead of carrying a stale number.
    expect(JSON.stringify(content)).toBe(before);
  });

  it('resolves headings too', () => {
    const out = fillFigures(
      { title: 'T', sections: [{ key: 'k', heading: 'Value: {{fmv_per_share}}', html: '' }] },
      reportFigures(calculation(), 'USD'),
    );
    expect(out.sections[0]!.heading).toBe('Value: $1.4947');
  });

  it('cannot be used to inject markup', () => {
    const figures = reportFigures(
      calculation({
        results: { fmv_per_share: 1, market_movement: { factor: 1, index_name: '<img src=x>' } },
      } as Partial<CalculationRow>),
      'USD',
    );
    expect(figures.market_movement_index).toBe('&lt;img src=x&gt;');
  });
});

describe('the 409A skeleton and the figures it names', () => {
  const template = templateForKind('409a');
  const vars = {
    company_name: 'Northwind Robotics, Inc.',
    kind: '409a' as const,
    valuation_ref: '01J000000000000000000001',
    date: '2026-06-30',
    currency: 'USD',
  };

  it('leaves every computed placeholder for render time', () => {
    // Instantiation happens before the engine has run, so a computed
    // placeholder must survive it verbatim rather than resolving to nothing.
    const body = instantiateTemplate(template, vars);
    const all = body.sections.map((s) => s.html).join('');
    expect(all).toContain('{{fmv_per_share}}');
    expect(all).toContain('{{equity_value}}');
    expect(all).toContain('{{dlom}}');
  });

  it('states the conclusion once the calculation exists', () => {
    const body = fillFigures(instantiateTemplate(template, vars), reportFigures(calculation(), 'USD'));
    const conclusion = body.sections.find((s) => s.key === 'conclusion')!;
    expect(conclusion.html).toContain('$1.4947');
    expect(conclusion.html).toContain('$42,664,610');
    expect(conclusion.html).toContain('8.0%');
    expect(conclusion.html).toContain('24.48%');
    expect(conclusion.html).toContain('30.5216%');
    // The defect itself: the chapter that states the conclusion said "$ …".
    expect(conclusion.html).not.toContain('$ …');
  });

  it('leaves no ellipsis where a computed figure belongs', () => {
    /*
     * Both render steps, in the order `renderVersionPdf` performs them: the
     * exhibit index and the conditional pointers are resolved against the
     * schedules built for this run, then the figures are filled. Asserting on
     * `fillFigures` alone would read `{{exhibit_index}}` as an unfilled hole —
     * it is a marker for the other step, not for this one — and, worse, would
     * pass a body in which a `{{#exhibit:…}}` block had gone unresolved and
     * shipped its own braces to the reader.
     */
    const body = fillFigures(
      resolveExhibitReferences(instantiateTemplate(template, vars), EXHIBITS_BUILT),
      reportFigures(calculation(), 'USD'),
    );
    // The ASC 718 rows that belong to the *grants* keep their ellipsis — they
    // are measured against the awards on file, not by this valuation — but
    // every row the 409A supplies is filled, and no marker of either form
    // survives anywhere.
    const all = body.sections.map((s) => s.html).join('');
    expect(all).not.toMatch(/\{\{/);
    const asc718 = body.sections.find((s) => s.key === 'asc718')!;
    expect(asc718.html).toContain('$1.4947');
    expect(asc718.html).toContain('62.0%');
  });

  /**
   * The level of value the body is allowed to claim.
   *
   * Three chapters said "marketable, controlling" flat out, and for the typical
   * 409A that is wrong: a backsolve inverts the price a minority investor paid
   * and guideline public multiples are struck on minority trading prices, so
   * neither produces a controlling value. Exhibit H has printed the qualified
   * label since the engine started measuring the mix, which left the prose
   * contradicting the schedule it points the reader at.
   */
  describe('the allocated level of value', () => {
    const withMix = (weight: number | null) =>
      calculation({
        results: {
          ...RESULTS,
          discounts: {
            ...RESULTS.discounts,
            ...(weight === null ? {} : { dloc_detail: { minority_basis_weight: weight } }),
          },
        },
      });

    const body = (weight: number | null) =>
      fillFigures(instantiateTemplate(template, vars), reportFigures(withMix(weight), 'USD'));

    it('says controlling where the weight sits on control-basis approaches', () => {
      const html = body(0.2)
        .sections.map((s) => s.html)
        .join('');
      expect(html).toContain('a marketable, controlling value of');
      expect(html).toContain('on a marketable, controlling basis');
      expect(html).toContain('allocated to a marketable, controlling common value of');
    });

    it('declines to, where a majority of the weight already produced a minority value', () => {
      const html = body(0.75)
        .sections.map((s) => s.html)
        .join('');
      expect(html).not.toContain('controlling value');
      expect(html).not.toContain('controlling basis');
      expect(html).toContain('a marketable value of');
      expect(html).toContain('allocated to a marketable common value of');
    });

    /**
     * The same rule `discountExhibit` applies, and deliberately so — an
     * unmeasured mix is what a run with no weights, or with a zero DLOC that
     * cannot double-count, produces, and it is the case the wording was
     * written for.
     */
    it('reads an unmeasured mix as controlling', () => {
      expect(reportFigures(withMix(null), 'USD').allocated_level).toBe('marketable, controlling');
    });

    it('treats an even split as controlling, as the exhibit does', () => {
      expect(reportFigures(withMix(0.5), 'USD').allocated_level).toBe('marketable, controlling');
      expect(reportFigures(withMix(0.5001), 'USD').allocated_level).toBe('marketable');
    });
  });

  it('drops the pointer to a schedule this calculation did not produce', () => {
    // The asset approach carried no weight, so no Exhibit E was built. The
    // chapter explaining the approach stays — saying an approach was considered
    // and given no weight is the point of it — but it must not then send the
    // reader to a schedule that is not in the file.
    const body = resolveExhibitReferences(
      instantiateTemplate(template, vars),
      EXHIBITS_BUILT.filter((h) => !h.startsWith('Exhibit E ')),
    );
    const asset = body.sections.find((s) => s.key === 'asset_approach')!;
    expect(asset.html).toContain('The asset approach measures value');
    expect(asset.html).not.toContain('Exhibit E');
    // And the index of exhibits does not list it either.
    expect(body.sections.find((s) => s.key === 'exhibit_index')!.html).not.toContain('Exhibit E —');
  });
});
