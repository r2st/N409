import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildExhibits, type ExhibitContext } from '../../src/domain/reportExhibits.js';
import { buildReportSummary } from '../../src/domain/reportSummary.js';
import { fillFigures, reportFigures } from '../../src/domain/reportFigures.js';
import { instantiateTemplate, templateForKind, visibleSections } from '../../src/domain/report.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

/**
 * One calculation, one document, one spelling of every number in it.
 *
 * The 409A deliverable states the same handful of concluded figures over and
 * over: the summary page a board reads, the prose chapters an auditor reads,
 * and the schedules a reviewing appraiser checks the prose against. Each of
 * those three is built by a different module — `reportSummary`, `reportFigures`
 * and `reportExhibits` — and each formats what it prints for itself. Nothing
 * compared them, and they drifted, silently and only on the figures whose
 * digits ran past the default rounding:
 *
 *     summary page   Discount for lack of control        12.3%
 *     Exhibit B-1    "…the discount for lack of control of 12.3% in Exhibit H…"
 *     Exhibit H      Less: discount for lack of control — 12.34%   ($0.2256)
 *     Exhibit H      Discount for lack of control        12.3%      ← same page
 *     §16 (prose)    "…less a discount for lack of control of 12.34%…"
 *
 * Every one of those is the same field of the same calculation. Two of them
 * reconcile to the concluded value and three do not, in a signed opinion whose
 * subject is that value, and the reader has no way to tell which rate was
 * applied.
 *
 * So this test renders the whole document from one run and asserts the two
 * properties that were violated:
 *
 *   * **one spelling.** A concluded figure appears in its canonical rendering,
 *     and *no other rounding of it appears anywhere in the document*. The near
 *     misses are generated rather than listed, so a surface that invents a
 *     third precision fails here without anybody having predicted it.
 *
 *   * **the columns add.** Where a schedule states components and their total,
 *     the printed components add to the printed total — which a rounded column
 *     does not, and which is the entire claim those schedules make.
 *
 * The fixture's figures are deliberately awkward. A DLOM of 25% is formatted
 * identically by every formatter in the codebase and proves nothing; 27.66% is
 * what separates them.
 */

const CTX: ExhibitContext = {
  currency: 'USD',
  companyName: 'Northwind Robotics, Inc.',
  valuationDate: '2026-06-30',
};

/**
 * Concluded figures with digits past every default rounding, and *derived from
 * each other exactly as the engine derives them* — six decimal places on a rate,
 * four on a per-share figure. A fixture whose numbers only look plausible would
 * pass the "does the schedule close" assertions below by accident or fail them
 * for its own reasons; these close because the engine's arithmetic closes.
 */
const round6 = (n: number) => Number(n.toFixed(6));

const DLOC = 0.1234;
const DLOM = 0.2766;
const VOLATILITY = 0.6237;
const RISK_FREE = 0.0421;
const MARKETABLE = 2.151356;
/** `compute` rounds the concluded per-share figure to four places. */
const FMV = Number((MARKETABLE * (1 - DLOC) * (1 - DLOM)).toFixed(4));
const EQUITY = 42_664_610;
const MARKET_METRIC = 4_000_000;
const MARKET_MULTIPLE = 6.415;

/** The control-premium chain, inverted from the discount as `dloc.py` does it. */
const SYNERGY_SHARE = 0.4;
const CP_APPLIED = round6(DLOC / (1 - DLOC));
const CP_OBSERVED = round6(CP_APPLIED / (1 - SYNERGY_SHARE));

