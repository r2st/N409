import { describe, expect, it } from 'vitest';
import { renderReportPdf } from '@n409/report/pdf';
import { extractText as pdfText } from '../../../report/test/support/pdfText.js';
import {
  allocationExhibit,
  approachExhibit,
  assetExhibit,
  buildExhibits,
  capitalizationExhibit,
  discountExhibit,
  dlomDerivationExhibit,
  incomeExhibit,
  levelOfValueExhibit,
  marketExhibit,
  opmCalculationsExhibit,
  peerSetExhibit,
  pwermExhibit,
  rollforwardExhibit,
  sensitivityExhibit,
  rfrSensitivityExhibit,
  financialsExhibit,
  operatingMetricsExhibit,
  waccExhibit,
  scheduleTitle,
  SCHEDULE_CATALOGUE,
  type ExhibitContext,
} from '../../src/domain/reportExhibits.js';
import { ALLOWED_TAGS, sanitizeHtml } from '../../src/domain/report.js';
import { renderedScheduleIds } from '../../src/domain/reportExhibitIndex.js';
import { sensitivityGrid, sensitivityTables } from '../../src/domain/sensitivity.js';
import { computeWorkbook } from '../../src/domain/workbook.js';
import type { CalculationRow } from '../../src/repos/calculations.js';
import type { ProjectionRow } from '../../src/repos/projections.js';
import type { VolatilityEstimateRow } from '../../src/repos/volatilityEstimates.js';
import type { RollforwardRunRow } from '../../src/repos/rollforwardRuns.js';

const CONTEXT = {
  currency: 'USD',
  companyName: 'Northwind Robotics, Inc.',
  valuationDate: '2026-06-30',
};

/** The engine payload as `calculations.inputs` stores it: `{ params, inputs }`. */
const INPUTS = {
  valuation_date: '2026-06-30',
  cash: 3_000_000,
  debt: 1_000_000,
  share_classes: [
    { kind: 'common', name: 'Common', shares: 8_000_000 },
    {
      kind: 'preferred',
      name: 'Series A',
      shares: 4_000_000,
      preference: 10_000_000,
      seniority: 1,
      participating: true,
      participation_cap: 20_000_000,
      conversion_ratio: 1,
    },
    { kind: 'option', name: 'Option pool', shares: 1_500_000, strike: 0.85 },
  ],
  income: {
    free_cash_flows: [1_000_000, 1_500_000, 2_200_000],
    revenues: [6_000_000, 9_000_000, 13_000_000],
    discount_rate: 0.25,
    terminal_growth: 0.03,
  },
  market: { metric: 4_000_000, multiples: [5.0, 6.5, 7.1] },
};

const RESULTS = {
  equity_value: 42_000_000,
  fmv_per_share: 1.2345,
  common_equity_value: 19_500_000,
  fully_diluted_common: 8_000_000,
  fully_diluted_basis: 'cap_table_common',
  allocation_method: 'opm',
  approaches: {
    income: {
      weight: 0.25,
      pv_explicit: 3_100_000,
      pv_terminal: 30_900_000,
      enterprise_value: 34_000_000,
      equity_value: 36_000_000,
    },
    market: {
      weight: 0.25,
      metric: 4_000_000,
      multiples: [5.0, 6.5, 7.1],
      selected_multiple: 6.5,
      enterprise_value: 26_000_000,
      equity_value: 28_000_000,
    },
    opm_backsolve: { weight: 0.5, method: 'backsolve_waterfall', equity_value: 52_000_000 },
  },
  allocation: {
    method: 'opm_waterfall',
    common_per_share: 1.828148,
    common_shares: 8_000_000,
    common_value: 14_625_184,
    /*
     * The tranche values are the call spreads of `option_schedule` below —
     * C(from) − C(to), and C(40M) − 0 for the open-ended tranche — rather than
     * the round numbers that were here while the fixture only had to sum to
     * the equity value. Appendix IV's entire claim is that Exhibit F's value
     * column *is* that column of spreads, so the fixture the two schedules are
     * read out of has to be one where it holds.
     */
    breakpoints: [
      { from: 0, to: 10_000_000, participants: { 'Series A': 1 }, value: 7_706_565.52 },
      {
        from: 10_000_000,
        to: 40_000_000,
        participants: { Common: 0.666667, 'Series A': 0.333333 },
        value: 12_879_706.07,
      },
      { from: 40_000_000, to: null, participants: { Common: 1 }, value: 21_413_728.41 },
    ],
    /*
     * The option-pricing working `engine/waterfall.py` records beside the
     * breakpoints (Appendix IV), one row per distinct strike.
     *
     * Transcribed from the engine's own `bs_call_terms` at the rounding
     * `allocate_waterfall` applies — six decimals on the dimensionless terms,
     * two on the money — rather than typed by hand. A plausible-looking set
     * the appendix happened to agree with would pass the same assertions and
     * prove nothing about the deliverable.
     *
     * The zero strike carries no d₁/d₂ because at that strike they do not
     * exist: a call struck at zero is the underlying, and `bs_call_terms`
     * reports the probabilities as their limit of 1 rather than as blanks.
     */
    option_schedule: [
      { strike: 0, d1: null, d2: null, n_d1: 1.0, n_d2: 1.0, discount_factor: null, call: 42_000_000.0 },
      {
        strike: 10_000_000,
        d1: 1.909034,
        d2: 0.692996,
        n_d1: 0.971871,
        n_d2: 0.755844,
        discount_factor: 0.863294,
        call: 34_293_434.48,
      },
      {
        strike: 40_000_000,
        d1: 0.769026,
        d2: -0.447013,
        n_d1: 0.779061,
        n_d2: 0.327433,
        discount_factor: 0.863294,
        call: 21_413_728.41,
      },
    ],
    classes: {
      Common: { kind: 'common', shares: 8_000_000, value: 14_625_184, per_share: 1.828148 },
      'Series A': { kind: 'preferred', shares: 4_000_000, value: 20_000_000, per_share: 5.0 },
      'Option pool': { kind: 'option', shares: 1_500_000, value: 7_374_816, per_share: 4.916544 },
    },
  },
  assumptions: { time_to_exit_years: 3.5, risk_free_rate: 0.042, volatility: 0.65 },
  discounts: { dloc: 0.1, dlom: 0.25, dlom_method: 'chaffee' },
};

function calculation(over: Partial<CalculationRow> = {}): CalculationRow {
  return {
    id: '01J000000000000000000000',
    valuation_id: '01J000000000000000000001',
    engine_version: '1.4.0',
    status: 'succeeded',
    inputs: { params: {}, inputs: INPUTS },
    results: RESULTS,
    equity_value: '42000000',
    fmv_per_share: '1.2345',
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    ...over,
  } as CalculationRow;
}

/** An adopted roll-forward run, as migration 0150 stores it (Exhibit B-2). */
const ROLLFORWARD: RollforwardRunRow = {
  id: '01J0ROLLFORWARD0000000001',
  valuation_id: '01J000000000000000000001',
  prior_valuation_id: '01J000000000000000000002',
  prior_calculation_id: '01J000000000000000000003',
  prior_valuation_number: 'V-2025-0042',
  prior_valuation_date: new Date('2025-06-30T00:00:00Z'),
  new_valuation_date: new Date('2026-06-30T00:00:00Z'),
  years_elapsed: 1.0,
  prior_equity_value: 33_600_000,
  rolled_equity_value: 42_000_000,
  annual_accretion: 0.25,
  new_round_post_money: null,
  calibration_steps: [
    { step: 'prior_equity_value', value: 33_600_000 },
    { step: 'time_accretion', annual_rate: 0.25, years: 1.0, factor: 1.25, value: 42_000_000 },
  ],
  material_changes: [
    {
      field: 'revenue',
      material: false,
      detail: 'revenue moved +4.0% (below 20% threshold)',
      delta_pct: 0.04,
    },
  ],
  requires_full_revaluation: false,
  pre_populated_inputs: { valuation_date: '2026-06-30', last_round_post_money: 42_000_000 },
  applied_at: new Date('2026-07-01T00:00:00Z'),
  applied_by: null,
  created_by: null,
  created_at: new Date('2026-07-01T00:00:00Z'),
};

/** Cell text of a rendered exhibit, tags stripped — what a reader sees. */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

// ── assembly ─────────────────────────────────────────────────────────────────

describe('buildExhibits', () => {
  it('produces the schedules the calculation supports, in reading order', () => {
    const headings = buildExhibits(calculation(), CONTEXT).map((s) => s.heading);
    expect(headings).toEqual([
      'Exhibit A — Capitalization Table',
      'Exhibit B — Reconciliation of Valuation Approaches',
      'Exhibit C — Income Approach (Discounted Cash Flow)',
      'Exhibit D — Market Approach (Guideline Multiples)',
      'Exhibit F — Allocation of Equity Value',
      // F-2 needs only what an OPM run already has — sigma, the term, the
      // rate, the preference stack — so it is present wherever an OPM is.
      'Exhibit F-2 — Allocation Sensitivity',
      'Exhibit F-3 — Risk-Free Rate Sensitivity',
      'Exhibit H — Discounts and Concluded Value',
      'Appendix IV — Option Pricing Model Calculations',
    ]);
  });

  it('omits an exhibit for an approach the valuation did not apply', () => {
    // No asset approach was weighted, so there is no Exhibit E to draw.
    const headings = buildExhibits(calculation(), CONTEXT).map((s) => s.heading);
    expect(headings).not.toContain('Exhibit E — Asset Approach');
    expect(headings).not.toContain('Exhibit G — Probability-Weighted Expected Return Scenarios');
  });

  it('draws nothing when the engine has not produced a value', () => {
    expect(buildExhibits(null, CONTEXT)).toEqual([]);
    expect(buildExhibits(calculation({ status: 'failed' }), CONTEXT)).toEqual([]);
    expect(buildExhibits(calculation({ results: null }), CONTEXT)).toEqual([]);
  });

  it('survives a partial results document rather than throwing mid-render', () => {
    // Every shape a stored calculation from an older engine could have.
    for (const results of [
      {},
      { equity_value: 1 },
      { approaches: null, allocation: null, discounts: null },
      { approaches: 'not an object', allocation: [], fmv_per_share: 'x' },
      { fmv_per_share: 1.0, allocation: { breakpoints: 'no' }, discounts: { dloc: null } },
    ]) {
      expect(() => buildExhibits(calculation({ results }), CONTEXT)).not.toThrow();
    }
  });

  it('emits only markup the report renderer understands', () => {
    for (const s of buildExhibits(calculation(), CONTEXT)) {
      for (const tag of s.html.matchAll(/<\/?([a-z]+)/g)) {
        expect(ALLOWED_TAGS.has(tag[1]!), `${s.heading}: <${tag[1]}>`).toBe(true);
      }
      // The renderer's own whitelist is the authority; nothing here may be
      // something it would strip.
      expect(sanitizeHtml(s.html)).toBe(s.html);
    }
  });
});

/**
 * The catalogue against the renderer.
 *
 * `SCHEDULE_CATALOGUE` is the single place a schedule's id, heading and
 * always-ness are stated, and three separate lists used to state them
 * independently: the builders' own heading literals, `SAMPLE_EXHIBITS` on the
 * public page, and `ALL_EXHIBITS` in the index test. Two of the three had
 * already drifted — the sample page promised a prospect twelve schedules while
 * the renderer printed fifteen, and the index test's list was missing Appendix
 * III — and nothing failed, because no test rendered every schedule at once.
 *
 * This is that test. It builds the engagement that produces every one of them
 * and requires the headings to be the catalogue, in the catalogue's order. A
 * builder added without an entry fails here; an entry whose title no longer
 * matches its builder fails here; and the public page, being derived from the
 * catalogue, cannot then be describing a different document.
 */
