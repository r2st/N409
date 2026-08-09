import { describe, expect, it } from 'vitest';
import { fillFigures, reportFigures } from '../../src/domain/reportFigures.js';
import { instantiateTemplate, templateForKind } from '../../src/domain/report.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

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
    expect(figures.dloc).toBe('8.0%');
    expect(figures.dlom).toBe('24.5%');
    expect(figures.volatility).toBe('62.0%');
    expect(figures.time_to_exit_years).toBe('4.00');
    expect(figures.risk_free_rate).toBe('4.21%');
  });

  it('computes the combined discount rather than adding the two', () => {
    // 8% then 24.5% multiplicatively is 30.5%, not 32.5%. On a per-share figure
    // that gap is the difference between two defensible conclusions, and the
    // prose states it in words where nothing else does.
    expect(reportFigures(calculation(), 'USD').combined_discount).toBe('30.5%');
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
    expect(conclusion.html).toContain('24.5%');
    // The defect itself: the chapter that states the conclusion said "$ …".
    expect(conclusion.html).not.toContain('$ …');
  });

  it('leaves no ellipsis where a computed figure belongs', () => {
    const body = fillFigures(instantiateTemplate(template, vars), reportFigures(calculation(), 'USD'));
    // The ASC 718 rows that belong to the *grants* keep their ellipsis — they
    // are measured against the awards on file, not by this valuation — but
    // every row the 409A supplies is filled, and no `{{…}}` survives anywhere.
    const all = body.sections.map((s) => s.html).join('');
    expect(all).not.toMatch(/\{\{\w+\}\}/);
    const asc718 = body.sections.find((s) => s.key === 'asc718')!;
    expect(asc718.html).toContain('$1.4947');
    expect(asc718.html).toContain('62.0%');
  });
});