const RESULTS = {
  equity_value: EQUITY,
  fmv_per_share: FMV,
  common_equity_value: 19_900_045,
  fully_diluted_common: 9_250_000,
  allocation_method: 'opm',
  approaches: {
    income: {
      weight: 0.25,
      discount_rate: 0.2812,
      forecast_years: 3,
      terminal_method: 'gordon',
      terminal_detail: { terminal_growth: 0.0325 },
      pv_explicit: 3_100_000,
      pv_terminal: 30_900_000,
      enterprise_value: 34_000_000,
      equity_value: 36_000_000,
    },
    market: {
      weight: 0.25,
      // A three-decimal median, which is what an even-sized guideline set
      // produces: the exhibit's bridge multiplies the metric by it and states
      // "Metric × multiple" as the basis.
      metric: MARKET_METRIC,
      multiples: [5.12, 6.415, 7.1],
      selected_multiple: MARKET_MULTIPLE,
      horizon: 'ltm',
      basis: 'revenue',
      enterprise_value: MARKET_METRIC * MARKET_MULTIPLE,
      equity_value: 28_000_000,
    },
    opm_backsolve: { weight: 0.5, method: 'backsolve_waterfall', equity_value: 52_000_000 },
  },
  allocation: {
    method: 'opm_waterfall',
    common_per_share: MARKETABLE,
    classes: {
      Common: { kind: 'common', shares: 8_000_000, value: 17_210_848, per_share: MARKETABLE },
    },
  },
  assumptions: {
    time_to_exit_years: 3.5,
    risk_free_rate: RISK_FREE,
    volatility: VOLATILITY,
    dlom_volatility: 0.7422,
    dlom_volatility_basis: 'class',
  },
  discounts: {
    dloc: DLOC,
    dlom: DLOM,
    dlom_method: 'weighted',
    dloc_method: 'control_premium',
    dlom_detail: {
      method: 'weighted',
      dlom: DLOM,
      // Weighted legs as the engine records them: each `round(dlom × weight, 6)`,
      // and the concluded discount is their sum. So the column adds — provided
      // the exhibit prints enough digits for it to.
      components: [
        { method: 'chaffee', weight: 1 / 3, dlom: 0.2812, weighted: 0.093733 },
        { method: 'finnerty', weight: 1 / 3, dlom: 0.3341, weighted: 0.111367 },
        { method: 'restricted_stock', weight: 1 / 3, dlom: 0.2145, weighted: 0.0715 },
      ],
    },
    dloc_detail: {
      method: 'control_premium',
      dloc: DLOC,
      minority_basis_weight: 0.428571,
      control_basis_weight: 0.571429,
      // The observed premium, less the share attributed to synergies, inverted
      // into the discount — the three rows Exhibit H prints and invites the
      // reader to redo.
      observed_control_premium: CP_OBSERVED,
      synergy_share: SYNERGY_SHARE,
      control_premium_applied: CP_APPLIED,
      implied_control_premium: CP_APPLIED,
      approach_levels: { opm_backsolve: 'minority', income: 'control', market: 'minority' },
      double_counts_minority: false,
    },
  },
};

const CALCULATION = {
  id: '01J000000000000000000000',
  valuation_id: '01J000000000000000000001',
  engine_version: '1.4.0',
  status: 'succeeded',
  inputs: { params: {}, inputs: { income: { free_cash_flows: [1_000_000, 1_500_000, 2_200_000] } } },
  results: RESULTS,
  equity_value: String(EQUITY),
  fmv_per_share: String(FMV),
  error: null,
  diagnostics: [],
  created_by: null,
  created_at: new Date('2026-07-01T00:00:00Z'),
} as unknown as CalculationRow;

/** Tags stripped and entities decoded — the words a reader sees on the page. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

/**
 * The whole rendered document, surface by surface.
 *
 * Assembled exactly as `renderVersionPdf` assembles it — the authored body with
 * its figures filled, then the summary page, then the schedules — so what is
 * under test is the document, not three modules that happen to be imported
 * together.
 */
function surfaces(): Array<{ name: string; text: string }> {
  const exhibits = buildExhibits(CALCULATION, CTX);
  const body = fillFigures(
    instantiateTemplate(templateForKind('409a'), {
      company_name: CTX.companyName,
      kind: '409a',
      valuation_ref: 'V-2026-0001',
      date: CTX.valuationDate!,
      currency: CTX.currency,
    }),
    reportFigures(CALCULATION, CTX.currency),
  );
  const summary = buildReportSummary(CALCULATION, CTX)!;

  const summaryText = [
    summary.headline.label,
    summary.headline.value,
    summary.headline.note ?? '',
    ...(summary.figures ?? []).flatMap((f) => [f.label, f.value, f.note ?? '']),
    summary.statement ?? '',
    ...(summary.charts ?? []).flatMap((c) => JSON.stringify(c)),
  ].join(' ');

  return [
    ...visibleSections(body).map((s) => ({
      name: `body · ${s.heading}`,
      text: plain(`${s.heading} ${s.html}`),
    })),
    { name: 'summary page', text: summaryText },
    ...exhibits.map((s) => ({ name: s.heading, text: plain(s.html) })),
  ];
}