describe('the schedule catalogue', () => {
  /** Enough of every input that no builder returns null. */
  const MAXIMAL_RESULTS = {
    ...RESULTS,
    approaches: {
      ...RESULTS.approaches,
      // Exhibit E — an asset approach that was actually weighted.
      asset: {
        weight: 0.1,
        method: 'nav',
        total_assets: 9_000_000,
        total_liabilities: 2_000_000,
        equity_value: 7_000_000,
      },
    },
    allocation: {
      ...RESULTS.allocation,
      // Exhibit G — PWERM scenarios alongside the breakpoint schedule.
      scenarios: [
        { name: 'IPO', type: 'ipo', probability: 0.3, exit_equity_value: 200_000_000, years: 4 },
        { name: 'Acquisition', type: 'ma', probability: 0.5, exit_equity_value: 80_000_000, years: 3 },
        { name: 'Dissolution', type: 'dissolution', probability: 0.2, exit_equity_value: 0, years: 2 },
      ],
    },
    // Exhibit H-1 — the DLOM derivation and the class-volatility schedule.
    discounts: {
      ...RESULTS.discounts,
      dlom_detail: {
        method: 'chaffee',
        dlom: 0.25,
        volatility: 0.62,
        volatility_basis: 'class',
        time_to_exit_years: 4,
      },
      // Exhibit B-1 — the level-of-value working, as `dloc.level_of_value_detail`
      // records it alongside whichever DLOC method was used.
      dloc_method: 'qualitative',
      dloc_detail: {
        method: 'qualitative',
        dloc: 0.1,
        minority_basis_weight: 0.428571,
        control_basis_weight: 0.571429,
        approach_levels: {
          asset: 'control',
          opm_backsolve: 'minority',
          income: 'control',
          market: 'minority',
        },
        double_counts_minority: false,
      },
    },
    class_volatility: {
      enterprise_volatility: 0.62,
      // The aggregate common claim — the figure an option-based DLOM struck on
      // the class basis actually used, printed as its own line in Exhibit H-1.
      common_volatility: 0.7422,
      time_to_exit_years: 4,
      risk_free_rate: 0.0421,
      equity_value: 42_000_000,
      delta_total: 1,
      classes: {
        Common: { kind: 'common', value: 19_900_045, delta: 0.555, elasticity: 1.1971, volatility: 0.7422 },
      },
    },
    // Appendix I — the WACC build-up behind the income approach's rate.
    auto: {
      wacc: {
        wacc: 0.2812,
        cost_of_equity: 0.2954,
        capm: {
          risk_free_rate: 0.0421,
          equity_risk_premium: 0.055,
          size_premium: 0.0389,
          beta_relevered: 1.38,
        },
      },
    },
  };

  const MAXIMAL_CONTEXT: ExhibitContext = {
    ...CONTEXT,
    // Exhibit D-1.
    peers: [
      {
        ticker: 'AAA',
        name: 'Alpha Analytics',
        included: true,
        exclude_reason: null,
        source: 'market_feed',
        score: 0.82,
        multiples: { ev_revenue_ltm: 5.0 },
      },
    ],
    // Exhibit F-1.
    volatility: {
      id: '01V',
      valuation_id: '01K',
      method: 'close_to_close',
      periods_per_year: 252,
      window_start: new Date('2024-06-30T00:00:00Z'),
      window_end: new Date('2026-06-30T00:00:00Z'),
      companies: [{ ticker: 'AAA', volatility: 0.62, observations: 500, used: true }],
      excluded: [],
      recommended: 0.65,
      median_vol: 0.62,
      mean_vol: 0.62,
      min_vol: 0.62,
      max_vol: 0.62,
      coefficient_of_variation: 0.0,
      time_to_exit_years: 3.5,
      confidence: 'medium',
      manual_override: null,
      applied_at: new Date('2026-07-01T00:00:00Z'),
      applied_by: null,
      created_by: null,
      created_at: new Date('2026-07-01T00:00:00Z'),
    } as VolatilityEstimateRow,
    // Exhibit C-1.
    projection: {
      id: '01J0PROJECTION000000000001',
      valuation_id: '01J0VALUATION00000000001',
      method: 'growth',
      years: 3,
      tax_rate: 0.21,
      inputs: {
        method: 'growth',
        years: 3,
        base_revenue: 8_000_000,
        revenue_growth: 0.25,
        cogs_pct: 0.4,
        opex_pct: 0.3,
        tax_rate: 0.21,
      },
      projections: [1_000_000, 1_500_000, 2_200_000].map((fcff, i) => ({
        year: i + 1,
        revenue: 10_000_000 + i * 3_000_000,
        cogs: 4_000_000,
        opex: 3_000_000,
        ebitda: 3_000_000,
        da: 500_000,
        ebit: 2_500_000,
        nopat: 1_975_000,
        capex: 600_000,
        delta_nwc: 250_000,
        fcff,
      })),
      free_cash_flows: [1_000_000, 1_500_000, 2_200_000],
      terminal_method: null,
      terminal_value: null,
      applied_at: new Date('2026-07-01T00:00:00Z'),
      applied_by: null,
      created_by: null,
      created_at: new Date('2026-06-30T00:00:00Z'),
    } as ProjectionRow,
    // Appendix II, and Appendix II-1 from the same resolved workbook.
    financials: computeWorkbook([
      { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
      { sheet: 'balance_sheet', row_key: 'cash', column_key: 'fy_current', value: 3_000_000 },
      { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_current', value: 5_400_000 },
    ]),
    // Appendix III.
    developmentStage: 3,
    // Exhibit B-2.
    rollforward: ROLLFORWARD,
  };

  const maximal = () =>
    buildExhibits(calculation({ results: MAXIMAL_RESULTS } as Partial<CalculationRow>), MAXIMAL_CONTEXT);

  it('prints every schedule it catalogues, in the catalogued order', () => {
    // The assertion the three hand-maintained lists could not make between
    // them: this is the whole deliverable, and it is exactly the catalogue.
    expect(maximal().map((s) => s.heading)).toEqual(SCHEDULE_CATALOGUE.map(scheduleTitle));
  });

  it('catalogues no schedule the renderer cannot produce', () => {
    // The other direction: an entry left behind by a builder that was deleted
    // would have the public page promising a schedule nobody receives.
    const printed = new Set(maximal().map((s) => s.heading));
    for (const s of SCHEDULE_CATALOGUE) {
      expect(printed.has(scheduleTitle(s)), `${scheduleTitle(s)} is catalogued but never printed`).toBe(true);
    }
  });

  it('gives every schedule a distinct id the index can parse', () => {
    const ids = SCHEDULE_CATALOGUE.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // `renderedScheduleIds` is what resolves the body's `{{#exhibit:E}}`
    // pointers and the Index of Exhibits. A heading it cannot parse is a
    // schedule the body can never point at.
    expect(renderedScheduleIds(SCHEDULE_CATALOGUE.map(scheduleTitle))).toEqual(new Set(ids));
  });

  it('marks as always only the schedules a bare engagement still receives', () => {
    // The minimum: an engagement with no peer set, no derived sigma, no
    // forecast, no financials, no stage and no asset approach.
    const bare = buildExhibits(calculation(), CONTEXT).map((s) => s.heading);
    for (const s of SCHEDULE_CATALOGUE) {
      expect(bare.includes(scheduleTitle(s)), `${scheduleTitle(s)} always=${s.always}`).toBe(
        // C, D, F-2, F-3 and IV survive the bare fixture because INPUTS carries
        // an income approach, a market approach and a full OPM assumption set,
        // and RESULTS carries the option schedule any OPM run now records;
        // none of the five is guaranteed in general.
        s.always || s.id === 'C' || s.id === 'D' || s.id === 'F-2' || s.id === 'F-3' || s.id === 'IV',
      );
    }
    expect(SCHEDULE_CATALOGUE.filter((s) => s.always).map((s) => s.id)).toEqual(['A', 'B', 'F', 'H']);
  });

  it('puts the appendices after the exhibits', () => {
    const headings = maximal().map((s) => s.heading);
    const lastExhibit = headings.findLastIndex((h) => h.startsWith('Exhibit '));
    const firstAppendix = headings.findIndex((h) => h.startsWith('Appendix '));
    expect(firstAppendix).toBeGreaterThan(lastExhibit);
  });
});

// ── Exhibit A ────────────────────────────────────────────────────────────────

describe('capitalization exhibit', () => {
  it('tabulates every class with the rights that drive the allocation', () => {
    const html = capitalizationExhibit(INPUTS, CONTEXT)!.html;
    const seen = plain(html);
    expect(seen).toContain('Common');
    expect(seen).toContain('Series A');
    expect(seen).toContain('Option pool');
    expect(seen).toContain('8,000,000');
    expect(seen).toContain('$10,000,000'); // aggregate liquidation preference
    expect(seen).toContain('Strike $0.8500');
    expect(seen).toContain('13,500,000'); // total shares
  });

  it('states a participation cap, which decides how much preferred can take', () => {
    const seen = plain(capitalizationExhibit(INPUTS, CONTEXT)!.html);
    expect(seen).toContain('Yes, capped at $20,000,000');
  });

  /**
   * The residual is split on the as-converted count, so a class converting at
   * other than 1:1 holds a different share of it than its outstanding count
   * suggests. The exhibit says it is "the capitalization ... as allocated by
   * the option-pricing waterfall", so the count the waterfall divided has to
   * appear on it — and so does the ratio, or the reader cannot check the one
   * against the other.
   */
  it('states the as-converted count and the ratio behind it', () => {
    const classes = INPUTS.share_classes.map((c) =>
      c.name === 'Series A' ? { ...c, conversion_ratio: 2 } : c,
    );
    const seen = plain(capitalizationExhibit({ ...INPUTS, share_classes: classes }, CONTEXT)!.html);
    expect(seen).toContain('As-converted');
    // 4,000,000 outstanding converting 2:1, both counts stated.
    expect(seen).toContain('4,000,000');
    expect(seen).toContain('8,000,000 (2.0000x)');
    // Total as-converted is 8,000,000 common + 8,000,000 converted + 1,500,000
    // options = 17,500,000, against 13,500,000 outstanding.
    expect(seen).toContain('13,500,000');
    expect(seen).toContain('17,500,000');
  });

  it('does not clutter a 1:1 table with a ratio every row shares', () => {
    const seen = plain(capitalizationExhibit(INPUTS, CONTEXT)!.html);
    expect(seen).not.toContain('1.0000x');
    expect(seen).toContain('No class on this table converts at other than 1:1');
    // Both share columns total the same figure when nothing converts.
    expect(seen.match(/13,500,000/g)).toHaveLength(2);
  });

  /**
   * A ratio at or below zero is a table the engine refuses outright, so it
   * never reached a price. Counting it as written would quote an as-converted
   * count of zero — a class that converts into nothing — instead of leaving the
   * row reading as the ordinary 1:1 it is stored as.
   */
  it('counts an unusable conversion ratio 1:1 rather than into nothing', () => {
    for (const bad of [0, -2, 'two', null]) {
      const classes = INPUTS.share_classes.map((c) =>
        c.name === 'Series A' ? { ...c, conversion_ratio: bad } : c,
      );
      const seen = plain(capitalizationExhibit({ ...INPUTS, share_classes: classes }, CONTEXT)!.html);
      expect(seen).toContain('13,500,000');
      expect(seen).not.toContain('0 (');
    }
  });

  /** Only preferred converts — the engine attaches a ratio to no other kind. */
  it('ignores a conversion ratio sitting on common or an option pool', () => {
    const classes = INPUTS.share_classes.map((c) =>
      c.kind === 'preferred' ? c : { ...c, conversion_ratio: 3 },
    );
    const seen = plain(capitalizationExhibit({ ...INPUTS, share_classes: classes }, CONTEXT)!.html);
    expect(seen).not.toContain('3.0000x');
    expect(seen.match(/13,500,000/g)).toHaveLength(2);
  });

  it('marks an uncapped participating class as uncapped', () => {
    const classes = INPUTS.share_classes.map((c) =>
      c.name === 'Series A' ? { ...c, participation_cap: undefined } : c,
    );
    const seen = plain(capitalizationExhibit({ ...INPUTS, share_classes: classes }, CONTEXT)!.html);
    expect(seen).toContain('Yes, uncapped');
  });

  it('falls back to the aggregate cap table when no class list was supplied', () => {
    const seen = plain(
      capitalizationExhibit(
        {
          shares_outstanding_common: 7_000_000,
          shares_outstanding_preferred: 2_000_000,
          options_outstanding: 1_000_000,
          liquidation_preference: 5_000_000,
        },
        CONTEXT,
      )!.html,
    );
    expect(seen).toContain('aggregate basis');
    expect(seen).toContain('10,000,000'); // fully diluted
    expect(seen).toContain('$5,000,000');
  });

  it('is absent when there is no capitalization to state', () => {
    expect(capitalizationExhibit({}, CONTEXT)).toBeNull();
  });

  it('escapes a class name rather than letting it close a cell', () => {
    const classes = [{ kind: 'common', name: 'Common <b>&</b> Founders', shares: 1_000 }];
    const html = capitalizationExhibit({ share_classes: classes }, CONTEXT)!.html;
    expect(html).toContain('Common &lt;b&gt;&amp;&lt;/b&gt; Founders');
    expect(html).not.toContain('<b>');
  });
});

// ── Exhibit B ────────────────────────────────────────────────────────────────

describe('approach reconciliation exhibit', () => {
  it('shows each indication, its weight and its weighted contribution', () => {
    const seen = plain(approachExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('OPM backsolve');
    expect(seen).toContain('Income (DCF)');
    expect(seen).toContain('Market (comparables)');
    expect(seen).toContain('50%');
    expect(seen).toContain('$26,000,000'); // 52M × 0.5
    expect(seen).toContain('$9,000,000'); // 36M × 0.25
    expect(seen).toContain('$42,000,000'); // concluded equity value
  });

  it('leaves out an approach carrying no weight', () => {
    const results = {
      ...RESULTS,
      approaches: { ...RESULTS.approaches, asset: { weight: 0, equity_value: 5_000_000 } },
    };
    expect(plain(approachExhibit(results, CONTEXT)!.html)).not.toContain('Asset approach');
  });

  it('is absent on a PWERM run, which has no approach block', () => {
    expect(approachExhibit({ ...RESULTS, approaches: undefined }, CONTEXT)).toBeNull();
  });

  it('claims a controlling basis only while nothing has classified the levels', () => {
    // The unclassified case keeps the original wording: nothing has been
    // measured that would justify replacing it.
    expect(plain(approachExhibit(RESULTS, CONTEXT)!.html)).toContain('on a marketable, controlling basis');
  });

  it('defers to Exhibit B-1 once the engine has classified them', () => {
    const seen = plain(approachExhibit(LEVELLED_RESULTS, CONTEXT)!.html);
    // The assertion Exhibit H had already stopped making. Saying it here as
    // well left one document contradicting itself across two schedules.
    expect(seen).not.toContain('on a marketable, controlling basis');
    expect(seen).toContain('Exhibit B-1');
  });
});

// ── Exhibit B-1 ──────────────────────────────────────────────────────────────

/** `dloc_detail` as `dloc.level_of_value_detail` records it on a mixed run. */
const LEVEL_DETAIL = {
  method: 'qualitative',
  dloc: 0.1,
  // The fixture's own weights: income 0.25 + market 0.25 + opm 0.5, so the
  // minority side (market + backsolve) is 0.75 of the weighted value.
  minority_basis_weight: 0.75,
  control_basis_weight: 0.25,
  approach_levels: { income: 'control', market: 'minority', opm_backsolve: 'minority' },
  double_counts_minority: true,
  note:
    '75% of the weighted equity value came from approaches that already produce a marketable ' +
    'minority value — a backsolve inverts the price a minority investor paid, and guideline public ' +
    'company multiples are struck on minority trading prices. A discount for lack of control ' +
    'applied to that portion discounts a second time for a control the value never included.',
};

const LEVELLED_RESULTS = {
  ...RESULTS,
  discounts: { ...RESULTS.discounts, dloc_method: 'qualitative', dloc_detail: LEVEL_DETAIL },
};

describe('Exhibit B-1 — level of value', () => {
  it('classifies each weighted approach beside the weight it carries', () => {
    const seen = plain(levelOfValueExhibit(LEVELLED_RESULTS, CONTEXT)!.html);
    expect(seen).toContain('OPM backsolve');
    expect(seen).toContain('Income (DCF)');
    expect(seen).toContain('Market (comparables)');
    expect(seen).toContain('Control, marketable');
    expect(seen).toContain('Minority, marketable');
    // The split the engine measured, restated as the total line.
    expect(seen).toContain('75% minority, 25% control');
  });

  it('orders the approaches heaviest first, as Exhibit B does', () => {
    const seen = plain(levelOfValueExhibit(LEVELLED_RESULTS, CONTEXT)!.html);
    expect(seen.indexOf('OPM backsolve')).toBeLessThan(seen.indexOf('Income (DCF)'));
  });

  it('states the double count in terms, and does not soften it into a footnote', () => {
    const seen = plain(levelOfValueExhibit(LEVELLED_RESULTS, CONTEXT)!.html);
    expect(seen).toContain('A discount for lack of control of 10.0% has been applied to a value');
    expect(seen).toContain('that is 75% minority-based');
    // The engine's own note, printed as it wrote it rather than re-derived —
    // this page and the analyst's pre-flight warning cannot then disagree.
    expect(seen).toContain('discounts a second time for a control the value never included');
  });

  it('says the ordinary thing when the majority of the value was at a control level', () => {
    const detail = {
      ...LEVEL_DETAIL,
      minority_basis_weight: 0.25,
      control_basis_weight: 0.75,
      double_counts_minority: false,
      note: undefined,
    };
    const seen = plain(
      levelOfValueExhibit({ ...RESULTS, discounts: { ...RESULTS.discounts, dloc_detail: detail } }, CONTEXT)!
        .html,
    );
    expect(seen).toContain('75% of the weighted equity value arrived at a control level');
    expect(seen).not.toContain('has been applied to a value');
  });

  it('prints an unfamiliar level as itself rather than as a blank cell', () => {
    const detail = { ...LEVEL_DETAIL, approach_levels: { income: 'liquidation' } };
    const seen = plain(
      levelOfValueExhibit({ ...RESULTS, discounts: { ...RESULTS.discounts, dloc_detail: detail } }, CONTEXT)!
        .html,
    );
    expect(seen).toContain('liquidation');
  });

  it('drops rather than guessing when the engine recorded no level of value', () => {
    // The PWERM path derives equity value from its own exit scenarios and has
    // no approach weights to classify; a zero DLOC cannot double-count. Both
    // reach here as an absent `approach_levels`.
    expect(levelOfValueExhibit(RESULTS, CONTEXT)).toBeNull();
    expect(levelOfValueExhibit({}, CONTEXT)).toBeNull();
    expect(levelOfValueExhibit({ discounts: { dloc_detail: {} } }, CONTEXT)).toBeNull();
    expect(
      levelOfValueExhibit(
        { discounts: { dloc_detail: { approach_levels: { income: 'control' } } } },
        CONTEXT,
      ),
    ).toBeNull();
    // Levels recorded, but none of them survived — nothing to tabulate.
    expect(
      levelOfValueExhibit(
        { discounts: { dloc_detail: { approach_levels: {}, minority_basis_weight: 0 } } },
        CONTEXT,
      ),
    ).toBeNull();
  });

  it('renders a weight the results block no longer carries as a dash, not a zero', () => {
    // A stored calculation whose `approaches` and `dloc_detail` disagree: the
    // level is still the engine's finding, and printing "0%" beside it would
    // assert a weight nobody recorded.
    const seen = plain(
      levelOfValueExhibit(
        { ...LEVELLED_RESULTS, approaches: { income: { weight: 0.25, equity_value: 1 } } },
        CONTEXT,
      )!.html,
    );
    expect(seen).toContain('—');
    expect(seen).toContain('Market (comparables)');
  });
});

// ── Exhibit B-2 ──────────────────────────────────────────────────────────────

describe('Exhibit B-2 — roll-forward from the prior valuation', () => {
  const b2 = (run: RollforwardRunRow | null = ROLLFORWARD, results: Record<string, unknown> = RESULTS) =>
    rollforwardExhibit(results, { ...CONTEXT, rollforward: run });

  it('prints the calibration trail step by step, not just its two ends', () => {
    // The substance of a roll-forward disclosure is the arithmetic between the
    // prior conclusion and the anchor; the two numbers alone are what the
    // deliverable already had, in two different documents.
    const s = b2()!;
    expect(s.heading).toBe('Exhibit B-2 — Roll-Forward from the Prior Valuation');
    const seen = plain(s.html);
    expect(seen).toContain('Prior concluded equity value');
    expect(seen).toContain('V-2025-0042');
    expect(seen).toContain('2025-06-30');
    expect(seen).toContain('$33,600,000');
    expect(seen).toContain('Calibration to 2026-06-30');
    expect(seen).toContain('25.0% per annum over 1.00 years');
    expect(seen).toContain('factor 1.2500x');
    expect(seen).toContain('Rolled equity value');
    expect(seen).toContain('$42,000,000');
  });

  it('names a new priced round as superseding the anchor rather than accreting it', () => {
    const priced = {
      ...ROLLFORWARD,
      new_round_post_money: 60_000_000,
      rolled_equity_value: 60_000_000,
      annual_accretion: 0,
      calibration_steps: [
        { step: 'prior_equity_value', value: 33_600_000 },
        { step: 'new_round_post_money', value: 60_000_000 },
      ],
    } satisfies RollforwardRunRow;
    const seen = plain(b2(priced)!.html);
    expect(seen).toContain('New priced round, post-money');
    expect(seen).toContain('supersedes the calibration anchor');
    expect(seen).not.toContain('per annum over');
  });

  it('labels an analyst adjustment with the label it was entered under', () => {
    const adjusted = {
      ...ROLLFORWARD,
      calibration_steps: [
        ...ROLLFORWARD.calibration_steps,
        { step: 'adjustment', label: 'Secondary transaction mark', value: 39_000_000 },
      ],
    } satisfies RollforwardRunRow;
    expect(plain(b2(adjusted)!.html)).toContain('Secondary transaction mark');
  });

  it('keeps the immaterial findings — they are the record the question was asked', () => {
    // "Revenue moved 4%, below the 20% threshold" is not noise. It is the
    // difference between a roll-forward somebody defended and one nobody
    // looked at, and dropping it would leave a reader unable to tell them
    // apart.
    const seen = plain(b2()!.html);
    expect(seen).toContain('Not material');
    expect(seen).toContain('revenue moved +4.0%');
  });

  it('says so plainly when a material change was found', () => {
    const material = {
      ...ROLLFORWARD,
      requires_full_revaluation: true,
      material_changes: [
        { field: 'revenue', material: true, detail: 'revenue moved +82.0%', delta_pct: 0.82 },
      ],
    } satisfies RollforwardRunRow;
    const seen = plain(b2(material)!.html);
    expect(seen).toContain('Material');
    expect(seen).toContain('One or more of the changes above is material');
    // And the caveat that follows from it: the calibrated value is evidence,
    // not the conclusion.
    expect(seen).toContain('not as the conclusion');
  });

  it('states that nothing was found when the change list is empty', () => {
    const clean = { ...ROLLFORWARD, material_changes: [] } satisfies RollforwardRunRow;
    const seen = plain(b2(clean)!.html);
    expect(seen).toContain('No difference between the two engagements');
    expect(seen).not.toContain('Not material');
  });

  it('reconciles the anchor against the value the valuation actually concluded', () => {
    // The reader's first question. The two are different measurements and the
    // exhibit has to say so, or the anchor reads as an alternative conclusion.
    const seen = plain(b2()!.html);
    expect(seen).toContain('The equity value concluded by this valuation is $42,000,000');
    expect(seen).toContain('are not the same measurement');
  });

  it('signs the difference between the anchor and the conclusion', () => {
    const seen = plain(b2(ROLLFORWARD, { ...RESULTS, equity_value: 46_200_000 })!.html);
    expect(seen).toContain('+10.0%');
  });

  it('is absent for an engagement valued from scratch', () => {
    expect(b2(null)).toBeNull();
  });

  it('is absent for a run nobody adopted', () => {
    // An unapplied run describes an anchor the calculation did not use. A
    // schedule claiming the conclusion bridges from it would be describing a
    // different valuation — so the builder checks as well as the loader.
    const proposed = { ...ROLLFORWARD, applied_at: null } satisfies RollforwardRunRow;
    expect(b2(proposed)).toBeNull();
  });

  it('is absent when the run carries no trail to print', () => {
    const empty = { ...ROLLFORWARD, calibration_steps: [] } satisfies RollforwardRunRow;
    expect(b2(empty)).toBeNull();
  });

  it('survives a results document with no concluded equity value', () => {
    const s = b2(ROLLFORWARD, {});
    expect(s).not.toBeNull();
    expect(plain(s!.html)).toContain('Rolled equity value');
    expect(plain(s!.html)).not.toContain('The equity value concluded by this valuation');
  });

  it('escapes a prior valuation number and an adjustment label', () => {
    // Both originate off the engagement and land inside table cells.
    const hostile = {
      ...ROLLFORWARD,
      prior_valuation_number: 'V-2025 <script>',
      calibration_steps: [
        ...ROLLFORWARD.calibration_steps,
        { step: 'adjustment', label: 'Down round & <b>haircut</b>', value: 30_000_000 },
      ],
    } satisfies RollforwardRunRow;
    const html = b2(hostile)!.html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Down round &amp; &lt;b&gt;haircut&lt;/b&gt;');
  });

  it('follows Exhibit B and leaves the lettering alone', () => {
    const headings = buildExhibits(calculation(), { ...CONTEXT, rollforward: ROLLFORWARD }).map(
      (s) => s.heading,
    );
    expect(headings).toEqual([
      'Exhibit A — Capitalization Table',
      'Exhibit B — Reconciliation of Valuation Approaches',
      'Exhibit B-2 — Roll-Forward from the Prior Valuation',
      'Exhibit C — Income Approach (Discounted Cash Flow)',
      'Exhibit D — Market Approach (Guideline Multiples)',
      'Exhibit F — Allocation of Equity Value',
      'Exhibit F-2 — Allocation Sensitivity',
      'Exhibit F-3 — Risk-Free Rate Sensitivity',
      'Exhibit H — Discounts and Concluded Value',
      'Appendix IV — Option Pricing Model Calculations',
    ]);
  });

  it('emits only markup the report renderer understands', () => {
    const html = b2()!.html;
    expect(sanitizeHtml(html)).toBe(html);
  });
});

// ── Exhibit C ────────────────────────────────────────────────────────────────

describe('income approach exhibit', () => {
  it('lays out the forecast, the discount factors and the equity bridge', () => {
    const seen = plain(incomeExhibit(INPUTS, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('Year 1');
    expect(seen).toContain('Year 3');
    expect(seen).toContain('$1,000,000'); // year 1 free cash flow
    expect(seen).toContain('$6,000,000'); // year 1 revenue
    expect(seen).toContain('0.8000x'); // 1 / 1.25
    expect(seen).toContain('25.00%'); // discount rate
    expect(seen).toContain('3.00%'); // terminal growth
    expect(seen).toContain('$34,000,000'); // enterprise value
    expect(seen).toContain('$36,000,000'); // equity value
  });

  it('bridges enterprise to equity with the cash and debt the engine used', () => {
    const seen = plain(incomeExhibit(INPUTS, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('$3,000,000'); // cash added
    expect(seen).toContain('-$1,000,000'); // debt deducted
  });

  it('omits the revenue column when revenue was not supplied for every year', () => {
    const inputs = { ...INPUTS, income: { ...INPUTS.income, revenues: [6_000_000] } };
    expect(plain(incomeExhibit(inputs, RESULTS, CONTEXT)!.html)).not.toContain('Revenue');
  });

  it('is absent when the income approach carried no weight', () => {
    expect(incomeExhibit(INPUTS, { ...RESULTS, approaches: {} }, CONTEXT)).toBeNull();
  });

  /*
   * The exhibit described one methodology and the engine could run four. Every
   * assertion above holds an end-of-year Gordon run against an exhibit that
   * printed "Gordon growth on the final-year flow" no matter what ran, so none
   * of them could tell the difference — which is the whole failure.
   */
  const withIncome = (income: Record<string, unknown>) => ({
    ...RESULTS,
    approaches: { ...RESULTS.approaches, income: { ...RESULTS.approaches.income, ...income } },
  });

  it('discounts on the mid-year convention when that is what ran', () => {
    const seen = plain(incomeExhibit(INPUTS, withIncome({ mid_year_convention: true }), CONTEXT)!.html);
    // Year 1 is half a year out, not a full one: 1 / 1.25^0.5, not 1 / 1.25.
    expect(seen).toContain('0.8944x');
    expect(seen).not.toContain('0.8000x');
    expect(seen).toContain('mid-year convention');
  });

  it('names the end-of-year convention rather than leaving the reader to assume one', () => {
    const seen = plain(incomeExhibit(INPUTS, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('end-of-year convention');
    expect(seen).toContain('0.8000x');
  });

  it('states an exit-multiple terminal value as one, with the metric it was struck on', () => {
    const seen = plain(
      incomeExhibit(
        INPUTS,
        withIncome({
          terminal_method: 'exit_multiple',
          terminal_detail: {
            method: 'exit_multiple',
            exit_multiple: 8.5,
            terminal_metric: 4_400_000,
            terminal_metric_basis: 'ebitda',
          },
        }),
        CONTEXT,
      )!.html,
    );
    expect(seen).toContain('Exit multiple');
    expect(seen).toContain('8.50x');
    expect(seen).toContain('$4,400,000');
    expect(seen).toContain('terminal-year EBITDA');
    expect(seen).toContain('Exit multiple on the terminal-year metric');
    // A terminal growth rate is a Gordon input. Printing 3.00% here would state
    // an assumption this calculation never made.
    expect(seen).not.toContain('Terminal growth rate');
    expect(seen).not.toContain('Gordon growth');
  });

  it('reads the methodology off the result, not off the request', () => {
    // Inputs asking for an exit multiple against a result that ran Gordon: the
    // exhibit must describe what computed, since that is the number beside it.
    const inputs = {
      ...INPUTS,
      income: { ...INPUTS.income, terminal_method: 'exit_multiple', exit_multiple: 8.5 },
    };
    const seen = plain(incomeExhibit(inputs, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('Gordon growth on the final-year flow');
    expect(seen).not.toContain('Exit multiple');
  });

  it('keeps the old exhibit for a calculation stored before the engine reported either choice', () => {
    // No mid_year_convention and no terminal_method on the approach: the
    // defaults it ran under, so the re-render must not silently restate it.
    const seen = plain(incomeExhibit(INPUTS, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('Terminal growth rate');
    expect(seen).toContain('3.00%');
    expect(seen).toContain('Gordon growth on the final-year flow');
  });
});

// ── Exhibit D ────────────────────────────────────────────────────────────────

describe('market approach exhibit', () => {
  it('lists the observed multiples and names the selected one as the median', () => {
    const seen = plain(marketExhibit(INPUTS, RESULTS, CONTEXT)!.html);
    expect(seen).toContain('5.00x');
    expect(seen).toContain('6.50x');
    expect(seen).toContain('7.10x');
    expect(seen).toContain('Selected multiple (median) 6.50x');
    expect(seen).toContain('$26,000,000');
    expect(seen).toContain('$28,000,000');
  });

  it('is absent when the market approach carried no weight', () => {
    expect(marketExhibit(INPUTS, { ...RESULTS, approaches: {} }, CONTEXT)).toBeNull();
  });
});

// ── Exhibit E ────────────────────────────────────────────────────────────────

describe('asset approach exhibit', () => {
  it('nets the balance sheet on the NAV method', () => {
    const results = {
      approaches: {
        asset: {
          weight: 1,
          method: 'nav',
          total_assets: 9_000_000,
          total_liabilities: 2_000_000,
          equity_value: 7_000_000,
        },
      },
    };
    const seen = plain(assetExhibit(results, CONTEXT)!.html);
    expect(seen).toContain('net-asset-value');
    expect(seen).toContain('$9,000,000');
    expect(seen).toContain('-$2,000,000');
    expect(seen).toContain('$7,000,000');
  });

  it('states the rebuild cost on the cost-to-replicate method', () => {
    const results = {
      approaches: { asset: { weight: 1, method: 'cost_to_replicate', equity_value: 3_000_000 } },
    };
    const seen = plain(assetExhibit(results, CONTEXT)!.html);
    expect(seen).toContain('cost-to-replicate');
    expect(seen).toContain('$3,000,000');
  });
});

// ── Exhibit F ────────────────────────────────────────────────────────────────

describe('allocation exhibit', () => {
  it('prints the breakpoint schedule the engine has always computed', () => {
    const seen = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('$10,000,000');
    expect(seen).toContain('$40,000,000');
    expect(seen).toContain('and above');
    expect(seen).toContain('Common 66.7%');
    expect(seen).toContain('Series A 33.3%');
  });

  it('names the allocation method in words, not in engine vocabulary', () => {
    const seen = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('Option pricing model');
    expect(seen).not.toContain('OPM_WATERFALL');
  });

  it('states the option-pricing inputs the allocation rests on', () => {
    const seen = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('65.0%'); // volatility
    expect(seen).toContain('3.50 years'); // time to exit
    expect(seen).toContain('4.20%'); // risk-free rate
  });

  it('gives each class its value and value per share', () => {
    const seen = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('$14,625,184');
    expect(seen).toContain('$1.8281');
    expect(seen).toContain('$5.0000');
  });

  it('states the single breakpoint on the aggregate model, which has no schedule', () => {
    const results = {
      ...RESULTS,
      allocation: {
        method: 'opm_single_breakpoint',
        breakpoint: 5_000_000,
        upside_after_preference: 18_000_000,
        common_fraction: 0.8,
      },
    };
    const seen = plain(allocationExhibit(results, CONTEXT)!.html);
    expect(seen).toContain('$5,000,000');
    expect(seen).toContain('$18,000,000');
    expect(seen).toContain('80.00%');
  });

  it('is absent when the run recorded no allocation', () => {
    expect(allocationExhibit({ fmv_per_share: 1 }, CONTEXT)).toBeNull();
  });
});

// ── Exhibit G ────────────────────────────────────────────────────────────────

// ── Exhibit F-2 ──────────────────────────────────────────────────────────────

describe('Exhibit F-2 — allocation sensitivity', () => {
  const f2 = (results: Record<string, unknown> = RESULTS, inputs: Record<string, unknown> = INPUTS) =>
    sensitivityExhibit(inputs, results, CONTEXT);

  it('restates the conclusion across a volatility and term grid', () => {
    const s = f2()!;
    expect(s.heading).toBe('Exhibit F-2 — Allocation Sensitivity');
    const seen = plain(s.html);
    // The applied assumptions are the centre of the grid: 65% at 3.50 years.
    expect(seen).toContain('65.0%');
    expect(seen).toContain('3.50 yrs');
    // And the stressed columns either side of it (±1 year, ±0.5 year).
    expect(seen).toContain('2.50 yrs');
    expect(seen).toContain('4.50 yrs');
    expect(seen).toContain('(base)');
  });

  it('prints the concluded figure to the four decimals the report concludes to', () => {
    // `sensitivity.ts` is denominated in cents, and passing cents straight
    // through would round a $1.2345 conclusion to $1.23 — a grid that
    // disagrees with the conclusion it exists to test. Four decimals, and a
    // sub-cent digit that is actually non-zero somewhere in the table.
    const html = f2()!.html;
    expect(html).toMatch(/\$\d[\d,]*\.\d{4}/);
    expect(html).not.toMatch(/\$\d[\d,]*\.\d{2}(?!\d)/);
  });

  it('marks every cell but the base as one the valuation does not adopt', () => {
    // The exhibit is a robustness statement, not a range of defensible values,
    // and a reader who takes a corner cell as an alternative conclusion has
    // taken the wrong number out of a signed report.
    const seen = plain(f2()!.html);
    expect(seen).toContain('No cell other than the base case is adopted');
  });

  it('moves the value up with volatility — it is a call option', () => {
    // Vega is positive, so each row down (higher sigma) must be worth more
    // than the one above it at the same term. A grid that did not would mean
    // the exhibit was stressing something other than the model it describes.
    const grid = sensitivityGrid({
      equityValueCents: 42_000_000 * 10_000,
      strikeCents: 10_000_000 * 10_000,
      volatility: 0.65,
      termYears: 3.5,
      riskFreeRate: 0.042,
      commonShares: 8_000_000,
      dlom: 0.25,
    });
    for (let col = 0; col < grid.terms.length; col++) {
      for (let row = 1; row < grid.rows.length; row++) {
        expect(grid.rows[row]![col]!.fmvPerShareCents).toBeGreaterThan(
          grid.rows[row - 1]![col]!.fmvPerShareCents,
        );
      }
    }
  });

  it('reads the preference off the blended model when there are no share classes', () => {
    const s = f2(RESULTS, { liquidation_preference: 10_000_000 });
    expect(s).not.toBeNull();
    expect(plain(s!.html)).toContain('(base)');
  });

  it('is absent when the allocation ran no option model', () => {
    // Current-value and as-converted allocations have no sigma and no term.
    // A grid struck on a defaulted volatility would be a table of numbers with
    // no relationship to the conclusion above it.
    expect(f2({ ...RESULTS, assumptions: { risk_free_rate: 0.042 } })).toBeNull();
    expect(f2({ ...RESULTS, assumptions: { volatility: 0.65, risk_free_rate: 0.042 } })).toBeNull();
    expect(f2({ ...RESULTS, assumptions: {} })).toBeNull();
  });

  it('is absent without a preference stack to strike against', () => {
    expect(
      f2(RESULTS, { share_classes: [{ kind: 'common', name: 'Common', shares: 8_000_000 }] }),
    ).toBeNull();
    expect(f2(RESULTS, {})).toBeNull();
  });

  it('is absent on a degenerate share count rather than dividing by it', () => {
    expect(f2({ ...RESULTS, fully_diluted_common: 0 })).toBeNull();
    expect(f2({ ...RESULTS, fully_diluted_common: null })).toBeNull();
  });

  it('treats an absent DLOM as no discount rather than dropping the schedule', () => {
    // DLOM is the one input with a defensible default: a valuation that
    // concluded no marketability discount still has a sensitivity to sigma.
    const s = f2({ ...RESULTS, discounts: {} });
    expect(s).not.toBeNull();
  });

  it('emits only markup the report renderer understands', () => {
    const html = f2()!.html;
    expect(sanitizeHtml(html)).toBe(html);
  });
});

// ── Exhibit F-3 ──────────────────────────────────────────────────────────────

describe('Exhibit F-3 — risk-free rate sensitivity', () => {
  const f3 = (results: Record<string, unknown> = RESULTS, inputs: Record<string, unknown> = INPUTS) =>
    rfrSensitivityExhibit(inputs, results, CONTEXT);

  it('stresses the rate against both of the other option inputs', () => {
    const s = f3()!;
    expect(s.heading).toBe('Exhibit F-3 — Risk-Free Rate Sensitivity');
    const seen = plain(s.html);
    expect(seen).toContain('Risk-free rate against expected volatility');
    expect(seen).toContain('Risk-free rate against expected term');
    // The applied rate, 200bp either side of it, and the two column axes.
    expect(seen).toContain('4.20%');
    expect(seen).toContain('2.20%');
    expect(seen).toContain('6.20%');
    expect(seen).toContain('65.0%');
    expect(seen).toContain('3.50 yrs');
  });

  it('marks exactly one cell per table as the applied case', () => {
    // Not `deltaFromBase === 0`, which is what F-2 can afford: the conclusion
    // barely moves across a risk-free axis, so neighbouring cells round to the
    // same delta and would each claim to be the base if position were not what
    // decided it.
    const html = f3()!.html;
    expect(html.match(/\(base\)/g)).toHaveLength(2);
  });

  it('prices the option higher as the rate rises — rho on a call is positive', () => {
    // A higher rate discounts the preference strike harder, so common is worth
    // more. A table that fell would mean the exhibit stresses something other
    // than the model it describes.
    const { tables } = sensitivityTables({
      equityValueCents: 42_000_000 * 10_000,
      strikeCents: 10_000_000 * 10_000,
      volatility: 0.65,
      termYears: 3.5,
      riskFreeRate: 0.042,
      commonShares: 8_000_000,
      dlom: 0.25,
    });
    for (const table_ of [tables.rfr_vol, tables.rfr_term]) {
      for (let col = 0; col < table_.colValues.length; col++) {
        for (let row = 1; row < table_.rows.length; row++) {
          expect(table_.rows[row]![col]!.fmvPerShareCents).toBeGreaterThan(
            table_.rows[row - 1]![col]!.fmvPerShareCents,
          );
        }
      }
    }
  });

  it('reports the rate’s effect in isolation, not the whole table’s range', () => {
    // The closing sentence is the one figure a reviewer takes away, and it is
    // about the rate: the volatility and term are held at the applied values.
    // Mixing in the vol axis would attribute sigma's spread to the rate.
    const seen = plain(f3()!.html);
    expect(seen).toContain('Holding the volatility and term at the values the conclusion adopts');
    expect(seen).toContain('No cell other than the base case is adopted');
  });

  it('moves the conclusion far less than volatility does', () => {
    // The robustness statement the exhibit exists to make. 200bp of rate is
    // worth a fraction of 20% of sigma, and if that ever stopped being true of
    // this model the exhibit's framing would be wrong.
    const opm = {
      equityValueCents: 42_000_000 * 10_000,
      strikeCents: 10_000_000 * 10_000,
      volatility: 0.65,
      termYears: 3.5,
      riskFreeRate: 0.042,
      commonShares: 8_000_000,
      dlom: 0.25,
    };
    const { tables } = sensitivityTables(opm);
    const rfrEffect = Math.abs(tables.rfr_vol.rows.at(-1)![2]!.deltaFromBase);
    const volEffect = Math.abs(tables.rfr_vol.rows[2]!.at(-1)!.deltaFromBase);
    expect(rfrEffect).toBeLessThan(volEffect);
  });

  it('does not print the same rate twice when the downward steps clamp at zero', () => {
    // A 2021-dated valuation struck at 45bp cannot be stressed 200bp downward.
    // Clamping without deduplicating would print 0.00% as three separate rows
    // carrying three identical sets of figures.
    const nearZero = { ...RESULTS, assumptions: { ...RESULTS.assumptions, risk_free_rate: 0.0045 } };
    const seen = plain(f3(nearZero)!.html);
    expect(seen.match(/0\.00%/g)).toHaveLength(2); // one row heading per table
    expect(seen).toContain('0.45%');
  });

  it('is absent wherever F-2 is absent — the two stress one model', () => {
    // Same guard, deliberately shared: a report carrying one sensitivity
    // schedule and not the other would be describing an OPM it could and could
    // not re-strike at the same time.
    for (const [results, inputs] of [
      [{ ...RESULTS, assumptions: {} }, INPUTS],
      [{ ...RESULTS, fully_diluted_common: 0 }, INPUTS],
      [RESULTS, {}],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      expect(rfrSensitivityExhibit(inputs, results, CONTEXT)).toBeNull();
      expect(sensitivityExhibit(inputs, results, CONTEXT)).toBeNull();
    }
  });

  it('emits only markup the report renderer understands', () => {
    const html = f3()!.html;
    expect(sanitizeHtml(html)).toBe(html);
  });
});

describe('PWERM scenario exhibit', () => {
  const results = {
    equity_value: 30_000_000,
    common_equity_value: 12_000_000,
    allocation_method: 'pwerm',
    assumptions: { expected_time_to_exit_years: 3.1 },
    allocation: {
      method: 'pwerm',
      scenarios: [
        {
          name: 'IPO',
          type: 'ipo',
          probability: 0.3,
          exit_equity_value: 90_000_000,
          time_to_exit_years: 4,
          common_present_value: 25_000_000,
        },
        {
          name: 'Acquisition',
          type: 'merger_acquisition',
          probability: 0.5,
          exit_equity_value: 40_000_000,
          time_to_exit_years: 3,
          common_present_value: 9_000_000,
        },
        {
          name: 'Dissolution',
          type: 'dissolution',
          probability: 0.2,
          exit_equity_value: 2_000_000,
          time_to_exit_years: 1.5,
          common_present_value: 0,
        },
      ],
    },
  };

  it('tabulates every scenario with its probability and present value', () => {
    const seen = plain(pwermExhibit(results, CONTEXT)!.html);
    expect(seen).toContain('IPO');
    expect(seen).toContain('merger acquisition');
    expect(seen).toContain('30.0%');
    expect(seen).toContain('$90,000,000');
    expect(seen).toContain('$25,000,000');
  });

  it('shows the probabilities summing to one, which the engine requires', () => {
    expect(plain(pwermExhibit(results, CONTEXT)!.html)).toContain('100%');
  });

  it('is absent on a run with no scenarios', () => {
    expect(pwermExhibit(RESULTS, CONTEXT)).toBeNull();
  });

  it('totals the columns it printed, not the figures concluded elsewhere', () => {
    /*
     * The footer used to print `equity_value` and `common_equity_value` — the
     * equity concluded across *all* approaches, and the common value after the
     * full weighting — and the expected time from `assumptions`. None is the
     * total of the column it sat under, so a reviewer adding up the exhibit got
     * a different number from the one printed on it. On a hybrid the
     * discrepancy is structural: the rows are the PWERM leg alone.
     *
     * The concluded figures here are set well away from the row totals, so a
     * footer that read them fails on every column.
     */
    const seen = plain(
      pwermExhibit({ ...results, equity_value: 30_000_000, common_equity_value: 9_100_000 }, CONTEXT)!.html,
    );
    expect(seen).toContain('100%');
    // 0.3 × 90m + 0.5 × 40m + 0.2 × 2m
    expect(seen).toContain('$47,400,000');
    // 0.3 × 25m + 0.5 × 9m + 0.2 × 0
    expect(seen).toContain('$12,000,000');
    // 0.3 × 4 + 0.5 × 3 + 0.2 × 1.5 — not the 3.1 in `assumptions`
    expect(seen).toContain('3.00');
    expect(seen).not.toContain('3.10');
    expect(seen).not.toContain('$30,000,000');
    expect(seen).not.toContain('$9,100,000');
  });

  it('finds the scenarios on the PWERM leg of a hybrid', () => {
    /*
     * A hybrid reports its two legs nested, so the scenarios sit one level
     * down. Reading only the flat key meant Exhibit G was silently absent from
     * exactly the reports that most need it: on a hybrid, PWERM often carries
     * the majority of the weight, and the body's Allocation chapter sends the
     * reader to the schedule regardless.
     */
    const hybrid = {
      ...results,
      allocation_method: 'hybrid',
      allocation: {
        method: 'hybrid',
        weights: { opm: 0.35, pwerm: 0.65 },
        opm: { equity_value: 28_000_000, allocation: {} },
        pwerm: { equity_value: 32_000_000, scenarios: results.allocation.scenarios },
      },
    };
    const seen = plain(pwermExhibit(hybrid, CONTEXT)!.html);
    expect(seen).toContain('IPO');
    expect(seen).toContain('100%');
  });

  it('finds them on a hybrid that reported its PWERM leg at the top level', () => {
    // Read last and deliberately: it makes the exhibit appear for hybrid
    // valuations already stored, which would otherwise need re-running the
    // engine to gain a schedule their own body already refers them to.
    const stored = {
      ...results,
      allocation_method: 'hybrid',
      allocation: { method: 'hybrid', weights: { opm: 0.5, pwerm: 0.5 } },
      pwerm_allocation: { scenarios: results.allocation.scenarios },
    };
    expect(plain(pwermExhibit(stored, CONTEXT)!.html)).toContain('Acquisition');
  });

  it('stays absent on a hybrid whose PWERM leg carried no scenarios', () => {
    const empty = {
      ...results,
      allocation_method: 'hybrid',
      allocation: { method: 'hybrid', pwerm: { equity_value: 32_000_000, scenarios: null } },
    };
    expect(pwermExhibit(empty, CONTEXT)).toBeNull();
  });
});

// ── Exhibit H ────────────────────────────────────────────────────────────────

describe('discount exhibit', () => {
  it('closes exactly on the concluded fair market value', () => {
    const seen = plain(discountExhibit(RESULTS, CONTEXT)!.html);
    expect(seen).toContain('$1.8281'); // marketable, controlling
    expect(seen).toContain('10.0%'); // DLOC
    expect(seen).toContain('25.0%'); // DLOM
    expect(seen).toContain('$1.2345'); // concluded FMV
    expect(seen).toContain('Chaffee protective-put model');
    expect(seen).toContain('as of 2026-06-30');
  });

  it('shows the intermediate marketable-minority value between the two discounts', () => {
    // 1.828148 × 0.9 = 1.6453
    expect(plain(discountExhibit(RESULTS, CONTEXT)!.html)).toContain('$1.6453');
  });

  it('inverts the identity when the allocation reports no per-share value', () => {
    const results = { ...RESULTS, allocation: { method: 'as_converted' } };
    const seen = plain(discountExhibit(results, CONTEXT)!.html);
    // fmv / ((1 - 0.1) × (1 - 0.25)) = 1.2345 / 0.675 = 1.828889
    expect(seen).toContain('$1.8289');
    expect(seen).toContain('$1.2345');
  });

  it('is absent without a concluded value', () => {
    expect(discountExhibit({ discounts: { dloc: 0.1 } }, CONTEXT)).toBeNull();
  });

  it('names every DLOM method rather than printing four of the seven as slugs', () => {
    // The Basis column read a three-entry map of its own while Exhibit H-1 had
    // the full one. A conclusion on a restricted-stock blend printed
    // "restricted_stock" on the page that states the conclusion.
    const studies = {
      ...RESULTS,
      discounts: { ...(RESULTS.discounts as object), dlom_method: 'restricted_stock' },
    };
    const seen = plain(discountExhibit(studies, CONTEXT)!.html);
    expect(seen).toContain('Restricted-stock studies');
    expect(seen).not.toContain('restricted_stock');
  });

  it('does not call the allocated value controlling when it was not', () => {
    /*
     * The line said "marketable, controlling" unconditionally, and for the
     * typical 409A it is false: most of the weight sits on a backsolve, which
     * inverts the price a minority investor paid, and on guideline public
     * company multiples, which are minority trading prices. The engine now
     * records the mix and the label follows it.
     */
    const minority = {
      ...RESULTS,
      discounts: {
        ...(RESULTS.discounts as object),
        dloc_detail: { method: 'stated', minority_basis_weight: 0.75, double_counts_minority: true },
      },
    };
    const seen = plain(discountExhibit(minority, CONTEXT)!.html);
    expect(seen).not.toContain('Marketable, controlling value');
    expect(seen).toContain('75%');
    // And the double count itself is disclosed, not left in a database column.
    expect(seen).toContain('applied on top');
    // Both halves of the exhibit follow the same judgement. The per-class table
    // below kept its own unconditional sentence and went on asserting a
    // controlling basis three lines under the note reporting that 75% of the
    // weighted value arrived at a minority level already.
    expect(seen).not.toContain('values every class on a marketable, controlling basis');
  });

  it('still calls the allocation controlling where the weight really is', () => {
    // The mirror case: an income-weighted valuation does produce a controlling
    // value, and the original sentence is the right one for it.
    const controlling = {
      ...RESULTS,
      discounts: {
        ...(RESULTS.discounts as object),
        dloc_detail: { method: 'stated', minority_basis_weight: 0.2 },
      },
    };
    const seen = plain(discountExhibit(controlling, CONTEXT)!.html);
    expect(seen).toContain('Marketable, controlling value');
    expect(seen).toContain('values every class on a marketable, controlling basis');
  });

  it('shows a control premium being inverted, and the synergy taken out of it first', () => {
    const derived = {
      ...RESULTS,
      discounts: {
        ...(RESULTS.discounts as object),
        dloc_method: 'control_premium',
        dloc_detail: {
          method: 'control_premium',
          observed_control_premium: 0.4,
          synergy_share: 0.4,
          control_premium_applied: 0.24,
          dloc: 0.193548,
        },
      },
    };
    const seen = plain(discountExhibit(derived, CONTEXT)!.html);
    expect(seen).toContain('Inverted from a stated control premium');
    expect(seen).toContain('40.0%');
    expect(seen).toContain('24.0%');
    expect(seen).toContain('synergies');
  });

  it('flags a discount resting on the engine’s own decade summaries', () => {
    const derived = {
      ...RESULTS,
      discounts: {
        ...(RESULTS.discounts as object),
        dloc_method: 'studies',
        dloc_detail: {
          method: 'studies',
          observed_control_premium: 0.305,
          indicative_table: true,
          thin_study_set: true,
          studies: [
            { study: 'US public targets, 2010s', period_start: 2010, period_end: 2019, premium: 0.3 },
            { study: 'US public targets, 2020s', period_start: 2020, period_end: 2024, premium: 0.31 },
          ],
        },
      },
    };
    const seen = plain(discountExhibit(derived, CONTEXT)!.html);
    expect(seen).toContain('US public targets, 2020s');
    expect(seen).toContain('31.0%');
    expect(seen).toContain('built-in decade summaries');
    expect(seen).toContain('fewer than three studies');
  });

  it('says nothing about a DLOC the run did not derive', () => {
    // Every valuation stored before the method vocabulary existed. The exhibit
    // reads as it did before.
    expect(plain(discountExhibit(RESULTS, CONTEXT)!.html)).not.toContain('derivation');
  });
});

// ── Exhibit D-1 ──────────────────────────────────────────────────────────────

describe('peer set exhibit', () => {
  const peers = [
    {
      ticker: 'AAA',
      name: 'Alpha Analytics',
      included: true,
      exclude_reason: null,
      source: 'market_feed',
      score: 0.82,
      multiples: { ev_revenue_ltm: 5.0, ev_ebitda_ltm: null },
    },
    {
      ticker: 'BBB',
      name: 'Beta & Sons <Holdings>',
      included: true,
      exclude_reason: null,
      source: 'analyst',
      score: null,
      multiples: { ev_revenue_ltm: 6.5, ev_ebitda_ltm: null },
    },
    {
      ticker: 'ZZZ',
      name: 'Zeta Mining',
      included: false,
      exclude_reason: 'different industry',
      source: 'market_feed',
      score: 0.05,
      multiples: { ev_revenue_ltm: 1.1, ev_ebitda_ltm: null },
    },
  ];

  it('names the retained companies and the ones set aside, with the basis', () => {
    const seen = plain(peerSetExhibit(peers, RESULTS)!.html);
    expect(seen).toContain('Alpha Analytics (AAA)');
    expect(seen).toContain('Zeta Mining (ZZZ)');
    expect(seen).toContain('different industry');
  });

  it('prints only the multiples the retained set actually has', () => {
    // Every retained comp is loss-making here, so an EV/EBITDA column would be
    // a column of dashes — which tells a reader nothing about the comps.
    const html = peerSetExhibit(peers, RESULTS)!.html;
    expect(html).toContain('EV/LTM Revenue');
    expect(html).not.toContain('EV/LTM EBITDA');
  });

  it('escapes company names, which come from the engagement', () => {
    expect(peerSetExhibit(peers, RESULTS)!.html).toContain('Beta &amp; Sons &lt;Holdings&gt;');
  });

  it('is absent without a peer set', () => {
    expect(peerSetExhibit(undefined, RESULTS)).toBeNull();
    expect(peerSetExhibit([], RESULTS)).toBeNull();
  });

  /*
   * Where the figures behind the multiples came from (migration 0133). A
   * reader cannot check a multiple without knowing whether its inputs were
   * observed in the market or read off a maintained reference table, and the
   * exhibit could not say because nothing recorded it.
   */
  describe('provenance of the figures', () => {
    const withFigures = (source: string | null, asOf: string | null = '2026-08-01T00:00:00.000Z') =>
      peers.map((p) => (p.included ? { ...p, figures_source: source, figures_as_of: asOf } : p));

    it('says so when the figures are observed market data', () => {
      const seen = plain(peerSetExhibit(withFigures('live'), RESULTS)!.html);
      expect(seen).toContain('observed market data');
      expect(seen).toContain('current as at 2026-08-01');
    });

    it('says plainly that a reference figure is not a quote', () => {
      const seen = plain(peerSetExhibit(withFigures('snapshot'), RESULTS)!.html);
      expect(seen).toContain('maintained reference set');
      expect(seen).toContain('rather than from a real-time market feed');
    });

    it('treats a row written before the columns existed as the reference set', () => {
      // Null is what every pre-0133 row holds, and the reference set is where
      // those figures came from. Silence would let a reader assume otherwise.
      const seen = plain(peerSetExhibit(withFigures(null, null), RESULTS)!.html);
      expect(seen).toContain('maintained reference set');
      // …but no vintage is claimed, because none was ever recorded.
      expect(seen).not.toContain('current as at');
    });

    it('does not pass a mixed set off as one source', () => {
      const mixed = peers.map((p, i) =>
        p.included
          ? { ...p, figures_source: i === 0 ? 'live' : 'analyst', figures_as_of: '2026-08-01T00:00:00.000Z' }
          : p,
      );
      const seen = plain(peerSetExhibit(mixed, RESULTS)!.html);
      expect(seen).toContain('more than one source');
    });
  });

  it('is absent when the run applied no market approach', () => {
    // A set an analyst screened but never weighted into the conclusion is
    // working material; printing it as a supporting schedule overstates it.
    const noMarket = { ...RESULTS, approaches: { income: { weight: 1 } } };
    expect(peerSetExhibit(peers, noMarket)).toBeNull();
  });

  it('follows Exhibit D and leaves the lettering alone', () => {
    const headings = buildExhibits(calculation(), { ...CONTEXT, peers }).map((s) => s.heading);
    expect(headings).toEqual([
      'Exhibit A — Capitalization Table',
      'Exhibit B — Reconciliation of Valuation Approaches',
      'Exhibit C — Income Approach (Discounted Cash Flow)',
      'Exhibit D — Market Approach (Guideline Multiples)',
      'Exhibit D-1 — Guideline Company Set',
      'Exhibit F — Allocation of Equity Value',
      'Exhibit F-2 — Allocation Sensitivity',
      'Exhibit F-3 — Risk-Free Rate Sensitivity',
      'Exhibit H — Discounts and Concluded Value',
      'Appendix IV — Option Pricing Model Calculations',
    ]);
  });

  it('renders through the report sanitizer without losing its table', () => {
    const clean = sanitizeHtml(peerSetExhibit(peers, RESULTS)!.html, ALLOWED_TAGS);
    expect(clean).toContain('<table>');
    expect(clean).toContain('Alpha Analytics (AAA)');
  });
});

/**
 * The simulated allocation in the deliverable.
 *
 * A Monte Carlo run has to disclose two things a closed-form one does not, and
 * both are about whether a reader can trust the figure: the seed, because a
 * concluded value nobody can re-derive is not a conclusion, and the standard
 * error, because a simulated number without one is a number pretending to be
 * exact.
 */
describe('Exhibit F — a simulated allocation', () => {
  const MC_RESULTS = {
    equity_value: 72_000_000,
    allocation_method: 'monte_carlo',
    common_equity_value: 32_875_000,
    fmv_per_share: 2.4545,
    fully_diluted_common: 9_250_000,
    fully_diluted_basis: 'cap_table_common',
    assumptions: { volatility: 0.62, risk_free_rate: 0.0421, time_to_exit_years: 4 },
    discounts: { dloc: 0.08, dlom: 0.25 },
    allocation: {
      method: 'monte_carlo',
      paths: 20_000,
      antithetic: true,
      seed: 409,
      common_value: 32_875_000,
      common_shares: 9_250_000,
      common_per_share: 3.5537,
      standard_error_per_share: 0.0605,
      scenarios: [
        { name: 'IPO', probability: 0.3, years_to_exit: 5, volatility: 0.7, common_per_share: 3.66 },
        { name: 'Trade sale', probability: 0.7, years_to_exit: 2, volatility: 0.5, common_per_share: 3.48 },
      ],
      classes: {
        Common: { kind: 'common', shares: 9_250_000, value: 32_875_000, per_share: 3.5537 },
      },
    },
  };

  const html = () => allocationExhibit(MC_RESULTS, { currency: 'USD' })!.html;

  it('names the method rather than echoing the key', () => {
    expect(html()).toContain('Monte Carlo simulation');
    expect(html()).not.toContain('MONTE_CARLO');
  });

  it('states the seed, so the run can be reproduced', () => {
    expect(html()).toContain('Random seed');
    expect(html()).toContain('409');
  });

  it('states the path count and that pairs were antithetic', () => {
    expect(html()).toContain('20,000');
    expect(html()).toContain('antithetic');
  });

  it('states the standard error against the figure it qualifies', () => {
    // Reported to six decimals: the conclusion is stated to four, and an error
    // rounded to the same place would read as zero.
    expect(html()).toContain('Standard error');
    expect(html()).toContain('0.060500');
  });

  it('does not claim the mixture is a PWERM schedule', () => {
    // Monte Carlo scenarios carry a horizon and a volatility and no exit value,
    // because the exit is a distribution. Rendering them through Exhibit G's
    // columns would print $0 exit value and $0 present value for each, in an
    // exhibit headed "Probability-Weighted Expected Return".
    expect(pwermExhibit(MC_RESULTS, { currency: 'USD' })).toBeNull();
  });

  it('still renders Exhibit G for an actual PWERM run', () => {
    const pwerm = {
      ...MC_RESULTS,
      allocation_method: 'pwerm',
      assumptions: { expected_time_to_exit_years: 3.2 },
      allocation: {
        method: 'pwerm',
        scenarios: [
          {
            name: 'IPO',
            type: 'ipo',
            probability: 0.3,
            exit_equity_value: 120_000_000,
            time_to_exit_years: 4,
            common_present_value: 20_000_000,
          },
        ],
      },
    };
    expect(pwermExhibit(pwerm, { currency: 'USD' })).not.toBeNull();
  });
});

// ── Exhibit B — the market movement adjustment ───────────────────────────────

describe('market movement in Exhibit B', () => {
  const MOVED = {
    ...RESULTS,
    market_movement: {
      factor: 0.899,
      index_return: -0.0878,
      beta: 1.15,
      index_start: 4812.6,
      index_end: 4390.1,
      index_name: 'S&P North American Technology Software Index',
      period_start: '2025-10-15',
      period_end: '2026-06-30',
    },
    approaches: {
      ...RESULTS.approaches,
      opm_backsolve: {
        ...RESULTS.approaches.opm_backsolve,
        equity_value: 46_748_000,
        unadjusted_equity_value: 52_000_000,
        market_movement: { factor: 0.899 },
      },
    },
  };

  const html = () => plain(approachExhibit(MOVED, CONTEXT)!.html);

  it('shows the round indication before and after the adjustment', () => {
    // Printing only the adjusted figure would hide the most contestable step in
    // the reconciliation: the round transacted at a price, and this valuation
    // concluded the price means something different today.
    expect(html()).toContain('$52,000,000');
    expect(html()).toContain('$46,748,000');
  });

  it('names the benchmark, the period and the beta', () => {
    const text = html();
    expect(text).toContain('S&amp;P North American Technology Software Index');
    expect(text).toContain('2025-10-15 to 2026-06-30');
    expect(text).toContain('1.15');
    expect(text).toContain('-8.8%');
  });

  it('prints index levels as levels, not as multiples', () => {
    // `ratio()` would suffix them and print the S&P at "4812.60x".
    const text = html();
    expect(text).toContain('4,812.6');
    expect(text).not.toContain('4,812.6x');
  });

  it('states the factor and how it was derived', () => {
    expect(html()).toContain('0.8990x');
    expect(html()).toContain('1 + β × benchmark return');
  });

  it('says nothing at all when no adjustment was made', () => {
    // The common case. A row reading "1.0000x" would imply somebody measured a
    // movement, on a valuation dated days after its round where nobody did.
    const text = plain(approachExhibit(RESULTS, CONTEXT)!.html);
    expect(text).not.toContain('Market movement');
    expect(text).not.toContain('Benchmark');
  });
});

// ── Exhibit H-1 — the marketability discount, derived ────────────────────────

describe('dlomDerivationExhibit', () => {
  const MODEL = {
    ...RESULTS,
    discounts: {
      dloc: 0.1,
      dlom: 0.2448,
      dlom_method: 'finnerty',
      dlom_detail: {
        method: 'finnerty',
        volatility: 0.62,
        time_to_liquidity_years: 4,
        dlom: 0.244969,
        formula: 'Finnerty average-strike put — 2N(v/2) - 1 with effective variance',
      },
    },
    class_volatility: {
      enterprise_volatility: 0.62,
      time_to_exit_years: 4,
      risk_free_rate: 0.0421,
      equity_value: 42_000_000,
      delta_total: 1,
      classes: {
        Common: { kind: 'common', value: 19_900_045, delta: 0.555, elasticity: 1.1971, volatility: 0.7422 },
        'Series A': {
          kind: 'preferred',
          value: 6_215_857,
          delta: 0.1422,
          elasticity: 0.9762,
          volatility: 0.6052,
        },
      },
    },
  };

  it('states the inputs the model was struck on', () => {
    // A bare 24.5% is not reviewable: the model is arithmetic nobody disputes,
    // and the volatility and holding period *are* the argument.
    const text = plain(dlomDerivationExhibit(MODEL, CONTEXT)!.html);
    expect(text).toContain('Finnerty average-strike put model');
    expect(text).toContain('62.0%');
    expect(text).toContain('4.00 years');
    expect(text).toContain('24.5%');
  });

  it('shows each class carrying its own volatility, above the enterprise for common', () => {
    const text = plain(dlomDerivationExhibit(MODEL, CONTEXT)!.html);
    // Common ranks behind the whole preference stack, so it is a levered claim
    // and its return volatility exceeds the enterprise's — which is the whole
    // reason the schedule is worth printing.
    expect(text).toContain('74.2%');
    expect(text).toContain('60.5%');
    expect(text).toContain('1.20x');
  });

  /**
   * The exhibit has to say *which* volatility the discount was struck on.
   *
   * The engine strikes an option-based DLOM on the class's own volatility by
   * default (`dlom_volatility_basis`), and on a company with a preference stack
   * that figure is well above the enterprise one — 74.2% against 62% here. The
   * paragraph under the derivation table was written when only the enterprise
   * figure could reach it and said so unconditionally, so the corrected report
   * printed "The volatility above describes the enterprise" directly beneath a
   * row reading 74.2%: the exhibit contradicting itself on the one number the
   * discount turns on.
   */
  describe('the volatility the discount was struck on', () => {
    const onClass = {
      ...MODEL,
      discounts: {
        ...MODEL.discounts,
        dlom: 0.2738,
        dlom_detail: {
          ...MODEL.discounts.dlom_detail,
          volatility: 0.741875,
          volatility_basis: 'class',
          dlom: 0.273762,
        },
      },
    };

    it('names the class when the discount ran on common’s own volatility', () => {
      const text = plain(dlomDerivationExhibit(onClass, CONTEXT)!.html);
      expect(text).toContain('Of the class valued');
      expect(text).toContain('The volatility above is common’s own');
      expect(text).not.toContain('The volatility above describes the enterprise');
    });

    it('says so when the discount ran on the enterprise figure instead', () => {
      const onEnterprise = {
        ...MODEL,
        discounts: {
          ...MODEL.discounts,
          dlom_detail: { ...MODEL.discounts.dlom_detail, volatility_basis: 'enterprise' },
        },
      };
      const text = plain(dlomDerivationExhibit(onEnterprise, CONTEXT)!.html);
      expect(text).toContain('Of the enterprise as a whole, not of the class valued');
      expect(text).toContain('describes the enterprise, not the class the discount was struck on');
    });

    it('reads the basis through a weighted blend, where it sits on each leg', () => {
      // A blend records no basis of its own — a study leg has no volatility at
      // all — so the label lives on the option-based legs.
      const blended = {
        ...MODEL,
        discounts: {
          ...MODEL.discounts,
          dlom_method: 'weighted',
          dlom_detail: {
            method: 'weighted',
            dlom: 0.28,
            components: [
              { method: 'restricted_stock', weight: 0.5, dlom: 0.29 },
              {
                method: 'finnerty',
                weight: 0.5,
                dlom: 0.2738,
                detail: { method: 'finnerty', volatility: 0.741875, volatility_basis: 'class' },
              },
            ],
          },
        },
      };
      const text = plain(dlomDerivationExhibit(blended, CONTEXT)!.html);
      expect(text).toContain('The volatility above is common’s own');
    });

    it('keeps its original wording for a calculation that predates the field', () => {
      // Older stored calculations record no basis. They were struck on the
      // enterprise figure, which is what the original sentence described.
      const text = plain(dlomDerivationExhibit(MODEL, CONTEXT)!.html);
      expect(text).toContain('The volatility above describes the enterprise');
    });
  });

  /**
   * The aggregate common claim — `class_volatility.common_volatility`.
   *
   * The per-class rows are each one class. The interest a §409A concludes on is
   * common, and on a cap table with two common classes no row above is that
   * claim: the schedule printed 76.1% and 71.4% while the discount was struck
   * on 74.2%, a figure a reader could not find anywhere on the page. The engine
   * had computed it and nothing printed it.
   */
  describe('the aggregate common line', () => {
    /** Two common classes, so no single row is the interest being valued. */
    const TWO_COMMON = {
      ...MODEL,
      discounts: {
        ...MODEL.discounts,
        dlom_detail: { ...MODEL.discounts.dlom_detail, volatility_basis: 'class' },
      },
      class_volatility: {
        ...MODEL.class_volatility,
        common_volatility: 0.7422,
        classes: {
          Common: { kind: 'common', value: 12_000_000, delta: 0.34, elasticity: 1.19, volatility: 0.7378 },
          'Founders Common': {
            kind: 'common',
            value: 7_900_045,
            delta: 0.215,
            elasticity: 1.2064,
            volatility: 0.7482,
          },
          'Series A': {
            kind: 'preferred',
            value: 6_215_857,
            delta: 0.1422,
            elasticity: 0.9762,
            volatility: 0.6052,
          },
        },
      },
    };

    it('prints the volatility the discount was actually struck on', () => {
      const text = plain(dlomDerivationExhibit(TWO_COMMON, CONTEXT)!.html);
      expect(text).toContain('Common — aggregate (applied)');
      // 74.22% — between the two common classes, and equal to neither of them.
      expect(text).toContain('74.2%');
      expect(text).toContain('73.8%');
      expect(text).toContain('74.8%');
    });

    it('foots the delta column and gears against the enterprise figure', () => {
      const text = plain(dlomDerivationExhibit(TWO_COMMON, CONTEXT)!.html);
      // 0.34 + 0.215, which is the column above added up — arithmetic a reader
      // can redo, not a second derivation of the volatility.
      expect(text).toContain('0.5550');
      // 0.7422 ÷ 0.62.
      expect(text).toContain('1.20x');
    });

    it('sends the reader to that line by name', () => {
      const text = plain(dlomDerivationExhibit(TWO_COMMON, CONTEXT)!.html);
      expect(text).toContain('taken from the aggregate common line of the schedule below');
    });

    it('marks it applied only when the discount was struck on the class basis', () => {
      const onEnterprise = {
        ...TWO_COMMON,
        discounts: {
          ...TWO_COMMON.discounts,
          dlom_detail: { ...TWO_COMMON.discounts.dlom_detail, volatility_basis: 'enterprise' },
        },
      };
      const text = plain(dlomDerivationExhibit(onEnterprise, CONTEXT)!.html);
      // Still printed — it is what shows the reader the gearing the discount
      // did not carry — but not claimed to be the figure that was used.
      expect(text).toContain('Common — aggregate');
      expect(text).not.toContain('Common — aggregate (applied)');
      expect(text).toContain('and on the aggregate common line of the schedule below that figure');
    });

    it('prints no line when the waterfall reported no aggregate figure', () => {
      // Every calculation stored before the engine recorded it, and every run
      // whose common classes are collectively worth nothing — the engine
      // reports a null there rather than an infinity. The paragraph falls back
      // to sending the reader to the schedule as a whole.
      const noAggregate = {
        ...TWO_COMMON,
        class_volatility: { ...TWO_COMMON.class_volatility, common_volatility: undefined },
      };
      const text = plain(dlomDerivationExhibit(noAggregate, CONTEXT)!.html);
      expect(text).not.toContain('Common — aggregate');
      expect(text).toContain('taken from the schedule below');
    });

    it('prints no line when the cap table carries no common class', () => {
      const preferredOnly = {
        ...TWO_COMMON,
        class_volatility: {
          ...TWO_COMMON.class_volatility,
          classes: { 'Series A': TWO_COMMON.class_volatility.classes['Series A'] },
        },
      };
      expect(plain(dlomDerivationExhibit(preferredOnly, CONTEXT)!.html)).not.toContain('Common — aggregate');
    });

    it('dashes the delta rather than inventing one when a class recorded none', () => {
      const partial = {
        ...TWO_COMMON,
        class_volatility: {
          ...TWO_COMMON.class_volatility,
          classes: {
            ...TWO_COMMON.class_volatility.classes,
            'Founders Common': { kind: 'common', value: 7_900_045, volatility: 0.7482 },
          },
        },
      };
      const text = plain(dlomDerivationExhibit(partial, CONTEXT)!.html);
      // The volatility is the engine's and still prints; the column sum is not
      // available, and a partial total would be a figure that does not foot.
      expect(text).toMatch(/Common — aggregate \(applied\) common — 1\.20x 74\.2%/);
    });
  });

  it('discloses a Longstaff conclusion as an upper bound', () => {
    const longstaff = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.31,
        dlom_method: 'longstaff',
        dlom_detail: { method: 'longstaff', bound_multiple: 1.4498, is_upper_bound: true, dlom: 0.31 },
      },
    };
    const text = plain(dlomDerivationExhibit(longstaff, CONTEXT)!.html);
    expect(text).toContain('upper bound');
    expect(text).toContain('1.4498x');
  });

  it('names the restricted-stock studies a blended conclusion rests on', () => {
    const studies = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.221,
        dlom_method: 'restricted_stock',
        dlom_detail: {
          method: 'restricted_stock',
          statistic: 'median',
          dlom: 0.221,
          studies: [
            { study: 'silber', period_start: 1981, period_end: 1988, observations: 69, median: 0.339 },
            { study: 'stout_2018', period_start: 2008, period_end: 2018, observations: 143, median: 0.182 },
          ],
        },
      },
    };
    const text = plain(dlomDerivationExhibit(studies, CONTEXT)!.html);
    // Set selection is the whole objection to the method, so naming the studies
    // is not a courtesy.
    expect(text).toContain('silber');
    expect(text).toContain('stout_2018');
    expect(text).toContain('1981–1988');
    expect(text).toContain('Rule 144');
  });

  it('prints the discount off the field the engine actually records', () => {
    /*
     * The engine's study rows carry `discount` (engine dlom.py `_study_rows`),
     * and this column used to read `median`/`mean`/`dlom` — none of which exist
     * on them. Every row's discount printed as an em dash, so the exhibit whose
     * entire job is to show what the conclusion rests on tabulated the study
     * names against nothing.
     */
    const studies = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.13,
        dlom_method: 'restricted_stock',
        dlom_detail: {
          method: 'restricted_stock',
          statistic: 'median',
          dlom: 0.13,
          low: 0.13,
          high: 0.13,
          study_count: 1,
          thin_study_set: true,
          straddles_rule_144_amendment: false,
          studies: [
            {
              study: 'Columbia Financial Advisors (post-amendment)',
              period_start: 1997,
              period_end: 1998,
              discount: 0.13,
              statistic: 'mean',
            },
          ],
        },
      },
    };
    const text = plain(dlomDerivationExhibit(studies, CONTEXT)!.html);
    expect(text).toContain('13.0%');
    expect(text).toContain('1997–1998');
    // And the engine's own caveat about a set this narrow, which nothing printed.
    expect(text).toContain('fewer than three studies');
  });

  it('carries the Rule 144 straddle caveat the engine flagged', () => {
    const studies = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.17,
        dlom_method: 'restricted_stock',
        dlom_detail: {
          method: 'restricted_stock',
          statistic: 'median',
          dlom: 0.17,
          low: 0.13,
          high: 0.21,
          straddles_rule_144_amendment: true,
          studies: [
            {
              study: 'Columbia Financial Advisors (pre-amendment)',
              period_start: 1996,
              period_end: 1997,
              discount: 0.21,
            },
            {
              study: 'Columbia Financial Advisors (post-amendment)',
              period_start: 1997,
              period_end: 1998,
              discount: 0.13,
            },
          ],
        },
      },
    };
    const text = plain(dlomDerivationExhibit(studies, CONTEXT)!.html);
    expect(text).toContain('spans the April 1997 amendment');
    // The range is stated so nobody reads the median as a midpoint.
    expect(text).toContain('13.0%');
    expect(text).toContain('21.0%');
  });

  it('describes a pre-IPO conclusion as pre-IPO, with its selection bias', () => {
    /*
     * The prose used to be written once, for restricted stock, and applied to
     * whatever reached it. A pre-IPO leg described as "restricted-stock
     * studies" with the Rule 144 note attached is not a stylistic problem — it
     * is a statement about the evidence that is untrue, on the exhibit a
     * reviewer reads to check the discount.
     */
    const preIpo = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.455,
        dlom_method: 'pre_ipo',
        dlom_detail: {
          method: 'pre_ipo',
          statistic: 'median',
          dlom: 0.455,
          low: 0.352,
          high: 0.5,
          predates_modern_ipo_market: false,
          selection_bias:
            'The sample is companies that went on to complete an IPO, so part of the measured ' +
            'discount is the change in the company’s prospects over the period.',
          studies: [
            {
              study: 'Emory 1997-2000',
              period_start: 1997,
              period_end: 2000,
              discount: 0.5,
              statistic: 'mean',
            },
            {
              study: 'Willamette 1997',
              period_start: 1997,
              period_end: 1997,
              discount: 0.352,
              statistic: 'median',
            },
          ],
        },
      },
    };
    const text = plain(dlomDerivationExhibit(preIpo, CONTEXT)!.html);
    expect(text).toContain('Pre-IPO transaction studies');
    expect(text).toContain('pre-IPO studies');
    expect(text).toContain('went on to complete an IPO');
    expect(text).not.toContain('Rule 144');
  });

  it('says a qualitative discount is a judgement', () => {
    const qualitative = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.2,
        dlom_method: 'qualitative',
        dlom_detail: {
          method: 'qualitative',
          dlom: 0.2,
          basis: 'analyst judgement — no model or study was applied',
        },
      },
    };
    expect(plain(dlomDerivationExhibit(qualitative, CONTEXT)!.html)).toContain('judgement');
  });

  it('renders on the class volatilities alone when no model detail exists', () => {
    const { discounts: _d, ...noDetail } = MODEL;
    expect(dlomDerivationExhibit(noDetail, CONTEXT)).not.toBeNull();
  });

  it('is absent when the run produced neither', () => {
    // A calculation predating the engine change, or an aggregate allocation
    // with no cap table to decompose. The report reads as it did before.
    expect(dlomDerivationExhibit(RESULTS, CONTEXT)).toBeNull();
  });

  it('follows Exhibit H in the assembled deliverable', () => {
    const headings = buildExhibits(calculation({ results: MODEL } as Partial<CalculationRow>), CONTEXT).map(
      (s) => s.heading,
    );
    // Position relative to Exhibit H, not from the end of the list: the
    // appendices sort after every exhibit, so an appendix the fixture happens
    // to earn — IV, which any OPM run now carries — lands behind H-1.
    expect(headings.indexOf('Exhibit H-1 — Marketability Discount: Derivation')).toBe(
      headings.indexOf('Exhibit H — Discounts and Concluded Value') + 1,
    );
    expect(headings.findLast((h) => h.startsWith('Exhibit '))).toBe(
      'Exhibit H-1 — Marketability Discount: Derivation',
    );
  });

  it('escapes a class name rather than emitting it as markup', () => {
    const hostile = {
      ...MODEL,
      class_volatility: {
        ...MODEL.class_volatility,
        classes: { '<img src=x>': { kind: 'common', value: 1, delta: 1, elasticity: 1, volatility: 0.5 } },
      },
    };
    const html = dlomDerivationExhibit(hostile, CONTEXT)!.html;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});

// ── Exhibit H-1 — several methods, weighted ───────────────────────────────────

/**
 * The DLOM method-weighting table.
 *
 * A marketability discount is the one figure in a 409A with no single defensible
 * derivation: the option models price the cost of being unable to sell from the
 * subject's own volatility and holding period, and the restricted-stock studies
 * report what the market actually paid for restricted shares. The standard
 * appraisal answer is to weight them, which the engine could not do — so an
 * appraiser wanting a 50/50 computed it by hand and entered the result as
 * `qualitative`, recording their arithmetic as judgement and leaving the report
 * unable to say where the number came from.
 */
describe('a DLOM concluded by weighting several methods', () => {
  const WEIGHTED = {
    ...RESULTS,
    discounts: {
      dloc: 0.1,
      dlom: 0.1874,
      dlom_method: 'weighted',
      dlom_detail: {
        method: 'weighted',
        dlom: 0.187402,
        weight_total: 1,
        components: [
          {
            method: 'finnerty',
            weight: 0.5,
            dlom: 0.244803,
            weighted: 0.122402,
            detail: {
              method: 'finnerty',
              volatility: 0.62,
              time_to_liquidity_years: 4,
              dlom: 0.244803,
              formula: 'Finnerty average-strike put — 2N(v/2) - 1',
            },
          },
          {
            method: 'restricted_stock',
            weight: 0.5,
            dlom: 0.13,
            weighted: 0.065,
            detail: {
              method: 'restricted_stock',
              dlom: 0.13,
              statistic: 'median',
              studies: [
                {
                  study: 'Columbia Financial Advisors (post-amendment)',
                  period_start: 1997,
                  period_end: 1998,
                  discount: 0.13,
                },
              ],
            },
          },
        ],
      },
    },
  };

  const text = (results = WEIGHTED) => plain(dlomDerivationExhibit(results, CONTEXT)!.html);

  it('tabulates every method with its weight and its indicated discount', () => {
    const out = text();
    expect(out).toContain('Finnerty average-strike put model');
    expect(out).toContain('Restricted-stock studies');
    expect(out).toContain('50.00%'); // both weights
    expect(out).toContain('24.5%'); // Finnerty indicated
    expect(out).toContain('13.0%'); // studies indicated
  });

  it('states the weighted contribution rather than leaving it to be multiplied out', () => {
    // The concluded figure has to be visibly the sum of the column above it;
    // otherwise the table shows the ingredients of an answer without showing
    // that it is the answer.
    const out = text();
    expect(out).toContain('12.2%'); // 24.48% × 50%
    expect(out).toContain('6.5%'); // 13.0% × 50%
    expect(out).toContain('18.7%'); // and the concluded total
  });

  it('carries each leg’s own derivation under it', () => {
    // A weighted average is checked by reading the legs, so four percentages
    // with nothing behind them would move the unreviewable bare figure from
    // Exhibit H to Exhibit H-1 rather than removing it.
    const out = text();
    expect(out).toContain('62.0%'); // the volatility the Finnerty leg used
    expect(out).toContain('4.00 years');
    expect(out).toContain('Columbia Financial Advisors (post-amendment)');
    expect(out).toContain('1997–1998');
  });

  it('keeps a nil-weighted method in the table', () => {
    /*
     * An appraiser who computed Longstaff to show it as an upper bound and
     * weighted it to nothing is documenting the bound. Dropping the row would
     * hide a method that was considered — which is the opposite of what the
     * table is for.
     */
    const withNil = {
      ...WEIGHTED,
      discounts: {
        ...WEIGHTED.discounts,
        dlom_detail: {
          ...WEIGHTED.discounts.dlom_detail,
          components: [
            ...WEIGHTED.discounts.dlom_detail.components,
            {
              method: 'longstaff',
              weight: 0,
              dlom: 0.42,
              weighted: 0,
              detail: { method: 'longstaff', bound_multiple: 1.4498, is_upper_bound: true },
            },
          ],
        },
      },
    };
    const out = text(withNil);
    expect(out).toContain('Longstaff upper bound');
    expect(out).toContain('42.0%');
    expect(out).toContain('0.00%');
    // And it is still disclosed as a bound rather than an estimate.
    expect(out).toContain('upper bound');
  });

  it('says why the methods are weighted rather than ranked', () => {
    const out = text();
    expect(out).toContain('evidence of different kinds');
  });

  it('falls back to nothing rather than an empty table with no components', () => {
    const empty = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.2,
        dlom_method: 'weighted',
        dlom_detail: { method: 'weighted', dlom: 0.2, components: [] },
      },
    };
    // The exhibit still renders (the class volatilities are in RESULTS), but it
    // does not claim a weighting it has no rows for.
    const out = plain(dlomDerivationExhibit(empty, CONTEXT)!.html);
    expect(out).not.toContain('DLOM method');
  });

  it('escapes a method name from the calculation record', () => {
    const hostile = {
      ...RESULTS,
      discounts: {
        dloc: 0.1,
        dlom: 0.2,
        dlom_method: 'weighted',
        dlom_detail: {
          method: 'weighted',
          dlom: 0.2,
          components: [
            { method: '<img src=x>', weight: 0.5, dlom: 0.2, weighted: 0.1 },
            { method: 'finnerty', weight: 0.5, dlom: 0.2, weighted: 0.1 },
          ],
        },
      },
    };
    const html = dlomDerivationExhibit(hostile, CONTEXT)!.html;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
  });
});

// ── Exhibit H — value per class, marketable and non-marketable ───────────────

describe('the per-class value table in Exhibit H', () => {
  const html = () => plain(discountExhibit(RESULTS, CONTEXT)!.html);

  it('states each class marketable and the common class discounted', () => {
    const text = html();
    expect(text).toContain('Series A');
    expect(text).toContain('$5.0000'); // Series A, marketable
    expect(text).toContain('$1.8281'); // Common, marketable
    // 1.828148 × (1 − 0.10) × (1 − 0.25)
    expect(text).toContain('$1.2340');
  });

  it('does not carry the common discounts across the preferred classes', () => {
    // DLOC and DLOM were reasoned about a minority holder of common with no
    // market. Applying them to a series holding governance and registration
    // rights would assert a conclusion nobody reached.
    const text = html();
    expect(text).not.toContain('$3.3750'); // 5.0000 discounted, were it applied
    expect(text).toContain('is not in that position');
  });

  it('is absent when the allocation reports no classes', () => {
    const aggregate = { ...RESULTS, allocation: { method: 'as_converted', common_fraction: 0.8 } };
    const text = plain(discountExhibit(aggregate, CONTEXT)!.html);
    expect(text).not.toContain('Value per share — marketable');
    // The common chain above it still renders — that is the exhibit's job.
    expect(text).toContain('Concluded fair market value');
  });
});

/**
 * Appendix I — where the discount rate came from.
 *
 * Exhibit C states the rate and discounts the flows with it. A reviewer asked
 * to accept 28% cannot check a bare percentage; the build-up is the argument.
 */
describe('Appendix I — the WACC build-up', () => {
  const AUTO_WACC = {
    wacc: 0.2812,
    cost_of_equity: 0.2954,
    cost_of_debt: 0.085,
    after_tax_cost_of_debt: 0.0672,
    tax_rate: 0.21,
    target_debt_to_equity: 0.15,
    weights: { equity: 0.87, debt: 0.13 },
    capm: {
      risk_free_rate: 0.0421,
      beta_unlevered: 1.24,
      beta_relevered: 1.38,
      equity_risk_premium: 0.055,
      size_premium: 0.0389,
      size_tier: 'Decile 10b',
      company_specific_premium: 0.06,
    },
    comparables: [
      { ticker: 'ABCD', levered_beta: 1.42, debt_to_equity: 0.21, unlevered_beta: 1.22 },
      { ticker: 'EFGH', levered_beta: 1.31, debt_to_equity: 0.08, unlevered_beta: 1.25 },
    ],
  };

  const withWacc = (over: Record<string, unknown> = {}) => ({
    equity_value: 42_000_000,
    fmv_per_share: 1.2345,
    auto: { wacc: { ...AUTO_WACC, ...over } },
  });

  const html = (over?: Record<string, unknown>) => waccExhibit(withWacc(over), { currency: 'USD' })!.html;

  it('states every component of the cost of equity', () => {
    const out = html();
    expect(out).toContain('Risk-free rate');
    expect(out).toContain('4.21%');
    expect(out).toContain('Equity risk premium');
    expect(out).toContain('5.50%');
    expect(out).toContain('Size premium');
    expect(out).toContain('3.89%');
    expect(out).toContain('Company-specific risk premium');
  });

  it('names the size tier the premium was taken from', () => {
    // "3.89%" is a number; "Decile 10b" is what a reviewer checks it against.
    expect(html()).toContain('Decile 10b');
  });

  it('shows the relevering, both betas', () => {
    const out = html();
    expect(out).toContain('1.2400'); // unlevered
    expect(out).toContain('1.3800'); // relevered
  });

  it('lists the guideline set the beta was computed over', () => {
    // The one input that is neither published nor a judgement — it is a
    // calculation over a chosen set, and the set is what gets argued with.
    const out = html();
    expect(out).toContain('ABCD');
    expect(out).toContain('EFGH');
  });

  it('concludes on the rate Exhibit C actually applies', () => {
    expect(html()).toContain('28.12%');
    expect(html()).toContain('Exhibit C discounts the projected cash flows');
  });

  it('says so when the analyst overrode it', () => {
    // The build-up still belongs in the report — it is what the override was a
    // judgement against — but the appendix must not claim it drove the flows.
    expect(html({ used_manual_override: true })).toContain('superseded by the analyst');
  });

  it('renders nothing when the rate was typed rather than built', () => {
    // Inventing a decomposition that sums to the analyst's figure would be the
    // appendix asserting reasoning nobody did.
    expect(waccExhibit({ equity_value: 1, fmv_per_share: 1 }, { currency: 'USD' })).toBeNull();
  });

  it('survives a build-up missing a component', () => {
    const out = waccExhibit({ auto: { wacc: { wacc: 0.25, capm: {} } } }, { currency: 'USD' });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('25.00%');
  });

  it('is included in the assembled exhibit list', () => {
    const calc = {
      status: 'succeeded',
      inputs: { params: {}, inputs: {} },
      results: withWacc(),
    } as unknown as CalculationRow;
    const headings = buildExhibits(calc, CONTEXT).map((s) => s.heading);
    expect(headings).toContain('Appendix I — Discount Rate Build-Up (WACC)');
  });
});

/**
 * Appendix II — the reported statements the Financial Analysis chapter discusses.
 */
describe('Appendix II — historical financial statements', () => {
  /** A workbook with enough entered to produce both statements. */
  const cells = (over: Record<string, number> = {}) =>
    computeWorkbook([
      { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_minus_1', value: 4_000_000 },
      { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
      { sheet: 'income_statement', row_key: 'cogs', column_key: 'fy_current', value: 1_500_000 },
      { sheet: 'balance_sheet', row_key: 'cash', column_key: 'fy_current', value: 3_000_000 },
      ...Object.entries(over).map(([k, value]) => {
        const [sheet, row_key, column_key] = k.split('.');
        return { sheet, row_key, column_key, value };
      }),
    ]);

  it('prints both statements with their labels', () => {
    const out = financialsExhibit(cells(), CONTEXT)!;
    expect(out.heading).toBe('Appendix II — Historical Financial Statements');
    expect(out.html).toContain('Income statement');
    expect(out.html).toContain('Balance sheet');
    expect(out.html).toContain('$6,000,000');
  });

  it('omits the forecast periods — the appendix is of reported figures', () => {
    const out = financialsExhibit(cells({ 'income_statement.revenue.fy_plus_1': 99_000_000 }), CONTEXT)!;
    expect(out.html).toContain('FY (current)');
    expect(out.html).not.toContain('FY+1');
    // The forecast figure itself must not reach the page under any column.
    expect(out.html).not.toContain('99,000,000');
  });

  it('carries the derived rows the workbook computed, not re-derived ones', () => {
    // gross profit 6.0M - 1.5M = 4.5M; gross margin 75%; revenue growth 50%.
    const out = financialsExhibit(cells(), CONTEXT)!;
    expect(out.html).toContain('$4,500,000');
    expect(out.html).toContain('75.0%');
    expect(out.html).toContain('50.0%');
  });

  it('drops rows the company reports nothing on, and dashes a gap it does', () => {
    const out = financialsExhibit(cells(), CONTEXT)!;
    // Nothing was entered for inventory in any reported period.
    expect(out.html).not.toContain('Inventory');
    // Revenue is reported in FY-1 and FY (current) but not FY-2, so the row
    // stays and the missing period reads as absent rather than as nil.
    expect(out.html).toContain('Revenue');
    expect(out.html).toContain('—');
    expect(out.html).not.toContain('$0');
  });

  it('is null when nobody has entered any financials', () => {
    expect(financialsExhibit(computeWorkbook([]), CONTEXT)).toBeNull();
    expect(financialsExhibit(undefined, CONTEXT)).toBeNull();
  });

  it('is null when the only figures entered are forecast', () => {
    const forecastOnly = computeWorkbook([
      { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_plus_1', value: 9_000_000 },
    ]);
    expect(financialsExhibit(forecastOnly, CONTEXT)).toBeNull();
  });

  it('renders an unrecognised currency code rather than sinking the appendix', () => {
    const out = financialsExhibit(cells(), { ...CONTEXT, currency: 'ZZZ' })!;
    // Intl separates an unrecognised code from the figure with U+00A0, so this
    // matches on the two parts rather than pinning the byte between them.
    expect(out.html).toMatch(/ZZZ\s6,000,000/);
  });

  it('escapes a class of text it does not control — the sheet labels', () => {
    // The labels are ours today, but they reach a table cell through `esc` for
    // the same reason every other exhibit's cells do.
    const out = financialsExhibit(cells(), CONTEXT)!;
    expect(out.html).toContain('Cash &amp; equivalents');
    expect(out.html).not.toContain('Cash & equivalents');
  });

  it('is included in the assembled exhibit list', () => {
    const calc = {
      status: 'succeeded',
      inputs: { params: {}, inputs: {} },
      results: { equity_value: 1, fmv_per_share: 1 },
    } as unknown as CalculationRow;
    const headings = buildExhibits(calc, { ...CONTEXT, financials: cells() }).map((s) => s.heading);
    expect(headings).toContain('Appendix II — Historical Financial Statements');
  });

  it('renders only tags the report whitelist allows', () => {
    const out = financialsExhibit(cells(), CONTEXT)!;
    expect(sanitizeHtml(out.html)).toBe(out.html);
  });
});

/**
 * Appendix II-1 — the operating series, and gap #13 in the 409.ai comparison.
 *
 * The assertions worth having here are the ones that separate this appendix
 * from Appendix II, which reads the same workbook: that it prints the metrics
 * sheet and not the statements, that every ratio on it comes from
 * `computeWorkbook` rather than from arithmetic in the exhibit module, and that
 * the two guards it carries — the forecast columns and the undefined burn
 * multiple — hold.
 */
describe('Appendix II-1 — core operating metrics', () => {
  const HEADING = 'Appendix II-1 — Core Operating Metrics';

  /**
   * The cells of one labelled row, in printed order.
   *
   * Worth the helper rather than `toContain` on the whole table: half of what
   * this appendix promises is *which period* a figure belongs to, and a
   * substring match on the table cannot tell a dash in the right column from a
   * dash in the wrong one.
   */
  const rowCells = (html: string, label: string): string[] | null => {
    const m = new RegExp(`<tr><td>${label}</td>(.*?)</tr>`).exec(html);
    return m ? [...m[1]!.matchAll(/<td>(.*?)<\/td>/g)].map((c) => c[1]!) : null;
  };

  /** A workbook with two reported periods of the operating series. */
  const cells = (over: Record<string, number> = {}) =>
    computeWorkbook([
      { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_minus_1', value: 4_000_000 },
      { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_current', value: 6_000_000 },
      { sheet: 'operating_metrics', row_key: 'customers', column_key: 'fy_current', value: 120 },
      { sheet: 'operating_metrics', row_key: 'employees', column_key: 'fy_minus_1', value: 30 },
      { sheet: 'operating_metrics', row_key: 'employees', column_key: 'fy_current', value: 48 },
      { sheet: 'operating_metrics', row_key: 'net_burn', column_key: 'fy_current', value: 3_000_000 },
      ...Object.entries(over).map(([k, value]) => {
        const [sheet, row_key, column_key] = k.split('.');
        return { sheet, row_key, column_key, value };
      }),
    ]);

  it('prints the entered series under the catalogued heading', () => {
    const out = operatingMetricsExhibit(cells(), CONTEXT)!;
    expect(out.heading).toBe(HEADING);
    expect(out.html).toContain('Annual recurring revenue');
    expect(out.html).toContain('Customers');
    expect(out.html).toContain('Employees (FTE)');
    expect(out.html).toContain('Net cash burn');
    expect(out.html).toContain('$6,000,000');
  });

  it('carries the ratios the workbook computed, not ones re-derived here', () => {
    const out = operatingMetricsExhibit(cells(), CONTEXT)!.html;
    // net new ARR 6.0M - 4.0M = 2.0M; ARR growth 50%; ARR/customer 6.0M/120 =
    // $50,000; ARR/employee 6.0M/48 = $125,000; burn multiple 3.0M/2.0M = 1.5;
    // headcount growth (48-30)/30 = 60%.
    expect(out).toContain('$2,000,000');
    expect(out).toContain('50.0%');
    expect(out).toContain('$50,000');
    expect(out).toContain('$125,000');
    expect(out).toContain('1.5');
    expect(out).toContain('60.0%');
  });

  it('is not the statements appendix — it prints neither statement', () => {
    // The whole reason gap #13 was left open was the suspicion that this page
    // would restate Appendix II. It reads the same workbook and must not.
    const both = computeWorkbook([
      { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
      { sheet: 'balance_sheet', row_key: 'cash', column_key: 'fy_current', value: 3_000_000 },
      { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_current', value: 5_400_000 },
    ]);
    const out = operatingMetricsExhibit(both, CONTEXT)!.html;
    expect(out).toContain('$5,400,000');
    expect(out).not.toContain('Cash &amp; equivalents');
    expect(out).not.toContain('Gross profit');
    // And the GAAP revenue figure must not reach this page under any label.
    expect(out).not.toContain('$6,000,000');
  });

  it('omits the forecast periods — this is a record, not a plan', () => {
    const out = operatingMetricsExhibit(cells({ 'operating_metrics.arr.fy_plus_1': 99_000_000 }), CONTEXT)!;
    expect(out.html).toContain('FY (current)');
    expect(out.html).not.toContain('FY+1');
    expect(out.html).not.toContain('99,000,000');
  });

  it('withholds the burn multiple in a period where recurring revenue did not grow', () => {
    /*
     * ARR 2M → 4M → 4M, with burn in both of the later periods. FY-1 grew, so
     * the multiple is 1.0M / 2.0M = 0.5; FY (current) was flat, so burn per
     * dollar of net new ARR is undefined and the cell is a dash rather than a
     * figure the page invented. The row survives because FY-1 filled it, which
     * is what makes the dash legible as "not this period" rather than as the
     * whole measure being absent.
     */
    const out = operatingMetricsExhibit(
      computeWorkbook([
        { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_minus_2', value: 2_000_000 },
        { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_minus_1', value: 4_000_000 },
        { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_current', value: 4_000_000 },
        { sheet: 'operating_metrics', row_key: 'net_burn', column_key: 'fy_minus_1', value: 1_000_000 },
        { sheet: 'operating_metrics', row_key: 'net_burn', column_key: 'fy_current', value: 3_000_000 },
      ]),
      CONTEXT,
    )!.html;
    expect(rowCells(out, 'Burn multiple')).toEqual(['—', '0.5', '—']);
  });

  it('states a contraction rather than hiding it behind a negative multiple', () => {
    const out = operatingMetricsExhibit(
      cells({ 'operating_metrics.arr.fy_current': 3_000_000 }),
      CONTEXT,
    )!.html;
    // Net new ARR is -1.0M and says so; the burn multiple it would imply
    // (3.0M / -1.0M = -3) is withheld, because a negative burn multiple reads
    // as the efficient end of a scale this company is at the wrong end of.
    expect(rowCells(out, 'Net new ARR')?.at(-1)).toMatch(/1,000,000/);
    expect(rowCells(out, 'Net new ARR')?.at(-1)).toMatch(/^[-−(]/);
    expect(rowCells(out, 'Burn multiple')).toBeNull();
  });

  it('drops a series the company does not track, and dashes a gap in one it does', () => {
    const out = operatingMetricsExhibit(
      computeWorkbook([
        { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_current', value: 6_000_000 },
      ]),
      CONTEXT,
    )!.html;
    expect(out).not.toContain('Customers');
    expect(out).not.toContain('Employees (FTE)');
    expect(out).toContain('Annual recurring revenue');
    expect(out).toContain('—');
    expect(out).not.toContain('$0');
  });

  it('is null when nothing operating has been entered', () => {
    expect(operatingMetricsExhibit(computeWorkbook([]), CONTEXT)).toBeNull();
    expect(operatingMetricsExhibit(undefined, CONTEXT)).toBeNull();
    // A workbook with statements but no operating series: Appendix II prints,
    // this one does not.
    const statementsOnly = computeWorkbook([
      { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
    ]);
    expect(financialsExhibit(statementsOnly, CONTEXT)).not.toBeNull();
    expect(operatingMetricsExhibit(statementsOnly, CONTEXT)).toBeNull();
  });

  it('is null when the only figures entered are forecast', () => {
    const forecastOnly = computeWorkbook([
      { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_plus_2', value: 9_000_000 },
    ]);
    expect(operatingMetricsExhibit(forecastOnly, CONTEXT)).toBeNull();
  });

  it('survives a workbook that is not the shape it expects', () => {
    for (const bad of [
      'not a workbook',
      [{ key: 'operating_metrics' }],
      [{ key: 'operating_metrics', columns: 'no', rows: [] }],
      [{ key: 'operating_metrics', columns: [], rows: 'no' }],
      [{ key: 'operating_metrics', columns: [{ key: 'fy_current' }], rows: [{ label: 'x' }] }],
    ]) {
      expect(() =>
        operatingMetricsExhibit(bad as unknown as ReturnType<typeof computeWorkbook>, CONTEXT),
      ).not.toThrow();
    }
  });

  it('renders an unrecognised currency code rather than sinking the appendix', () => {
    const out = operatingMetricsExhibit(cells(), { ...CONTEXT, currency: 'ZZZ' })!;
    expect(out.html).toMatch(/ZZZ\s6,000,000/);
  });

  it('follows Appendix II in the assembled deliverable', () => {
    const calc = {
      status: 'succeeded',
      inputs: { params: {}, inputs: {} },
      results: { equity_value: 1, fmv_per_share: 1 },
    } as unknown as CalculationRow;
    const financials = computeWorkbook([
      { sheet: 'income_statement', row_key: 'revenue', column_key: 'fy_current', value: 6_000_000 },
      { sheet: 'operating_metrics', row_key: 'arr', column_key: 'fy_current', value: 5_400_000 },
    ]);
    const headings = buildExhibits(calc, { ...CONTEXT, financials }).map((s) => s.heading);
    expect(headings).toContain(HEADING);
    expect(headings.indexOf(HEADING)).toBe(
      headings.indexOf('Appendix II — Historical Financial Statements') + 1,
    );
  });

  it('renders only tags the report whitelist allows', () => {
    const out = operatingMetricsExhibit(cells(), CONTEXT)!;
    expect(sanitizeHtml(out.html)).toBe(out.html);
  });
});

/**
 * Appendix III's own behaviour is pinned in `requiredReturns.test.ts`, next to
 * the ladder it prints. What belongs here is only its place in the assembled
 * deliverable: that the stage reaches it through `buildExhibits`, and that the
 * appendix sorts after Appendix II rather than ahead of the exhibits.
 */
describe('Appendix III in the assembled exhibit list', () => {
  const APPENDIX_III = 'Appendix III — Required Rates of Return by Stage of Development';
  const calc = {
    status: 'succeeded',
    inputs: { params: {}, inputs: {} },
    results: { equity_value: 1, fmv_per_share: 1 },
  } as unknown as CalculationRow;
  const headings = (ctx: Partial<ExhibitContext>) =>
    buildExhibits(calc, { ...CONTEXT, ...ctx }).map((s) => s.heading);

  it('is included once a stage has been concluded', () => {
    expect(headings({ developmentStage: 3 })).toContain(APPENDIX_III);
  });

  it('is left out when nobody has concluded a stage', () => {
    expect(headings({ developmentStage: null })).not.toContain(APPENDIX_III);
    expect(headings({})).not.toContain(APPENDIX_III);
  });

  it('carries a firm’s own ladder through from the params', () => {
    const out = buildExhibits(calc, {
      ...CONTEXT,
      developmentStage: 1,
      requiredReturnTable: [{ stage: 1, category: 'Our angel band', low: 0.55, high: 0.85 }],
    }).find((s) => s.heading === APPENDIX_III)!;
    expect(out.html).toContain('Our angel band');
    expect(out.html).not.toContain('Seed / start-up');
  });

  it('comes last — the appendices follow the exhibits, in their stated order', () => {
    // Of the appendices this engagement receives: the fixture has no
    // allocation, so it has no Appendix IV behind it.
    const all = headings({ developmentStage: 3 });
    expect(all[all.length - 1]).toBe(APPENDIX_III);
  });
});

// ── Appendix IV ──────────────────────────────────────────────────────────────

/**
 * Appendix IV — the arithmetic between Exhibit F's disclosed inputs and its
 * undisclosed value column.
 *
 * Exhibit F states the breakpoints, the volatility, the horizon and the rate,
 * and then prints a column of tranche values. Everything a reviewer needs to
 * *check* that column was in the calculation and none of it was on the page.
 *
 * The claim the appendix makes is a strong one and it is worth testing as such:
 * Exhibit F's value column *is* the column of Black-Scholes call spreads struck
 * at consecutive breakpoints. `RESULTS` is a fixture where that is true — the
 * schedule came out of the engine's own `bs_call_terms` and the breakpoint
 * values are its spreads — so the reconciliation test below is checking the
 * appendix against the engine rather than against itself.
 */
describe('Appendix IV — the option pricing behind the allocation', () => {
  const html = (results: Record<string, unknown> = RESULTS) => opmCalculationsExhibit(results, CONTEXT)!.html;
  const seen = (results?: Record<string, unknown>) => plain(html(results));

  /** `RESULTS` with the allocation replaced wholesale. */
  const withAllocation = (allocation: unknown) => ({ ...RESULTS, allocation });

  it('is titled as the catalogue titles it', () => {
    expect(opmCalculationsExhibit(RESULTS, CONTEXT)!.heading).toBe(
      'Appendix IV — Option Pricing Model Calculations',
    );
  });

  it('states the four inputs every call in the schedule was priced from', () => {
    // Without these the table below is six columns of numbers a reader cannot
    // reproduce — which is the state Exhibit F was already in.
    const text = seen();
    expect(text).toContain('$42,000,000'); // S, the equity value allocated
    expect(text).toContain('65.0%'); // sigma
    expect(text).toContain('3.50 years'); // T
    expect(text).toContain('4.20%'); // r
  });

  it('carries the working at the precision a hand-check needs', () => {
    const text = seen();
    // d1/d2 to four places, the probabilities to six — the engine records six
    // on both and the appendix prints each at the precision it is read at.
    expect(text).toContain('1.9090'); // d1 at K = 10M
    expect(text).toContain('0.6930'); // d2 at K = 10M
    expect(text).toContain('0.971871'); // N(d1)
    expect(text).toContain('0.755844'); // N(d2)
    // A negative d2 is ordinary — the tranche is out of the money — and must
    // print as a negative number rather than as a blank or an absolute value.
    expect(text).toContain('-0.4470');
  });

  it('prices each strike once, not once per tranche endpoint', () => {
    // Consecutive tranches share a boundary, so a row-per-tranche layout would
    // print every interior call twice and invite the reader to check whether
    // the two copies agree — a question about the typesetting rather than
    // about the valuation.
    const text = seen();
    expect(text.match(/1\.9090/g)).toHaveLength(1);
    expect(text.match(/0\.7690/g)).toHaveLength(1);
  });

  it('reconciles every tranche to a call spread, and to Exhibit F’s own column', () => {
    // The assertion the appendix exists for. Each figure is C(from) − C(to) as
    // computed from the schedule, and each is also printed by Exhibit F as the
    // value of that tranche — so the two schedules in the deliverable state the
    // same three numbers, and a reader can verify the second from the first.
    const appendix = seen();
    const exhibitF = plain(allocationExhibit(RESULTS, CONTEXT)!.html);
    for (const tranche of ['$7,706,566', '$12,879,706', '$21,413,728']) {
      expect(appendix, `Appendix IV is missing the tranche ${tranche}`).toContain(tranche);
      expect(exhibitF, `Exhibit F is missing the tranche ${tranche}`).toContain(tranche);
    }
  });

  it('closes the open-ended tranche at zero rather than at a missing strike', () => {
    // The last tranche runs to infinity, where the call is worth nothing. Read
    // as "no strike priced there" it would be dropped, and the appendix would
    // silently account for less than the equity value.
    const text = seen();
    expect(text).toContain('and above');
    expect(text).toContain('$0');
  });

  it('leaves d₁ and d₂ blank at the zero strike rather than fabricating them', () => {
    // A call struck at zero is the underlying; d1 and d2 genuinely do not exist
    // there, and a 0.0000 in a column a reviewer recomputes is worse than a
    // blank. The probabilities are printed, because 1 is their limit and not a
    // convention.
    const text = seen();
    expect(text).toContain('1.000000');
    expect(text).toContain('—');
    // The first call is the whole equity value, which is why the tranche values
    // below it sum to the amount allocated.
    expect(text).toContain('$42,000,000');
  });

  it('drops a tranche whose endpoints were never priced, and keeps the rest', () => {
    // A breakpoint outside the schedule cannot be reconciled. Printing the row
    // with a blank spread would assert a tranche value of nothing; omitting it
    // says only what the schedule supports.
    const allocation = RESULTS.allocation;
    const text = seen(
      withAllocation({
        ...allocation,
        breakpoints: [
          ...allocation.breakpoints,
          { from: 55_000_000, to: 70_000_000, participants: { Common: 1 }, value: 1_000_000 },
        ],
      }),
    );
    expect(text).toContain('$7,706,566'); // the priced tranches survive
    expect(text).not.toContain('$55,000,000');
  });

  it('prints the schedule even where there are no breakpoints to reconcile', () => {
    // The per-strike table is the appendix's substance; the reconciliation is
    // the convenience. A results document with a schedule and no readable
    // breakpoints still supports the first.
    const text = seen(withAllocation({ ...RESULTS.allocation, breakpoints: 'not a list' }));
    expect(text).toContain('0.971871');
    expect(text).not.toContain('Tranche value');
  });

  it('is absent where there is no option pricing to show', () => {
    // A current-value or PWERM allocation has no call spreads, and a
    // calculation stored before the engine recorded them has nothing to
    // transcribe. In both cases the honest appendix is no appendix.
    expect(opmCalculationsExhibit({}, CONTEXT)).toBeNull();
    expect(opmCalculationsExhibit({ equity_value: 1 }, CONTEXT)).toBeNull();
    for (const allocation of [
      null,
      { method: 'current_value' },
      { method: 'opm_waterfall', breakpoints: RESULTS.allocation.breakpoints },
      { method: 'opm_waterfall', option_schedule: [] },
      { method: 'opm_waterfall', option_schedule: 'not a list' },
      { method: 'opm_waterfall', option_schedule: [null, 'nonsense'] },
    ]) {
      expect(opmCalculationsExhibit(withAllocation(allocation), CONTEXT)).toBeNull();
    }
  });

  it('says nothing it cannot support when the four inputs are missing', () => {
    // The schedule is what makes the appendix; the input table is drawn from
    // `assumptions`, which an older results document may not carry.
    const out = opmCalculationsExhibit({ allocation: RESULTS.allocation }, CONTEXT)!;
    expect(out.html).toContain('0.971871');
    for (const leak of ['NaN', 'undefined', '$null', 'Infinity']) {
      expect(out.html, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it('emits only markup the report renderer understands', () => {
    // Not covered by the whole-deliverable sweep for free: this page is the one
    // that prints subscripts and an <em>-set formula.
    const out = html();
    for (const tag of out.matchAll(/<\/?([a-z]+)/g)) {
      expect(ALLOWED_TAGS.has(tag[1]!), `<${tag[1]}>`).toBe(true);
    }
    expect(sanitizeHtml(out)).toBe(out);
  });

  it('comes last in the assembled deliverable', () => {
    // The most granular support on the file, and the only reader who wants it
    // has already read Exhibit F and wants to check it.
    const headings = buildExhibits(calculation(), CONTEXT).map((s) => s.heading);
    expect(headings[headings.length - 1]).toBe('Appendix IV — Option Pricing Model Calculations');
  });

  it('is left out of the deliverable when the allocation was not an OPM', () => {
    const results = withAllocation({ method: 'current_value', classes: {} });
    const headings = buildExhibits(calculation({ results } as Partial<CalculationRow>), CONTEXT).map(
      (s) => s.heading,
    );
    expect(headings).not.toContain('Appendix IV — Option Pricing Model Calculations');
  });
});

// ── degradation ──────────────────────────────────────────────────────────────

/**
 * The rule every exhibit in this module states and none of the tests above
 * check: "an absent, partial or unfamiliar shape drops the exhibit rather than
 * throwing inside a render".
 *
 * It matters more than the phrasing suggests. These schedules are the
 * client-facing half of a 409A report, assembled at render time from whatever
 * the engine last wrote. An engine change, a hand-edited result or a partially
 * failed run reaches them as the right keys carrying the wrong types — and the
 * two ways that can go wrong are both invisible to a happy-path test. A throw
 * kills the render of an otherwise finished report. A leak prints `NaN` or
 * `undefined` into a table a board reads as a statement about what the company
 * is worth.
 *
 * So: walk every leaf of a known-good payload, corrupt one at a time, and
 * require that the whole assembly survives and says nothing it cannot support.
 */
describe('exhibit degradation under partial and hostile results', () => {
  /** Anything that would present absence as a figure. */
  const LEAKS = ['undefined', 'NaN', '[object Object]', '>null<', '$null', 'Infinity'];

  function leaksIn(sections: ReturnType<typeof buildExhibits>): string[] {
    const found = new Set<string>();
    for (const s of sections) {
      for (const bad of LEAKS) {
        if (s.html.includes(bad) || s.heading.includes(bad)) found.add(`${s.heading} :: ${bad}`);
      }
    }
    return [...found];
  }

  /** Dotted paths to every leaf of a payload, `a.b[0].c` style. */
  function leafPaths(value: unknown, prefix = ''): string[] {
    if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, `${prefix}[${i}]`));
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
    }
    return [prefix];
  }

  /** A deep copy of `root` with the value at `path` replaced. */
  function withPath<T>(root: T, path: string, replacement: unknown): T {
    const copy = structuredClone(root) as Record<string, unknown>;
    const steps = path.split(/\.|(?=\[)/).filter(Boolean);
    let node: Record<string, unknown> = copy;
    for (let i = 0; i < steps.length - 1; i += 1) {
      const key = steps[i]!.replace(/^\[|\]$/g, '');
      node = node[key] as Record<string, unknown>;
    }
    node[steps[steps.length - 1]!.replace(/^\[|\]$/g, '')] = replacement;
    return copy as T;
  }

  /** The shapes a wrong type actually arrives as. */
  const HOSTILE: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not a number'],
    ['an empty string', ''],
    ['an object', { unexpected: true }],
    ['an array', [1, 2]],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];

  const RESULT_PATHS = leafPaths(RESULTS);
  const INPUT_PATHS = leafPaths(INPUTS);

  it('has a payload broad enough for this to mean something', () => {
    // A guard on the guard: if a refactor shrinks the fixtures, the sweep below
    // would quietly stop covering anything and still pass.
    expect(RESULT_PATHS.length).toBeGreaterThan(40);
    expect(INPUT_PATHS.length).toBeGreaterThan(20);
  });

  it('survives every single-leaf corruption of the engine results', () => {
    const failures: string[] = [];
    for (const path of RESULT_PATHS) {
      for (const [name, replacement] of HOSTILE) {
        const results = withPath(RESULTS, path, replacement);
        let sections: ReturnType<typeof buildExhibits>;
        try {
          sections = buildExhibits(calculation({ results }), CONTEXT);
        } catch (err) {
          failures.push(`threw on results.${path} = ${name}: ${(err as Error).message}`);
          continue;
        }
        for (const leak of leaksIn(sections)) failures.push(`results.${path} = ${name} → ${leak}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('survives every single-leaf corruption of the engine inputs', () => {
    const failures: string[] = [];
    for (const path of INPUT_PATHS) {
      for (const [name, replacement] of HOSTILE) {
        const inputs = { params: {}, inputs: withPath(INPUTS, path, replacement) };
        let sections: ReturnType<typeof buildExhibits>;
        try {
          sections = buildExhibits(calculation({ inputs }), CONTEXT);
        } catch (err) {
          failures.push(`threw on inputs.${path} = ${name}: ${(err as Error).message}`);
          continue;
        }
        for (const leak of leaksIn(sections)) failures.push(`inputs.${path} = ${name} → ${leak}`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * Whole branches of the payload going missing, which is what a partially
   * failed run looks like — the engine writes the approaches it finished and
   * nothing for the ones it did not reach.
   */
  it('drops the schedules a truncated result cannot support, and keeps the rest', () => {
    for (const key of Object.keys(RESULTS)) {
      const results = { ...RESULTS } as Record<string, unknown>;
      delete results[key];
      const sections = buildExhibits(calculation({ results }), CONTEXT);
      expect(leaksIn(sections)).toEqual([]);
    }

    // The floor: a run that concluded a value and recorded nothing else still
    // produces a report, just a short one.
    const bare = buildExhibits(
      calculation({ results: { equity_value: 1, fmv_per_share: 1 }, inputs: { params: {}, inputs: {} } }),
      CONTEXT,
    );
    expect(leaksIn(bare)).toEqual([]);
    expect(bare.every((s) => s.html.length > 0)).toBe(true);
  });

  /** The context is assembled by the caller and is as corruptible as the results. */
  it('survives a context whose optional halves are the wrong shape', () => {
    const hostile: Array<Partial<ExhibitContext>> = [
      { peers: 'not a list' as unknown as ExhibitContext['peers'] },
      { peers: [null, 7, {}] as unknown as ExhibitContext['peers'] },
      { financials: 'nope' as unknown as ExhibitContext['financials'] },
      { financials: [{}] as unknown as ExhibitContext['financials'] },
      { volatility: {} as unknown as ExhibitContext['volatility'] },
      { projection: {} as unknown as ExhibitContext['projection'] },
      { requiredReturnTable: 'a table', developmentStage: 3 },
      { requiredReturnTable: [{}, null], developmentStage: 3 },
      { developmentStage: Number.NaN },
      { currency: 'NOT-A-CODE' },
      { valuationDate: null, companyName: '' },
    ];
    for (const over of hostile) {
      const sections = buildExhibits(calculation(), { ...CONTEXT, ...over });
      expect(leaksIn(sections)).toEqual([]);
    }
  });

  /**
   * Company and class names come from the engagement, so every cell that
   * prints one has to survive a name that looks like markup. `Series A & B
   * <old>` is a real class name shape, not a contrived one.
   */
  it('escapes engagement-supplied names wherever they reach a cell', () => {
    const nasty = 'Series A & B <old>';
    const results = structuredClone(RESULTS) as Record<string, unknown>;
    const allocation = results.allocation as Record<string, unknown>;
    allocation.classes = { [nasty]: { kind: 'preferred', shares: 1, value: 1, per_share: 1 } };
    allocation.breakpoints = [{ from: 0, to: 1, participants: { [nasty]: 1 }, value: 1 }];
    const inputs = structuredClone(INPUTS) as Record<string, unknown>;
    (inputs.share_classes as Array<Record<string, unknown>>)[0]!.name = nasty;

    const sections = buildExhibits(calculation({ results, inputs: { params: {}, inputs } }), {
      ...CONTEXT,
      companyName: nasty,
    });
    const html = sections.map((s) => s.html).join('');
    expect(html).toContain('Series A &amp; B &lt;old&gt;');
    expect(html).not.toContain('<old>');
  });
});

/**
 * The new schedules, through the renderer that actually produces the client's
 * file rather than only through `plain()`.
 *
 * An exhibit can be correct as HTML and still not reach the reader: the PDF
 * renderer takes a small tag subset and drops what it does not know, so a
 * schedule assembled from markup it silently strips is a heading followed by
 * white space in the delivered document and passes every string assertion made
 * against the fragment. This renders the document and reads the text back out
 * of it, which is the only assertion that covers that gap.
 */
describe('the new schedules survive the PDF renderer', () => {
  const pdfInput = (sections: Array<{ heading: string; html: string }>) => ({
    title: '409A Valuation Report',
    company_name: CONTEXT.companyName,
    meta: [{ label: 'Valuation date', value: CONTEXT.valuationDate }],
    sections,
    generated_at: new Date('2026-07-01T00:00:00.000Z'),
  });

  it('prints Exhibit B-1 and its level-of-value finding into the document text', async () => {
    const sections = buildExhibits(
      calculation({ results: LEVELLED_RESULTS } as Partial<CalculationRow>),
      CONTEXT,
    );
    expect(sections.map((s) => s.heading)).toContain('Exhibit B-1 — Level of Value');

    const pdf = await renderReportPdf(pdfInput(sections), { compress: false });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = pdfText(pdf);

    expect(text).toContain('Exhibit B-1');
    expect(text).toContain('Level of Value');
    // The classification, the split, and the finding — the three things the
    // schedule exists to say, each read back out of the rendered file.
    expect(text).toContain('Minority, marketable');
    expect(text).toContain('Control, marketable');
    expect(text).toContain('75% minority, 25% control');
    expect(text).toContain('discounts a second time');
  }, 60_000);

  it('prints the aggregate common line of Exhibit H-1 into the document text', async () => {
    const results = {
      ...LEVELLED_RESULTS,
      discounts: {
        ...LEVELLED_RESULTS.discounts,
        dlom_detail: {
          method: 'finnerty',
          dlom: 0.25,
          volatility: 0.7422,
          volatility_basis: 'class',
          time_to_liquidity_years: 4,
        },
      },
      class_volatility: {
        enterprise_volatility: 0.62,
        common_volatility: 0.7422,
        delta_total: 1,
        classes: {
          Common: { kind: 'common', value: 12_000_000, delta: 0.34, elasticity: 1.19, volatility: 0.7378 },
          'Founders Common': {
            kind: 'common',
            value: 7_900_045,
            delta: 0.215,
            elasticity: 1.2064,
            volatility: 0.7482,
          },
        },
      },
    };
    const sections = buildExhibits(calculation({ results } as Partial<CalculationRow>), CONTEXT);
    const pdf = await renderReportPdf(pdfInput(sections), { compress: false });
    const text = pdfText(pdf);

    expect(text).toContain('Exhibit H-1');
    // The line that was missing: on a two-common cap table neither class row is
    // the interest the discount was struck on, so without it 74.2% appears
    // nowhere on the page that states 74.2% as the input.
    expect(text).toContain('Common — aggregate (applied)');
    expect(text).toContain('the aggregate common line of the schedule below');
    expect(text).toContain('0.5550');
  }, 60_000);

  it('prints Appendix IV’s option schedule and its reconciliation into the document text', async () => {
    const sections = buildExhibits(calculation(), CONTEXT);
    expect(sections.map((s) => s.heading)).toContain('Appendix IV — Option Pricing Model Calculations');

    const pdf = await renderReportPdf(pdfInput(sections), { compress: false });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = pdfText(pdf);

    expect(text).toContain('Appendix IV');
    expect(text).toContain('Option Pricing Model Calculations');
    // The working, read back out of the rendered file rather than out of the
    // HTML: this is the page a reviewer recomputes, so what matters is that the
    // digits survive into the artefact the client is actually sent.
    expect(text).toContain('1.9090');
    expect(text).toContain('0.971871');
    expect(text).toContain('-0.4470');
    // And the reconciliation — the same three tranche values Exhibit F prints.
    for (const tranche of ['$7,706,566', '$12,879,706', '$21,413,728']) {
      expect(text).toContain(tranche);
    }
    // The subscripts in the column heads and in the formula are the one place
    // the page depends on the PDF font carrying something beyond ASCII. If they
    // dropped, the header row would read "d" twice and "N(d)" twice.
    expect(text).toContain('d₁');
    expect(text).toContain('N(d₂)');
    expect(text).toContain('e^(−rT)');
  }, 60_000);
});
