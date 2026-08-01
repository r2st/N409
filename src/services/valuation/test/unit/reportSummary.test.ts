import { describe, expect, it } from 'vitest';
import {
  approachChart,
  buildReportSummary,
  discountChart,
  formatCurrency,
  formatPercent,
  marketableValuePerShare,
  num,
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
  it('builds the headline, figures, statement and both charts', () => {
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

    expect(summary.charts!.map((c) => c.type)).toEqual(['bar', 'waterfall']);
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
});