const SURFACES = surfaces();

/** The canonical rendering of the concluded per-share figure. */
const FMV_TEXT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
}).format(FMV);

/**
 * Where a figure appears, as a *whole* figure.
 *
 * A plain substring search is useless here: "4%" is inside "62.4%", and
 * "$42,664,610" is inside "$42,664,610.00" — so the near-miss scan would
 * either report every surface or silently miss the one rendering it is looking
 * for. Both ends are anchored: nothing numeric before, and after it no further
 * digits, no thousands separator and no decimal point followed by digits — so
 * "$1" does not match the "$1,000,000" of a cash-flow schedule.
 */
function findAll(needle: string): string[] {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\d.])${escaped}(?!\\d)(?!,\\d)(?!\\.\\d)`);
  return SURFACES.filter((s) => re.test(s.text)).map((s) => s.name);
}

/**
 * Every *other* way this fraction could plausibly have been printed as a
 * percentage. Generated rather than listed: the point is to catch a rendering
 * nobody thought of.
 */
function otherPercents(fraction: number, canonical: string): string[] {
  const pct = fraction * 100;
  const out = new Set<string>();
  for (let d = 0; d <= 6; d += 1) out.add(`${pct.toFixed(d)}%`);
  out.delete(canonical);
  return [...out];
}

/** The same, for a money figure. */
function otherMoney(value: number, currency: string, canonical: string): string[] {
  const out = new Set<string>();
  for (let d = 0; d <= 6; d += 1) {
    out.add(
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      }).format(value),
    );
  }
  out.delete(canonical);
  return [...out];
}

describe('one spelling of every concluded figure', () => {
  /**
   * Each entry: the canonical rendering, the surfaces that must carry it, and
   * every near miss that must appear nowhere at all.
   */
  const CASES: Array<{ what: string; canonical: string; nearMisses: string[]; atLeast: number }> = [
    {
      what: 'the concluded FMV per common share',
      canonical: FMV_TEXT,
      nearMisses: otherMoney(FMV, 'USD', FMV_TEXT),
      // The summary headline, the opinion sentence, the conclusion chapter, the
      // ASC 718 assumptions table and Exhibit H's foot.
      atLeast: 3,
    },
    {
      what: 'the marketable value per common share, before discounts',
      canonical: '$2.1514',
      nearMisses: otherMoney(MARKETABLE, 'USD', '$2.1514'),
      atLeast: 3,
    },
    {
      what: 'the concluded equity value',
      canonical: '$42,664,610',
      nearMisses: otherMoney(EQUITY, 'USD', '$42,664,610'),
      atLeast: 3,
    },
    {
      what: 'the discount for lack of control',
      canonical: '12.34%',
      nearMisses: otherPercents(DLOC, '12.34%'),
      // The summary page, the DLOC chapter, the conclusion chapter, Exhibit B-1
      // and Exhibit H — twice, in the step table and in the derivation below it.
      atLeast: 4,
    },
    {
      what: 'the discount for lack of marketability',
      canonical: '27.66%',
      nearMisses: otherPercents(DLOM, '27.66%'),
      atLeast: 4,
    },
    {
      what: 'the expected volatility the allocation ran on',
      canonical: '62.4%',
      nearMisses: otherPercents(VOLATILITY, '62.4%'),
      // The summary's key-assumptions chip, the allocation chapter, the ASC 718
      // assumptions table and Exhibit F.
      atLeast: 3,
    },
    {
      what: 'the risk-free rate',
      canonical: '4.21%',
      nearMisses: otherPercents(RISK_FREE, '4.21%'),
      atLeast: 2,
    },
  ];

  for (const { what, canonical, nearMisses, atLeast } of CASES) {
    it(`states ${what} as ${canonical} and never any other way`, () => {
      const found = findAll(canonical);
      expect(found.length, `${canonical} appears on: ${found.join(', ')}`).toBeGreaterThanOrEqual(atLeast);
      for (const miss of nearMisses) {
        const where = findAll(miss);
        expect(where, `${what} is ${canonical}, but "${miss}" appears on: ${where.join(', ')}`).toEqual([]);
      }
    });
  }
});

describe('the schedules a reader checks the conclusion against', () => {
  /** The `Weighted` column of Exhibit H-1's blend table, as percentages. */
  const readWeightedColumn = (text: string): number[] =>
    [...text.matchAll(/(?:model|studies|judgement|bound) [\d.]+% [\d.]+% ([\d.]+)%/g)].map((m) =>
      Number(m[1]),
    );

  const readWeightedTotal = (text: string): number => {
    const m = /Selected discount for lack of marketability [\d.]+% ([\d.]+)%/.exec(text);
    expect(m, 'no footed total in Exhibit H-1').toBeTruthy();
    return Number(m![1]);
  };

  const exhibit = (heading: string) => {
    const found = SURFACES.find((s) => s.name.startsWith(heading));
    expect(found, `${heading} was not rendered`).toBeTruthy();
    return found!.text;
  };

  /**
   * The weighted column of Exhibit H-1 is stated rather than left to be
   * multiplied out, and its whole point is that the concluded discount is
   * *visibly* the sum of it. Rounded to a tenth of a percent it was not: three
   * legs of 9.3733%, 11.1367% and 7.15% printed as 9.4%, 11.1% and 7.1%, under
   * a total of 27.7% they add to 27.6%.
   */
  it('Exhibit H-1: the weighted column adds to the concluded discount', () => {
    const text = exhibit('Exhibit H-1');
    // The column as printed, read back off the page — not the numbers behind it.
    const printed = [...text.matchAll(/put model|studies/g)].length > 0 ? readWeightedColumn(text) : [];
    expect(printed.length, 'no weighted column in Exhibit H-1').toBe(3);
    const total = readWeightedTotal(text);
    expect(printed.reduce((n, v) => n + v, 0)).toBeCloseTo(total, 9);
    expect(total).toBeCloseTo(DLOM * 100, 9);
  });

  /**
   * Exhibit H's derivation table is a chain, and each row states the formula
   * that gets to the next one. A reader with a calculator has to arrive where
   * the exhibit arrives.
   */
  it('Exhibit H: the control-premium chain reproduces the concluded discount', () => {
    const text = exhibit('Exhibit H —');
    const pct = (s: string) => {
      const m = new RegExp(`${s} ([\\d.]+)%`).exec(text);
      expect(m, `no "${s}" row in Exhibit H`).toBeTruthy();
      return Number(m![1]) / 100;
    };
    const observed = pct('Control premium observed');
    const synergy = pct('Less: share attributed to synergies');
    const applied = pct('Control premium applied');
    const concluded = pct('Discount for lack of control');

    // Row by row, on the figures the page prints — not on the ones behind them.
    expect(observed * (1 - synergy)).toBeCloseTo(applied, 6);
    expect(1 - 1 / (1 + applied)).toBeCloseTo(concluded, 6);
    expect(concluded).toBeCloseTo(DLOC, 6);
  });

  /**
   * The step table is the derivation of the conclusion, and it has to close: the
   * marketable value less each deduction is the concluded FMV, at the four
   * decimal places the exhibit prints.
   */
  it('Exhibit H: the step table closes on the concluded value', () => {
    const text = exhibit('Exhibit H —');
    const afterDloc = MARKETABLE * (1 - DLOC);
    expect(text).toContain('$2.1514'); // marketable
    expect(text).toContain(`($${(MARKETABLE - afterDloc).toFixed(4)})`); // DLOC deduction
    expect(text).toContain(`$${afterDloc.toFixed(4)}`); // marketable minority
    expect(text).toContain(FMV_TEXT); // concluded
    // What the page states, redone from what the page states.
    expect(MARKETABLE * (1 - DLOC) * (1 - DLOM)).toBeCloseTo(FMV, 4);
  });

  /**
   * Exhibit B-1 names Exhibit H's rate in a sentence that points at Exhibit H.
   * The two used to disagree, three pages apart, about a rate they both read
   * off one field.
   */
  /**
   * Exhibit D's bridge reads "Indicated enterprise value … Metric × multiple",
   * which is an instruction. At two decimal places the selected multiple was a
   * rounding of an unrounded median, so the instruction produced a different
   * number from the one printed beside it.
   */
  it('Exhibit D: the metric times the printed multiple is the printed indication', () => {
    const text = exhibit('Exhibit D —');
    const m = /Selected EV\/LTM Revenue ([\d.]+)x/.exec(text);
    expect(m, 'no selected-multiple row in Exhibit D').toBeTruthy();
    const printed = Number(m![1]);
    expect(printed).toBe(MARKET_MULTIPLE);
    // Redone from the page: the metric it prints, times the multiple it prints.
    const indication = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(MARKET_METRIC * printed);
    expect(text).toContain(indication);
    // And the guideline column the median is taken from is stated the same way.
    expect(text).toContain('5.12x');
    expect(text).toContain('7.10x');
  });

  it('Exhibit B-1 quotes Exhibit H at the rate Exhibit H prints', () => {
    expect(exhibit('Exhibit B-1')).toContain('discount for lack of control of 12.34% in Exhibit H');
  });
});

/**
 * The summary page against the schedule behind it.
 *
 * A board member adopts the value off the summary; an auditor checks it against
 * Exhibit H. If the two pages state the discounts differently, one of them is
 * wrong and the document does not say which.
 */
describe('the summary page and the schedules', () => {
  const summary = buildReportSummary(CALCULATION, CTX)!;
  const byLabel = Object.fromEntries((summary.figures ?? []).map((f) => [f.label, f]));

  it('states the discounts as Exhibit H states them', () => {
    expect(byLabel['Discount for lack of control']!.value).toBe('12.34%');
    expect(byLabel['Discount for lack of marketability']!.value).toBe('27.66%');
  });

  it('labels its own waterfall with the same two rates', () => {
    const waterfall = (summary.charts ?? []).find((c) => c.type === 'waterfall');
    const labels = JSON.stringify(waterfall);
    expect(labels).toContain('Less DLOC 12.34%');
    expect(labels).toContain('Less DLOM 27.66%');
  });

  it('states the headline at the precision the conclusion chapter does', () => {
    expect(summary.headline.value).toBe(FMV_TEXT);
    expect(summary.statement).toContain(FMV_TEXT);
  });
});

/**
 * The source-level backstop.
 *
 * The rendered census above only sees the figures a *409A* run produces. The
 * concluded discounts are also printed by branches this fixture does not reach —
 * the zero-DLOC paragraph in Exhibit B-1, the single-method foot of Exhibit H-1 —
 * and a new one added tomorrow would pass every assertion above by never being
 * rendered. So: in the three modules that build the deliverable, the concluded
 * discounts may not be handed to the rounding formatter at all.
 *
 * `formatPercent` is still right for everything it is used for elsewhere in
 * these files — an approach weight, a volatility, a benchmark return. It is the
 * two concluded discounts, which a reader multiplies, that must not go through
 * it.
 */
describe('the concluded discounts are never rounded for reading', () => {
  const MODULES = ['reportExhibits.ts', 'reportSummary.ts', 'reportFigures.ts', 'sampleReportPdf.ts'];

  for (const file of MODULES) {
    it(`${file} formats them exactly`, () => {
      const src = readFileSync(new URL(`../../src/domain/${file}`, import.meta.url), 'utf8');
      const offenders: string[] = [];
      for (const [line] of src.matchAll(/formatPercent\((?:[^()]|\([^()]*\))*\)/g)) {
        // The argument, not the whole call — `formatPercent(dlom_volatility)`
        // is a volatility and belongs at one decimal place.
        const arg = line.slice('formatPercent('.length, -1).split(',')[0]!.trim();
        if (/^(DLOC|DLOM|dloc|dlom)$/.test(arg)) offenders.push(line);
      }
      expect(offenders, 'use formatExactPercent for a rate the reader multiplies').toEqual([]);
    });
  }
});
