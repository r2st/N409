import { describe, expect, it } from 'vitest';
import { calculationCoverage, enabledApproaches } from '../../src/domain/valuationCounters.js';

const weights = (over: Partial<Record<string, number | null>> = {}) =>
  ({
    weight_asset: null,
    weight_opm: null,
    weight_income: null,
    weight_market: null,
    ...over,
  }) as never;

const results = (approaches: Record<string, unknown>) => ({ approaches });

/**
 * The Calculations `n/m` badge (design §7.3).
 *
 * A badge is only worth having if `n < m` means something is outstanding and
 * `n === m` means nothing is. Both halves are pinned here, because the
 * failure that matters is the quiet one: 4/4 on a run whose income approach
 * failed reads as finished work.
 */
describe('enabledApproaches', () => {
  it('counts only the approaches carrying a weight', () => {
    expect(enabledApproaches(weights({ weight_opm: 0.6, weight_market: 0.4 }))).toEqual(['opm', 'market']);
  });

  it('treats a zero weight as excluded, not as outstanding', () => {
    // An analyst who weighted three of four considered the fourth and said no.
    // Counting it would leave the badge permanently short of its denominator.
    expect(
      enabledApproaches(
        weights({ weight_asset: 0, weight_opm: 0.5, weight_income: 0.3, weight_market: 0.2 }),
      ),
    ).toEqual(['opm', 'income', 'market']);
  });

  it('falls back to all four when nothing has been weighted yet', () => {
    // Unweighted means the analyst has not chosen; an engine run computes
    // everything it has inputs for. Reporting 0/0 would say "nothing to do" on
    // the engagement with the most to do.
    expect(enabledApproaches(null)).toEqual(['asset', 'opm', 'income', 'market']);
    expect(enabledApproaches(weights())).toEqual(['asset', 'opm', 'income', 'market']);
  });

  it('reads numeric-as-string weights off the database', () => {
    expect(enabledApproaches(weights({ weight_income: '1.0' as never }))).toEqual(['income']);
  });
});

describe('calculationCoverage', () => {
  it('is n/n when every weighted approach produced a value', () => {
    expect(
      calculationCoverage(
        weights({ weight_opm: 0.7, weight_market: 0.3 }),
        results({ opm_backsolve: { equity_value: 12_000_000 }, market: { equity_value: 11_000_000 } }),
      ),
    ).toEqual({ done: 2, total: 2, missing: [] });
  });

  it('maps the UI’s approach names onto the engine’s result keys', () => {
    // The UI says `opm`, the results say `opm_backsolve`. A badge that read the
    // UI name straight off the results would report 0/1 on a completed run.
    const coverage = calculationCoverage(
      weights({ weight_opm: 1 }),
      results({ opm_backsolve: { equity_value: 1 } }),
    );
    expect(coverage).toEqual({ done: 1, total: 1, missing: [] });
  });

  it('counts an attempted-but-empty approach as missing', () => {
    // The engine writes a key for an approach it tried and could not finish.
    const coverage = calculationCoverage(
      weights({ weight_opm: 0.5, weight_income: 0.5 }),
      results({ opm_backsolve: { equity_value: 5 }, income: { equity_value: null } }),
    );
    expect(coverage).toEqual({ done: 1, total: 2, missing: ['income'] });
  });

  it('names what is missing rather than only how many', () => {
    const coverage = calculationCoverage(
      weights({ weight_asset: 0.25, weight_opm: 0.25, weight_income: 0.25, weight_market: 0.25 }),
      results({ asset: { equity_value: 3 } }),
    );
    expect(coverage.missing).toEqual(['opm', 'income', 'market']);
  });

  it('reports 0/m rather than throwing when there is no calculation yet', () => {
    for (const r of [null, undefined, {}, { approaches: null }, 'nonsense']) {
      expect(calculationCoverage(weights({ weight_opm: 1 }), r)).toEqual({
        done: 0,
        total: 1,
        missing: ['opm'],
      });
    }
  });

  it('accepts an approach recorded as a bare number', () => {
    expect(calculationCoverage(weights({ weight_asset: 1 }), results({ asset: 4_000_000 })).done).toBe(1);
    // …but not a NaN dressed as one.
    expect(calculationCoverage(weights({ weight_asset: 1 }), results({ asset: NaN })).done).toBe(0);
  });
});
