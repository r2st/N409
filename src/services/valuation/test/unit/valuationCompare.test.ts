import { describe, expect, it } from 'vitest';
import {
  changedRows,
  compareValuations,
  headlineSummary,
  type CompareGroup,
  type CompareSide,
} from '../../src/domain/valuationCompare.js';

/**
 * The comparison table two valuations produce.
 *
 * The behaviour worth pinning is not the arithmetic — it is the judgement:
 * which rows appear at all, how a delta is expressed so an analyst can defend
 * it, and what happens when the two runs disagree about what a result object
 * even contains.
 */

const side = (over: Partial<CompareSide> = {}): CompareSide => ({
  valuation_id: '01N409VAL0000000000000AA',
  company_name: 'Northwind Robotics',
  kind: '409a',
  currency: 'USD',
  state: 'published',
  calculation_id: '01N409CALC000000000000AA',
  engine_version: '1.4.0',
  calculated_at: '2025-06-01T00:00:00.000Z',
  valuation_date: '2025-05-31',
  results: null,
  ...over,
});

const rowsOf = (groups: CompareGroup[]) => new Map(groups.flatMap((g) => g.rows).map((r) => [r.key, r]));

const A_RESULTS = {
  fmv_per_share: 1.42,
  equity_value: 48_000_000,
  fully_diluted_common: 33_802_816,
  allocation_method: 'opm',
  discounts: { dloc: 0.05, dlom: 0.3, dlom_method: 'chaffee' },
  assumptions: { volatility: 0.65, risk_free_rate: 0.041, time_to_exit_years: 4 },
  approaches: {
    opm_backsolve: { weight: 0.7, equity_value: 50_000_000 },
    market: { weight: 0.3, equity_value: 43_333_333 },
  },
};

const B_RESULTS = {
  fmv_per_share: 1.87,
  equity_value: 61_000_000,
  fully_diluted_common: 33_802_816,
  allocation_method: 'hybrid',
  discounts: { dloc: 0.05, dlom: 0.22, dlom_method: 'finnerty' },
  assumptions: { volatility: 0.58, risk_free_rate: 0.041, time_to_exit_years: 3.5 },
  approaches: {
    opm_backsolve: { weight: 0.5, equity_value: 62_000_000 },
    market: { weight: 0.5, equity_value: 60_000_000 },
  },
};

describe('compareValuations', () => {
  const groups = compareValuations(side({ results: A_RESULTS }), side({ results: B_RESULTS }));
  const rows = rowsOf(groups);

  it('groups metrics the way an analyst reads them', () => {
    expect(groups.map((g) => g.key)).toEqual(['conclusion', 'method', 'assumptions', 'approaches']);
  });

  it('reports the conclusion at per-share precision', () => {
    const fmv = rows.get('fmv_per_share')!;
    expect(fmv.a_display).toBe('$1.4200');
    expect(fmv.b_display).toBe('$1.8700');
    // A per-share FMV is quoted to the cent-fraction; rounding it to $1.42 vs
    // $1.87 would hide moves that matter on a grant of a million options.
    expect(fmv.delta).toBeCloseTo(0.45, 10);
    expect(fmv.delta_display).toBe('+$0.4500');
    expect(fmv.pct_change).toBeCloseTo(0.45 / 1.42, 10);
    expect(fmv.changed).toBe(true);
  });

  it('reports equity value at whole-currency precision', () => {
    expect(rows.get('equity_value')!.a_display).toBe('$48,000,000');
    expect(rows.get('equity_value')!.delta_display).toBe('+$13,000,000');
  });

  it('expresses a discount move in points, not percent-of-percent', () => {
    // 30% → 22% is the eight points an analyst defends in the report. Calling
    // it "−26.7%" is arithmetically true and professionally meaningless.
    const dlom = rows.get('dlom')!;
    expect(dlom.a_display).toBe('30.0%');
    expect(dlom.b_display).toBe('22.0%');
    expect(dlom.delta_display).toBe('−8.0 pts');
  });

  it('uses a proper minus sign, not a hyphen', () => {
    expect(rows.get('dlom')!.delta_display).toContain('−');
    expect(rows.get('dlom')!.delta_display).not.toContain('-');
  });

  it('marks an unchanged metric as unchanged with a zero delta', () => {
    const dloc = rows.get('dloc')!;
    expect(dloc.changed).toBe(false);
    expect(dloc.delta).toBe(0);
    expect(rows.get('fully_diluted_common')!.changed).toBe(false);
  });

  it('compares text metrics by equality, with no delta', () => {
    const method = rows.get('allocation_method')!;
    expect(method.a_display).toBe('Option pricing model');
    expect(method.b_display).toBe('Hybrid (OPM + PWERM)');
    expect(method.changed).toBe(true);
    expect(method.delta).toBeNull();
    expect(method.delta_display).toBeNull();

    const dlomMethod = rows.get('dlom_method')!;
    expect(dlomMethod.a_display).toBe('Chaffee protective-put model');
    expect(dlomMethod.b_display).toBe('Finnerty average-strike put model');
    expect(dlomMethod.changed).toBe(true);
  });

  it('surfaces a shift in approach weighting', () => {
    expect(rows.get('approach_opm_backsolve_weight')!.delta_display).toBe('−20.0 pts');
    expect(rows.get('approach_market_weight')!.delta_display).toBe('+20.0 pts');
    expect(rows.get('approach_market_weight')!.label).toBe('Market (comparables) — weight');
  });

  it('counts only what moved', () => {
    const changed = changedRows(groups)
      .map((r) => r.key)
      .sort();
    expect(changed).toEqual([
      'allocation_method',
      'approach_market_value',
      'approach_market_weight',
      'approach_opm_backsolve_value',
      'approach_opm_backsolve_weight',
      'dlom',
      'dlom_method',
      'equity_value',
      'fmv_per_share',
      'time_to_exit',
      'volatility',
    ]);
  });
});

