import { describe, expect, it } from 'vitest';
import {
  approachChart,
  buildReportSummary,
  discountChart,
  formatCurrency,
  formatPercent,
  historyChart,
  marketableValuePerShare,
  num,
  weightingChart,
} from '../../src/domain/reportSummary.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

const CONTEXT = {
  currency: 'USD',
  companyName: 'Northwind Robotics, Inc.',
  valuationDate: '2026-06-30',
};

/** A representative successful engine run: OPM allocation, DLOC then DLOM. */
const RESULTS = {
  fmv_per_share: 1.2345,
  equity_value: 24_000_000,
  fully_diluted_common: 13_123_456.4,
  allocation_method: 'opm',
  approaches: {
    income: { weight: 0.6, equity_value: 26_000_000 },
    market: { weight: 0.4, equity_value: 20_000_000 },
    asset: { weight: 0, equity_value: 5_000_000 },
  },
  discounts: { dloc: 0.1, dlom: 0.25, dlom_method: 'finnerty' },
  assumptions: { volatility: 0.55, risk_free_rate: 0.042, time_to_exit_years: 3.5 },
};

function calculation(overrides: Partial<CalculationRow> = {}): CalculationRow {
  return {
    id: '01CALC',
    valuation_id: '01VAL',
    engine_version: '2.4.0',
    status: 'succeeded',
    inputs: {},
    results: { ...RESULTS },
    equity_value: '24000000',
    fmv_per_share: '1.2345',
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

describe('num', () => {
  it('parses numeric strings the driver returns for numeric columns', () => {
    expect(num('1.2345')).toBe(1.2345);
    expect(num(0)).toBe(0);
  });

  it('treats absent and non-finite values as missing', () => {
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('not a number')).toBeNull();
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatCurrency', () => {
  it('quotes a per-share FMV to four decimals', () => {
    expect(formatCurrency(1.2345, 'USD', 4)).toBe('$1.2345');
  });

  it('formats an unknown but well-formed code with its own symbol', () => {
    // Intl accepts any three-letter code, separating with U+00A0.
    expect(formatCurrency(1.5, 'XYZ', 2)).toBe(`XYZ\u00A01.50`);
  });

  it('falls back rather than throwing on a structurally invalid code', () => {
    // Intl throws RangeError on anything that is not three letters.
    expect(formatCurrency(1.5, 'US', 2)).toBe('US 1.50');
  });
});

describe('formatPercent', () => {
  it('renders a fraction as a percentage', () => {
    expect(formatPercent(0.25)).toBe('25.0%');
    expect(formatPercent(0.1, 0)).toBe('10%');
  });
});

describe('marketableValuePerShare', () => {
  it('prefers the value the allocation reports', () => {
    expect(
      marketableValuePerShare({
        allocation: { common_per_share: 2 },
        fmv_per_share: 1.2345,
        discounts: { dloc: 0.1, dlom: 0.25 },
      }),
    ).toBe(2);
  });

  it('inverts the discount chain when the allocation block is thin', () => {
    const base = marketableValuePerShare(RESULTS)!;
    // compute applies fmv = base × (1 − dloc) × (1 − dlom); inverting must close.
    expect(base * (1 - 0.1) * (1 - 0.25)).toBeCloseTo(1.2345, 10);
  });

  it('treats a fully-discounting factor as unusable rather than dividing by zero', () => {
    expect(marketableValuePerShare({ fmv_per_share: 1, discounts: { dloc: 1, dlom: 0.2 } })).toBeNull();
  });

  it('returns null without an FMV to invert', () => {
    expect(marketableValuePerShare({ discounts: { dloc: 0.1 } })).toBeNull();
  });
});

describe('approachChart', () => {
  it('plots only weighted approaches, largest value first', () => {
    const chart = approachChart(RESULTS, 'USD')!;
    expect(chart.type).toBe('bar');
    const bar = chart as Extract<typeof chart, { type: 'bar' }>;
    // The asset approach carries zero weight, so it is not part of the conclusion.
    expect(bar.points.map((p) => p.label)).toEqual(['Income (DCF) · 60%', 'Market (comparables) · 40%']);
    expect(bar.points[0]!.display).toBe('$26,000,000');
    expect(bar.note).toContain('$24,000,000');
  });

  it('returns null when no approach carries weight', () => {
    expect(approachChart({ approaches: { income: { weight: 0, equity_value: 1 } } }, 'USD')).toBeNull();
    expect(approachChart({}, 'USD')).toBeNull();
  });
});

describe('weightingChart', () => {
  it('shows each weighted approach as a slice, so the weights visibly sum to 100%', () => {
    const chart = weightingChart(RESULTS)!;
    expect(chart.type).toBe('donut');
    const donut = chart as Extract<typeof chart, { type: 'donut' }>;
    // The asset approach carries no weight, so it is not part of the ring.
    expect(donut.slices.map((s) => s.label)).toEqual(['Income (DCF)', 'Market (comparables)']);
    expect(donut.slices.map((s) => s.value)).toEqual([0.6, 0.4]);
    expect(donut.slices[0]!.display).toBe('60%');
    expect(donut.center).toBe('2');
    expect(donut.center_note).toBe('approaches');
  });

  it('stays silent when a ring would say nothing the sentence above it does not', () => {
    // One approach at 100% — a full ring.
    expect(weightingChart({ approaches: { income: { weight: 1, equity_value: 5 } } })).toBeNull();
    // Weighted approaches, but only one of them actually counts.
    expect(
      weightingChart({
        approaches: { income: { weight: 1, equity_value: 5 }, asset: { weight: 0, equity_value: 2 } },
      }),
    ).toBeNull();
    expect(weightingChart({})).toBeNull();
  });
});

describe('historyChart', () => {
  it('plots prior concluded values oldest first, in the report currency', () => {
    const chart = historyChart(
      [
        { as_of: '2025-06-30', fmv_per_share: 0.91 },
        { as_of: '2026-06-30T00:00:00Z', fmv_per_share: 1.2345 },
      ],
      'USD',
    )!;
    expect(chart.type).toBe('line');
    const line = chart as Extract<typeof chart, { type: 'line' }>;
    expect(line.points.map((p) => p.label)).toEqual(['2025-06-30', '2026-06-30']);
    expect(line.points.map((p) => p.value)).toEqual([0.91, 1.2345]);
    // Per-share figures carry four decimals, as everywhere else in the summary.
    expect(line.points[1]!.display).toBe('$1.2345');
  });

  it('needs two real points before there is a trend to draw', () => {
    expect(historyChart([], 'USD')).toBeNull();
    expect(historyChart([{ as_of: '2026-06-30', fmv_per_share: 1 }], 'USD')).toBeNull();
    // A non-finite value is dropped, which can take the series below two.
    expect(
      historyChart(
        [
          { as_of: '2025-06-30', fmv_per_share: Number.NaN },
          { as_of: '2026-06-30', fmv_per_share: 1 },
        ],
        'USD',
      ),
    ).toBeNull();
  });
});

describe('discountChart', () => {
  it('walks marketable value down to FMV through each discount', () => {
    const chart = discountChart(RESULTS, 'USD')!;
    expect(chart.type).toBe('waterfall');
    const wf = chart as Extract<typeof chart, { type: 'waterfall' }>;
    expect(wf.steps.map((s) => s.label)).toEqual(['Less DLOC 10.0%', 'Less DLOM 25.0%']);
    // Every step is a reduction.
    expect(wf.steps.every((s) => s.value < 0)).toBe(true);
    // Start plus the signed steps must land on the concluded FMV.
    const landed = wf.start.value + wf.steps.reduce((sum, s) => sum + s.value, 0);
    expect(landed).toBeCloseTo(1.2345, 10);
    expect(wf.end_value).toBe(1.2345);
    expect(wf.end_display).toBe('$1.2345');
  });

  it('omits a discount that was not applied', () => {
    const chart = discountChart({ fmv_per_share: 0.9, discounts: { dloc: 0, dlom: 0.1 } }, 'USD') as Extract<
      ReturnType<typeof discountChart>,
      { type: 'waterfall' }
    >;
    expect(chart.steps.map((s) => s.label)).toEqual(['Less DLOM 10.0%']);
  });

  it('returns null when no discount was applied at all', () => {
    expect(discountChart({ fmv_per_share: 1, discounts: { dloc: 0, dlom: 0 } }, 'USD')).toBeNull();
  });
});

describe('buildReportSummary', () => {
  it('builds the headline, figures, statement and the charts', () => {
    const summary = buildReportSummary(calculation(), CONTEXT)!;

    expect(summary.headline).toMatchObject({
      label: 'Fair market value per common share',
      value: '$1.2345',
    });
    expect(summary.headline.note).toContain('2026-06-30');
    expect(summary.headline.note).toContain('2.4.0');

    const byLabel = Object.fromEntries(summary.figures!.map((f) => [f.label, f]));
    expect(byLabel['Concluded equity value']!.value).toBe('$24,000,000');
    expect(byLabel['Allocation method']!.value).toBe('Option pricing model');
    expect(byLabel['Discount for lack of control']!.value).toBe('10.0%');
    expect(byLabel['Discount for lack of marketability']).toMatchObject({
      value: '25.0%',
      note: 'Finnerty average-strike put model',
    });
    // Share counts are whole shares, thousands-separated.
    expect(byLabel['Fully diluted common']!.value).toBe('13,123,456');
    expect(byLabel['Key assumptions']!.value).toBe('σ 55% · T 3.50y');

    expect(summary.statement).toContain('Northwind Robotics, Inc.');
    expect(summary.statement).toContain('as of 2026-06-30');
    expect(summary.statement).toContain('$1.2345');
    expect(summary.statement).toContain('non-marketable, minority-interest basis');

    // Ordered as the page is read. No history was supplied, so no trend line.
    expect(summary.charts!.map((c) => c.type)).toEqual(['bar', 'donut', 'waterfall']);
  });

  it('appends the trend line only once there is a prior valuation to trend against', () => {
    const withHistory = buildReportSummary(calculation(), {
      ...CONTEXT,
      history: [
        { as_of: '2025-06-30', fmv_per_share: 0.91 },
        { as_of: '2026-06-30', fmv_per_share: 1.2345 },
      ],
    })!;
    expect(withHistory.charts!.map((c) => c.type)).toEqual(['bar', 'donut', 'waterfall', 'line']);

    // A single prior point is a dot, not a trend.
    const onePoint = buildReportSummary(calculation(), {
      ...CONTEXT,
      history: [{ as_of: '2026-06-30', fmv_per_share: 1.2345 }],
    })!;
    expect(onePoint.charts!.map((c) => c.type)).toEqual(['bar', 'donut', 'waterfall']);
  });

  it('summarises nothing until the engine has produced a value', () => {
    expect(buildReportSummary(null, CONTEXT)).toBeNull();
    expect(buildReportSummary(calculation({ status: 'failed', results: null }), CONTEXT)).toBeNull();
    expect(buildReportSummary(calculation({ results: null }), CONTEXT)).toBeNull();
    // Succeeded but without the one number the page exists to show.
    expect(buildReportSummary(calculation({ results: { equity_value: 1 } }), CONTEXT)).toBeNull();
  });

  it('degrades to fewer figures rather than throwing on a thin results shape', () => {
    const summary = buildReportSummary(calculation({ results: { fmv_per_share: 0.5 } }), {
      ...CONTEXT,
      valuationDate: null,
    })!;

    expect(summary.headline.value).toBe('$0.5000');
    // No valuation date means no "as of" clause and an engine-only note.
    expect(summary.headline.note).toBe('Engine 2.4.0');
    expect(summary.statement).not.toContain('as of');
    // Allocation defaults rather than going missing; nothing else is invented.
    expect(summary.figures!.map((f) => f.label)).toEqual(['Allocation method']);
    expect(summary.charts).toEqual([]);
  });

  it('falls back to the raw method name when the label is unmapped', () => {
    const summary = buildReportSummary(
      calculation({ results: { fmv_per_share: 1, allocation_method: 'bespoke_model' } }),
      CONTEXT,
    )!;
    expect(summary.figures![0]).toMatchObject({
      label: 'Allocation method',
      value: 'BESPOKE_MODEL',
    });
  });

  it('reads the allocation method from the nested block when not hoisted', () => {
    const summary = buildReportSummary(
      calculation({ results: { fmv_per_share: 1, allocation: { method: 'pwerm' } } }),
      CONTEXT,
    )!;
    expect(summary.figures![0]!.value).toBe('PWERM');
  });

  /**
   * The OPM path did not hoist `allocation_method`, so the fallback above was
   * not a rare degraded case — it was the default run, and `allocation.method`
   * speaks a different vocabulary: the *mechanism* the OPM used. Unmapped keys
   * echo upper-cased, so the board-facing summary printed "OPM_WATERFALL".
   *
   * The engine now hoists `allocation_method` on that path too, but every
   * calculation stored before it does not, and re-rendering an old report must
   * not change what it says. So both spellings resolve to prose.
   */
  describe('allocation mechanism names (calculations stored before the hoist)', () => {
    const label = (results: Record<string, unknown>) =>
      buildReportSummary(calculation({ results: { fmv_per_share: 1, ...results } }), CONTEXT)!.figures!.find(
        (f) => f.label === 'Allocation method',
      )!.value;

    it.each([
      ['opm_waterfall', 'Option pricing model (cap-table waterfall)'],
      ['opm_single_breakpoint', 'Option pricing model (single breakpoint)'],
      ['as_converted', 'As-converted (pro-rata)'],
      ['cvm_waterfall', 'Current value method (cap-table waterfall)'],
      ['cvm_single_preference', 'Current value method (single preference)'],
      ['cvm_pro_rata', 'Current value method (pro-rata)'],
      ['cvm_common_only', 'Current value method (common only)'],
    ])('renders %s as prose, never a shouted key', (method, expected) => {
      expect(label({ allocation: { method } })).toBe(expected);
    });

    it('never leaves an underscored key on the page for a known mechanism', () => {
      for (const method of ['opm_waterfall', 'opm_single_breakpoint', 'as_converted']) {
        expect(label({ allocation: { method } })).not.toMatch(/_|^[A-Z ]+$/);
      }
    });

    it('prefers the hoisted method when the engine supplies both', () => {
      expect(label({ allocation_method: 'opm', allocation: { method: 'opm_waterfall' } })).toBe(
        'Option pricing model',
      );
    });
  });
});
