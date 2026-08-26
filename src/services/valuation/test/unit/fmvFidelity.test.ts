/**
 * One number, six renderings, no drift.
 *
 * The concluded FMV per share is what a 409A engagement produces. It is
 * computed once — `engine/compute.py` rounds it to four decimals — and then
 * restated by six independent pieces of code on its way to a customer: the
 * denormalised `calculations.fmv_per_share` column, the report body's
 * `{{fmv_per_share}}`, the executive summary's headline, Exhibit H's closing
 * line, the FMV-over-time chart, and the comparison against another engagement.
 *
 * Each of those was written separately and each chose its own precision. The
 * ones that read `results` share a value but not a formatter; the ones that
 * read the column share neither. Nothing asserted that all six agree, so the
 * question "does the platform state the same figure everywhere" had never been
 * asked in one place. This asks it.
 *
 * The frontend half of the same contract is
 * `web-frontend/test/perShareFidelity.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { reportFigures } from '../../src/domain/reportFigures.js';
import { buildReportSummary, formatCurrency } from '../../src/domain/reportSummary.js';
import { discountExhibit } from '../../src/domain/reportExhibits.js';
import { compareValuations, type CompareSide } from '../../src/domain/valuationCompare.js';
import { buildBridge } from '../../src/domain/valuationBridge.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

/**
 * A conclusion whose fourth decimal is load-bearing: struck between two cents,
 * so any renderer that rounds to two states a different number, and any that
 * drops trailing zeros states it to a different precision.
 */
const FMV = 2.5013;

const RESULTS = {
  equity_value: 42_664_609.74,
  fmv_per_share: FMV,
  common_equity_value: 19_900_044.87,
  fully_diluted_common: 9_250_000,
  allocation_method: 'opm',
  allocation: { common_per_share: 3.6001, method: 'opm' },
  assumptions: { time_to_exit_years: 4, risk_free_rate: 0.0421, volatility: 0.62 },
  discounts: { dloc: 0.08, dlom: 0.2448, dlom_method: 'finnerty' },
  approaches: { opm_backsolve: { weight: 1, equity_value: 42_664_609.74 } },
};

function calculation(over: Partial<CalculationRow> = {}): CalculationRow {
  return {
    id: '01J000000000000000000000',
    valuation_id: '01J000000000000000000001',
    engine_version: 'py-1.0.0',
    status: 'succeeded',
    inputs: { params: {}, inputs: { valuation_date: '2026-07-01' } },
    results: RESULTS,
    equity_value: '42664609.74',
    // `numeric`, which node-pg hands back as text. Written from the same engine
    // field as `results.fmv_per_share` — see `runCompute` in routes/calculations.
    fmv_per_share: '2.5013',
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...over,
  } as CalculationRow;
}

/** What the engine concluded, stated the one way the platform states it. */
const CONCLUSION = '$2.5013';

describe('the concluded FMV per share survives every hop intact', () => {
  it('is stored in the column and the result document as the same number', () => {
    // Two storages, one write. They can only agree by being written from the
    // same expression, and a divergence here is a row whose typed column and
    // whose result document disagree about what the engine said.
    const calc = calculation();
    expect(Number(calc.fmv_per_share)).toBe((calc.results as typeof RESULTS).fmv_per_share);
  });

  it('reaches the report body at the precision it was concluded at', () => {
    expect(reportFigures(calculation(), 'USD').fmv_per_share).toBe(CONCLUSION);
  });

  it('reaches the executive summary headline as the same string', () => {
    const summary = buildReportSummary(calculation(), { currency: 'USD', companyName: 'Acme' });
    expect(summary?.headline.value).toBe(CONCLUSION);
  });

  it('closes Exhibit H on the same string', () => {
    const exhibit = discountExhibit(RESULTS, { currency: 'USD', companyName: 'Acme' });
    const flat = JSON.stringify(exhibit);
    expect(flat).toContain(CONCLUSION);
  });

  it('plots the trend chart in the same digits', () => {
    const summary = buildReportSummary(calculation(), {
      currency: 'USD',
      companyName: 'Acme',
      history: [
        { as_of: '2025-07-01T00:00:00Z', fmv_per_share: 1.11 },
        { as_of: '2026-07-01T00:00:00Z', fmv_per_share: FMV },
      ],
    });
    const trend = summary?.charts.find((c) => c.title.includes('over time'));
    expect(trend?.points.at(-1)?.display).toBe(CONCLUSION);
    // The value plotted is the number, not the string it prints as.
    expect(trend?.points.at(-1)?.value).toBe(FMV);
  });

  it('is the number the comparison reports, not a re-derivation of it', () => {
    const side = (id: string, fmv: number): CompareSide => ({
      valuation_id: id,
      company_name: 'Acme',
      kind: '409a',
      currency: 'USD',
      state: 'published',
      calculation_id: `calc-${id}`,
      engine_version: 'py-1.0.0',
      calculated_at: '2026-07-01T00:00:00Z',
      valuation_date: '2026-07-01',
      results: { ...RESULTS, fmv_per_share: fmv },
    });
    const groups = compareValuations(side('a', 1.11), side('b', FMV));
    const row = groups.flatMap((g) => g.rows).find((r) => r.key === 'fmv_per_share');
    expect(row?.b).toBe(FMV);
    expect(row?.a).toBe(1.11);
  });

  it('bridges between two runs without either end losing a digit', () => {
    const bridge = buildBridge({ ...RESULTS, fmv_per_share: 2.5013 }, { ...RESULTS, fmv_per_share: 2.5104 });
    expect(bridge.from_fmv).toBe(2.5013);
    expect(bridge.to_fmv).toBe(2.5104);
    // The walk is 91 ten-thousandths. A bridge that reported it as $0.01 — or
    // as nothing — is a page that cannot do the one thing it exists for.
    expect(bridge.delta).toBeCloseTo(0.0091, 10);
  });

  /**
   * The guard the five assertions above rest on. `formatCurrency(…, 4)` is the
   * convention every one of them reaches for, so a change to its digit count
   * silently moves all six renderings together and none of the equalities
   * above would notice.
   */
  it('states four decimals, padding rather than trimming', () => {
    expect(formatCurrency(FMV, 'USD', 4)).toBe('$2.5013');
    expect(formatCurrency(2.5, 'USD', 4)).toBe('$2.5000');
    expect(formatCurrency(124.5678, 'USD', 4)).toBe('$124.5678');
  });

  it('denominates in the engagement currency, never a default', () => {
    const gbp = buildReportSummary(calculation(), { currency: 'GBP', companyName: 'Acme' });
    expect(gbp?.headline.value).toBe('£2.5013');
    expect(reportFigures(calculation(), 'GBP').fmv_per_share).toBe('£2.5013');
  });

  it('renders nothing rather than a placeholder when no run has succeeded', () => {
    // A figure the platform does not have must not appear as one it does. The
    // body keeps its `{{fmv_per_share}}` marker, which is visibly unresolved.
    const failed = calculation({ status: 'failed', results: null });
    expect(reportFigures(failed, 'USD').fmv_per_share).toBeUndefined();
    expect(buildReportSummary(failed, { currency: 'USD', companyName: 'Acme' })).toBeNull();
  });
});