describe('compareValuations — partial and mismatched results', () => {
  it('drops a metric neither side reports rather than showing a row of dashes', () => {
    const groups = compareValuations(
      side({ results: { fmv_per_share: 1 } }),
      side({ results: { fmv_per_share: 2 } }),
    );
    const rows = rowsOf(groups);
    expect(rows.has('fmv_per_share')).toBe(true);
    expect(rows.has('dlom')).toBe(false);
    expect(rows.has('volatility')).toBe(false);
    expect(groups.map((g) => g.key)).toEqual(['conclusion']);
  });

  it('keeps a metric only one side reports, and marks it changed', () => {
    // A discount that appears in one run and not the other is precisely the
    // kind of difference this view exists to surface.
    const groups = compareValuations(
      side({ results: { fmv_per_share: 1, discounts: { dlom: 0.25 } } }),
      side({ results: { fmv_per_share: 1 } }),
    );
    const dlom = rowsOf(groups).get('dlom')!;
    expect(dlom.a_display).toBe('25.0%');
    expect(dlom.b_display).toBeNull();
    expect(dlom.changed).toBe(true);
    expect(dlom.delta).toBeNull();
  });

  it('takes the union of approaches, not the intersection', () => {
    const groups = compareValuations(
      side({ results: { approaches: { income: { weight: 1, equity_value: 10 } } } }),
      side({ results: { approaches: { market: { weight: 1, equity_value: 12 } } } }),
    );
    const rows = rowsOf(groups);
    expect(rows.has('approach_income_weight')).toBe(true);
    expect(rows.has('approach_market_weight')).toBe(true);
    expect(rows.get('approach_income_weight')!.b_display).toBeNull();
  });

  it('survives a side that has never computed', () => {
    const groups = compareValuations(
      side({ results: A_RESULTS }),
      side({ results: null, calculation_id: null, engine_version: null }),
    );
    const fmv = rowsOf(groups).get('fmv_per_share')!;
    expect(fmv.a_display).toBe('$1.4200');
    expect(fmv.b_display).toBeNull();
    expect(fmv.changed).toBe(true);
  });

  it('returns no groups when neither side has results', () => {
    expect(compareValuations(side(), side())).toEqual([]);
  });

  it('does not divide by zero when the baseline is zero', () => {
    const groups = compareValuations(
      side({ results: { fmv_per_share: 0 } }),
      side({ results: { fmv_per_share: 1.5 } }),
    );
    const fmv = rowsOf(groups).get('fmv_per_share')!;
    expect(fmv.delta).toBe(1.5);
    expect(fmv.pct_change).toBeNull();
  });

  it('reads the alternative field names an older engine emits', () => {
    const groups = compareValuations(
      side({ results: { allocation: { method: 'pwerm' }, assumptions: { expected_time_to_exit_years: 5 } } }),
      side({ results: { allocation_method: 'pwerm', assumptions: { time_to_exit_years: 5 } } }),
    );
    const rows = rowsOf(groups);
    expect(rows.get('allocation_method')!.changed).toBe(false);
    expect(rows.get('time_to_exit')!.changed).toBe(false);
  });

  /**
   * The share-count row is the denominator behind the FMV row above it, and the
   * two allocation families divide by different counts: the cap table's common
   * classes under the breakpoint waterfall (the option pool is its own class
   * there), common + options under the aggregate models.
   */
  describe('the share-count row names the basis it is showing', () => {
    const withBasis = (basis?: string) => ({
      fmv_per_share: 1.42,
      common_equity_value: 11_360_000,
      fully_diluted_common: 8_000_000,
      ...(basis ? { fully_diluted_basis: basis } : {}),
    });

    it('names the cap table when both runs allocated on common alone', () => {
      const groups = compareValuations(
        side({ results: withBasis('cap_table_common') }),
        side({ results: withBasis('cap_table_common') }),
      );
      expect(rowsOf(groups).get('fully_diluted_common')!.label).toBe('Common shares outstanding');
    });

    it('keeps the fully diluted wording for the aggregate models', () => {
      const groups = compareValuations(
        side({ results: withBasis('common_plus_options') }),
        side({ results: withBasis('common_plus_options') }),
      );
      expect(rowsOf(groups).get('fully_diluted_common')!.label).toBe('Fully diluted common');
    });

    it('stays neutral when the two runs disagree about the basis', () => {
      // Either label would be wrong for one side; the delta is what tells the
      // analyst the basis moved.
      const groups = compareValuations(
        side({ results: withBasis('common_plus_options') }),
        side({ results: withBasis('cap_table_common') }),
      );
      expect(rowsOf(groups).get('fully_diluted_common')!.label).toBe('Fully diluted common');
    });

    it('reads a run stored before the basis existed as the aggregate one', () => {
      const groups = compareValuations(side({ results: withBasis() }), side({ results: withBasis() }));
      expect(rowsOf(groups).get('fully_diluted_common')!.label).toBe('Fully diluted common');
    });
  });

  it('formats in the baseline currency', () => {
    const groups = compareValuations(
      side({ currency: 'GBP', results: { equity_value: 1_000_000 } }),
      side({ currency: 'GBP', results: { equity_value: 1_200_000 } }),
    );
    expect(rowsOf(groups).get('equity_value')!.a_display).toBe('£1,000,000');
  });
});

describe('headlineSummary', () => {
  it('states the direction and the size of the FMV move', () => {
    const groups = compareValuations(side({ results: A_RESULTS }), side({ results: B_RESULTS }));
    expect(headlineSummary(groups)).toBe('FMV per share is up from $1.4200 to $1.8700 (31.7%).');
  });

  it('says so plainly when the number held', () => {
    const groups = compareValuations(
      side({ results: { fmv_per_share: 1.42 } }),
      side({ results: { fmv_per_share: 1.42 } }),
    );
    expect(headlineSummary(groups)).toBe('FMV per share is unchanged at $1.4200.');
  });

  it('reports a fall as down', () => {
    const groups = compareValuations(
      side({ results: { fmv_per_share: 2 } }),
      side({ results: { fmv_per_share: 1 } }),
    );
    expect(headlineSummary(groups)).toMatch(/^FMV per share is down from \$2\.0000 to \$1\.0000/);
  });

  it('stays silent when one side has no FMV to compare', () => {
    expect(headlineSummary(compareValuations(side({ results: { fmv_per_share: 1 } }), side()))).toBeNull();
    expect(headlineSummary([])).toBeNull();
  });
});
