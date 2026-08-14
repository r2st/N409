import { describe, expect, it } from 'vitest';
import { DLOM_METHODS } from '../../src/repos/params.js';
import {
  DLOM_LABELS,
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
    // Nothing about a second σ where the calculation records only one.
    expect(byLabel['Discount for lack of marketability']!.note).not.toContain('struck on');

    expect(summary.statement).toContain('Northwind Robotics, Inc.');
    expect(summary.statement).toContain('as of 2026-06-30');
    expect(summary.statement).toContain('$1.2345');
    expect(summary.statement).toContain('non-marketable, minority-interest basis');

    // Ordered as the page is read. No history was supplied, so no trend line.
    expect(summary.charts!.map((c) => c.type)).toEqual(['bar', 'donut', 'waterfall']);
  });

  /**
   * The summary page states one σ, and an option-based DLOM does not run on it.
   *
   * "Key assumptions" carries the enterprise volatility, because that is what
   * the allocation ran on. The DLOM runs on the volatility of the *class* —
   * common, geared by everything senior to it — and the two differ by the whole
   * preference stack: 62% against 74% on the sample cap table. With only the
   * first printed, the page asserted a σ that reproduces neither the discount
   * beside it nor Exhibit H-1's derivation of it, and a reviewer checking one
   * against the other found a number that would not divide out.
   */
  describe('the σ the marketability discount was struck on', () => {
    const noteFor = (assumptions: Record<string, unknown>) =>
      buildReportSummary(
        calculation({ results: { ...RESULTS, assumptions: { ...RESULTS.assumptions, ...assumptions } } }),
        CONTEXT,
      )!.figures!.find((f) => f.label === 'Discount for lack of marketability')!.note;

    it('names the class volatility beside the discount that used it', () => {
      const note = noteFor({ dlom_volatility: 0.741875, dlom_volatility_basis: 'class' });
      expect(note).toContain('Finnerty average-strike put model');
      expect(note).toContain('σ 74%');
      expect(note).toContain("common's own");
    });

    it('says nothing extra when the discount ran on the enterprise figure', () => {
      // Then the σ above it is the σ it used, and a second mention is noise.
      expect(noteFor({ dlom_volatility: 0.55, dlom_volatility_basis: 'enterprise' })).toBe(
        'Finnerty average-strike put model',
      );
    });

    it('says nothing extra when the two volatilities agree', () => {
      // A cap table with no preference stack gears common by nothing, so the
      // class basis and the enterprise figure are the same number.
      expect(noteFor({ dlom_volatility: 0.55, dlom_volatility_basis: 'class' })).toBe(
        'Finnerty average-strike put model',
      );
    });
  });

  /**
   * The method named beside the discount, for every method the engine can
   * conclude on.
   *
   * The map held three of the eight and falls back to an echo of the key, so a
   * valuation concluded on a study blend printed "restricted_stock" on the page
   * a board reads first — while Exhibit H of the same PDF, reading a different
   * copy of the same vocabulary, named the studies properly.
   */
  describe('the DLOM method is named for every method the engine dispatches on', () => {
    const noteFor = (method: string) =>
      buildReportSummary(
        calculation({ results: { ...RESULTS, discounts: { ...RESULTS.discounts, dlom_method: method } } }),
        CONTEXT,
      )!.figures!.find((f) => f.label === 'Discount for lack of marketability')!.note;

    it.each([
      ['ghaidarov', 'Ghaidarov average-strike put model'],
      ['longstaff', 'Longstaff upper bound'],
      ['restricted_stock', 'Restricted-stock studies'],
      ['pre_ipo', 'Pre-IPO transaction studies'],
      ['qualitative', 'Qualitative — analyst judgement'],
      ['weighted', 'Several methods, weighted'],
    ])('names %s', (method, label) => {
      expect(noteFor(method)).toBe(label);
    });

    it('covers every method the engine dispatches on, plus a blend', () => {
      /*
       * The guard that keeps the map from falling behind again. `weighted` is
       * not in DLOM_METHODS — it is not selectable — but it is what
       * `_resolve_discounts` writes to `dlom_method` for a `dlom_methods`
       * blend, so it has to be nameable all the same.
       */
      expect(Object.keys(DLOM_LABELS).sort()).toEqual([...DLOM_METHODS, 'weighted'].sort());
    });

    it('still echoes a method added after this build', () => {
      // The blob is the authority — both halves of a roll-forward comparison
      // may come from engine versions this one has not heard of.
      expect(noteFor('lattice_binomial')).toBe('lattice_binomial');
    });
  });

  /**
   * The share count on the summary page is the denominator behind the headline
   * FMV, and the two allocation families use different ones. Under the
   * cap-table waterfall the option pool is its own class holding its own value,
   * so the common equity value beside it excludes the pool; under the aggregate
   * models the pool is folded into fully diluted common. Labelling every run
   * "Fully diluted common · common shares plus options outstanding" made the
   * first case contradict itself — a board dividing the printed equity by the
   * printed count landed well under the FMV the same page asked them to adopt.
   */
  describe('the share count is labelled as the basis the engine actually used', () => {
    const figureFor = (results: Record<string, unknown>) => {
      const summary = buildReportSummary(calculation({ results: { ...RESULTS, ...results } }), CONTEXT)!;
      return summary.figures!.find((f) => f.value === '8,000,000');
    };

    it('names the cap table when the waterfall allocated on common alone', () => {
      expect(
        figureFor({ fully_diluted_common: 8_000_000, fully_diluted_basis: 'cap_table_common' }),
      ).toMatchObject({
        label: 'Common shares outstanding',
        note: 'Common classes per the cap table; options are allocated separately',
      });
    });

    it('keeps the fully diluted wording for the aggregate allocation models', () => {
      expect(
        figureFor({ fully_diluted_common: 8_000_000, fully_diluted_basis: 'common_plus_options' }),
      ).toMatchObject({
        label: 'Fully diluted common',
        note: 'Common shares plus options outstanding',
      });
    });

    it('reads a calculation stored before the basis existed as the aggregate one', () => {
      // Which is what those runs were computed on — the field is new, the
      // arithmetic behind the old rows is not.
      expect(figureFor({ fully_diluted_common: 8_000_000 })).toMatchObject({
        label: 'Fully diluted common',
        note: 'Common shares plus options outstanding',
      });
    });
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

/**
 * Stage of enterprise development.
 *
 * The AICPA practice aid frames the whole valuation around where the company
 * sits on its six-stage scale — it is what justifies weighting the market
 * approach over the income approach, reaching for a backsolve rather than a
 * DCF, and concluding a marketability discount at the top of the supportable
 * range. A reviewing auditor looks for it stated, and it belongs on the page
 * they read first.
 */
describe('the concluded stage of enterprise development', () => {
  const summaryWith = (developmentStage: number | null) =>
    buildReportSummary(calculation(), { ...CONTEXT, developmentStage });

  it('states the stage the analyst concluded', () => {
    const figure = summaryWith(4)!.figures.find((f) => f.label === 'Stage of enterprise development');
    expect(figure).toBeDefined();
    expect(figure!.value).toBe('Stage 4');
  });

  it('carries the practice aid’s description as the note', () => {
    // The number alone means nothing to a reader who does not have the practice
    // aid open beside them.
    const figure = summaryWith(4)!.figures.find((f) => f.label === 'Stage of enterprise development');
    expect(figure!.note).toMatch(/Product revenue, operating at a loss/i);
  });

  it('says nothing when nobody has concluded one', () => {
    // Never inferred: a report with no stage on it is a report where the
    // analyst has not said which one applies, and printing a guess would be
    // the platform asserting a judgement on their behalf.
    expect(summaryWith(null)!.figures.some((f) => f.label === 'Stage of enterprise development')).toBe(false);
  });

  it('ignores a stage outside the scale', () => {
    expect(summaryWith(9)!.figures.some((f) => f.label === 'Stage of enterprise development')).toBe(false);
  });
});
