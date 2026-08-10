import type { ReportPdfSection } from '@n409/report/pdf';
import { formatCurrency, formatPercent, num } from './reportSummary.js';
import type { ExhibitContext } from './reportExhibits.js';
import { esc, P, section, table } from './exhibitHtml.js';
import type { FundMarkRow, FundPositionRow, FundRow, LpTermsRow } from '../repos/funds.js';
import type { CreditTermsRow, DebtInstrumentRow, DebtValuationRow } from '../repos/debtInstruments.js';

/**
 * Render-time schedules for the two measurement kinds — `fund` (ASC 820 fund
 * holdings) and `debt` (credit instruments).
 *
 * These are the last two of the fifteen valuation kinds to get a deliverable.
 * Both had a complete measurement domain — engines, CRUD, mark and valuation
 * history, an ops UI — and no report: `templateForKind` fell through to the
 * generic skeleton and no exhibit module could read them, because a fund
 * portfolio and a debt instrument were not connected to an engagement at all
 * until migration 0109.
 *
 * The important structural difference from every other exhibit module: these
 * do NOT read a `calculations` row. Fund and debt measurements are persisted
 * in their own tables (`fund_marks`, `debt_valuations`) by their own routes,
 * and the engine has already done the maths at mark/price time — each mark
 * carries the fair value and the ASC 820 level the engine assigned it, each
 * debt valuation carries the engine's whole result document. So the NAV
 * rollup here is summation over stored marks, not a re-run.
 *
 * That is deliberate, and it is the same guarantee the 409A exhibits give: a
 * report renders from what was recorded, so re-rendering an opinion published
 * last quarter cannot silently restate it at today's prices, and a PDF cannot
 * fail to render because the Python engine is down.
 *
 * Same degradation rule as the other exhibit modules: an absent or partial
 * shape drops the exhibit rather than throwing inside a render.
 */

const INT = new Intl.NumberFormat('en-US');

function money(value: unknown, ctx: ExhibitContext, digits = 0): string | null {
  const n = num(value);
  return n === null ? null : formatCurrency(n, ctx.currency, digits);
}

/** Money that must occupy a cell — totals columns cannot be blank mid-table. */
function moneyCell(value: unknown, ctx: ExhibitContext, digits = 0): string {
  return money(value, ctx, digits) ?? '—';
}

function pct(value: unknown, digits = 1): string {
  const n = num(value);
  return n === null ? '—' : formatPercent(n, digits);
}

/**
 * Share counts for a table cell. Takes a `number` rather than `unknown`: every
 * caller reads `MarkedPosition.quantity`, which `markedPositions` has already
 * coerced through `num(...) ?? 0`, so a non-finite value cannot arrive here and
 * the `—` fallback the other cell helpers carry would be unreachable.
 */
function quantity(value: number): string {
  return INT.format(Math.round(value));
}

/** Humanize a snake_case key for a table cell. */
function label(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `YYYY-MM-DD` from a `date` column, which node-postgres hands back as a JS
 * Date rather than the string the column holds. Both forms are accepted
 * because a caller assembling this data in memory passes a string; taking only
 * one was how the first version of this module threw inside a render.
 *
 * A Date from OID 1082 is midnight *local* time, so it is formatted from its
 * local parts — toISOString() would shift it a day backwards west of UTC and
 * date a measurement to the day before it was made.
 */
function isoDate(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

// ── Fund (ASC 820 holdings) ──────────────────────────────────────────────────

/** What the renderer loads for a `fund` engagement (repos/measurementReport.ts). */
export interface FundReportData {
  fund: FundRow;
  /** Every position, each with its most recent mark — or null when never marked. */
  positions: Array<{ position: FundPositionRow; mark: FundMarkRow | null }>;
  lpTerms: LpTermsRow | null;
}

const MARK_METHOD_LABELS: Record<string, string> = {
  market: 'Quoted market price',
  last_round: 'Last round price',
  calibrated_opm: 'Calibrated OPM',
  cost: 'Cost',
};

/**
 * ASC 820 assigns the level by the observability of the inputs, and the engine
 * stamps it on the mark. An unmarked position is carried at cost, which is a
 * Level 3 measurement — stating it as anything else would overstate how
 * observable the portfolio is, which is the single thing this hierarchy exists
 * to disclose.
 */
const UNMARKED_LEVEL = 3;

interface MarkedPosition {
  name: string;
  securityType: string;
  method: string;
  level: number;
  quantity: number;
  costBasis: number;
  fairValue: number;
  /** False when the position has never been marked and is carried at cost. */
  marked: boolean;
  measurementDate: string | null;
}

/**
 * Flatten stored positions + latest marks into the rows every fund exhibit
 * reads, so the schedule, the hierarchy table and the NAV rollup are three
 * views of one list and cannot disagree about a total.
 */
function markedPositions(data: FundReportData): MarkedPosition[] {
  return data.positions.map(({ position, mark }) => {
    const costBasis = num(position.cost_basis) ?? 0;
    return {
      name: position.company_name,
      securityType: position.security_type,
      method: mark ? mark.method : 'cost',
      level: mark ? mark.level : UNMARKED_LEVEL,
      quantity: num(position.quantity) ?? 0,
      costBasis,
      // No mark means carried at cost — the same convention routes/funds.ts
      // uses when it assembles the NAV request for the engine.
      fairValue: mark ? (num(mark.fair_value) ?? costBasis) : costBasis,
      marked: mark !== null,
      measurementDate: mark ? isoDate(mark.measurement_date) : null,
    };
  });
}

function portfolioScheduleExhibit(positions: MarkedPosition[], ctx: ExhibitContext): ReportPdfSection | null {
  if (positions.length === 0) return null;
  const rows = positions.map((p) => [
    esc(p.name),
    esc(label(p.securityType)),
    quantity(p.quantity),
    moneyCell(p.costBasis, ctx),
    esc(MARK_METHOD_LABELS[p.method] ?? label(p.method)),
    `Level ${p.level}`,
    moneyCell(p.fairValue, ctx),
    moneyCell(p.fairValue - p.costBasis, ctx),
  ]);
  const totalCost = positions.reduce((sum, p) => sum + p.costBasis, 0);
  const totalFair = positions.reduce((sum, p) => sum + p.fairValue, 0);

  // Named, because a reader who sees a portfolio carried at cost should be told
  // it has not been marked rather than left to infer it from a zero gain.
  const unmarked = positions.filter((p) => !p.marked).length;

  return section('Exhibit — Portfolio Schedule', [
    P(
      'Each holding in the portfolio at the measurement date, its cost basis, the technique used to measure its fair value, and the resulting unrealized gain or loss.',
    ),
    table({
      head: [
        'Portfolio company',
        'Security',
        'Quantity',
        'Cost basis',
        'Measurement technique',
        'Level',
        'Fair value',
        'Unrealized gain',
      ],
      rows,
      foot: [
        'Total',
        '',
        '',
        moneyCell(totalCost, ctx),
        '',
        '',
        moneyCell(totalFair, ctx),
        moneyCell(totalFair - totalCost, ctx),
      ],
    }),
    unmarked > 0
      ? P(
          `${unmarked} of ${positions.length} holdings carry no mark at the measurement date and are stated at cost, which is measured as a Level 3 input.`,
        )
      : null,
  ]);
}

function hierarchyExhibit(positions: MarkedPosition[], ctx: ExhibitContext): ReportPdfSection | null {
  if (positions.length === 0) return null;
  const total = positions.reduce((sum, p) => sum + p.fairValue, 0);
  const rows = [1, 2, 3].map((level) => {
    const held = positions.filter((p) => p.level === level);
    const value = held.reduce((sum, p) => sum + p.fairValue, 0);
    return [
      `Level ${level}`,
      String(held.length),
      moneyCell(value, ctx),
      // Guarded: a portfolio whose holdings are all worth nothing is a real
      // state, and it must not print NaN% across the hierarchy.
      total > 0 ? pct(value / total) : '—',
    ];
  });
  return section('Exhibit — Fair Value Hierarchy (ASC 820)', [
    P(
      'The portfolio classified by the observability of the inputs to each measurement: Level 1 quoted prices in active markets, Level 2 observable inputs other than quoted prices, and Level 3 unobservable inputs.',
    ),
    table({
      head: ['Level', 'Holdings', 'Fair value', '% of portfolio'],
      rows,
      foot: ['Total', String(positions.length), moneyCell(total, ctx), total > 0 ? '100.0%' : '—'],
    }),
  ]);
}

function navExhibit(positions: MarkedPosition[], ctx: ExhibitContext): ReportPdfSection | null {
  if (positions.length === 0) return null;
  const cost = positions.reduce((sum, p) => sum + p.costBasis, 0);
  const gross = positions.reduce((sum, p) => sum + p.fairValue, 0);
  const rows: string[][] = [
    ['Total cost basis', moneyCell(cost, ctx)],
    ['Gross asset value', moneyCell(gross, ctx)],
    ['Total unrealized gain', moneyCell(gross - cost, ctx)],
  ];
  return section('Exhibit — Net Asset Value', [
    P('The roll-up of the portfolio schedule to the net asset value of the fund at the measurement date.'),
    table({ head: ['', 'Amount'], rows, foot: ['Net asset value', moneyCell(gross, ctx)] }),
    // The rollup states no liabilities because none are recorded against a
    // portfolio: the fund CRUD has no liability model and routes/funds.ts
    // calls the engine with liabilities: 0. Saying so is the difference
    // between "the fund has none" and "we did not measure any".
    P(
      'No fund-level liabilities are recorded against this portfolio; net asset value is stated equal to gross asset value.',
    ),
  ]);
}

function lpTermsExhibit(terms: LpTermsRow | null, ctx: ExhibitContext): ReportPdfSection | null {
  if (!terms) return null;
  const committed = num(terms.committed_capital) ?? 0;
  const contributed = num(terms.contributed_capital) ?? 0;
  const rows: string[][] = [
    ['Committed capital', moneyCell(committed, ctx)],
    ['Contributed capital', moneyCell(contributed, ctx)],
    ['Unfunded commitment', moneyCell(Math.max(committed - contributed, 0), ctx)],
    ['Preferred return (hurdle)', pct(terms.preferred_return_rate)],
    ['Carried interest', pct(terms.carry_pct)],
    ['GP catch-up', terms.gp_catch_up ? 'Yes' : 'No'],
    ['Management fee', pct(terms.management_fee_pct)],
    ['Management fees paid to date', moneyCell(terms.management_fees_paid, ctx)],
    ['GP distributions to date', moneyCell(terms.gp_distributions_to_date, ctx)],
  ];
  return section('Exhibit — Limited Partnership Economics', [
    P(
      'The distribution terms governing the fund, which determine how the net asset value above would be shared between the limited partners and the general partner on a realization.',
    ),
    table({ head: ['Term', 'Value'], rows }),
  ]);
}

export function buildFundExhibits(data: FundReportData | null, ctx: ExhibitContext): ReportPdfSection[] {
  if (!data) return [];
  const positions = markedPositions(data);
  return [
    portfolioScheduleExhibit(positions, ctx),
    hierarchyExhibit(positions, ctx),
    navExhibit(positions, ctx),
    lpTermsExhibit(data.lpTerms, ctx),
  ].filter((s): s is ReportPdfSection => s !== null);
}

// ── Debt (credit instruments) ────────────────────────────────────────────────

/** What the renderer loads for a `debt` engagement (repos/measurementReport.ts). */
export interface DebtReportData {
  instrument: DebtInstrumentRow;
  creditTerms: CreditTermsRow | null;
  /** The valuation the report speaks for — the most recent one. */
  valuation: DebtValuationRow | null;
  /** Prior valuations, newest first, for the history exhibit. */
  history: DebtValuationRow[];
}

const INSTRUMENT_LABELS: Record<string, string> = {
  bond: 'Bond',
  term_loan: 'Term loan',
  convertible: 'Convertible note',
  safe: 'SAFE',
  credit_spread: 'Credit-spread instrument',
};

const SENIORITY_LABELS: Record<string, string> = {
  senior_secured: 'Senior secured',
  senior: 'Senior unsecured',
  subordinated: 'Subordinated',
  mezzanine: 'Mezzanine',
};

/**
 * Instrument parameters that are rates, and print as percentages. Everything
 * else in `params` is a money amount, a count of years or a flag; a rate shown
 * as `0.065` instead of `6.5%` is the kind of figure a reader silently
 * misreads by two orders of magnitude.
 */
const RATE_PARAMS = new Set([
  'coupon_rate',
  'market_yield',
  'benchmark_yield',
  'spread',
  'discount_rate',
  'risk_free_rate',
  'volatility',
  'dividend_yield',
  'discount_pct',
]);

/** Params that are counts rather than money — years, periods, frequencies. */
const COUNT_PARAMS = new Set(['frequency', 'maturity_years', 'time_to_exit_years', 'periods', 'years']);

function paramValue(key: string, value: unknown, ctx: ExhibitContext): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (RATE_PARAMS.has(key)) return pct(value, 3);
  const n = num(value);
  if (n === null) return esc(String(value));
  if (COUNT_PARAMS.has(key)) return INT.format(n);
  return moneyCell(n, ctx, 2);
}

function instrumentExhibit(data: DebtReportData, ctx: ExhibitContext): ReportPdfSection | null {
  const params = data.instrument.params ?? {};
  // The engine was called with the stored params merged over per-run overrides
  // (routes/debt.ts), so the run's own inputs are what the instrument was
  // actually priced on — prefer them, and fall back to the stored record for
  // an instrument that has never been valued.
  const runInputs = data.valuation?.inputs as { params?: unknown } | undefined;
  const priced =
    runInputs?.params && typeof runInputs.params === 'object' && !Array.isArray(runInputs.params)
      ? (runInputs.params as Record<string, unknown>)
      : params;

  const rows = Object.entries(priced)
    .map(([key, value]) => [esc(label(key)), paramValue(key, value, ctx)])
    .filter((row): row is string[] => row[1] !== null);
  if (rows.length === 0) return null;

  return section('Exhibit — Instrument Terms', [
    P(
      `The contractual terms of <strong>${esc(data.instrument.name)}</strong>, a ${esc(
        (INSTRUMENT_LABELS[data.instrument.instrument_type] ?? data.instrument.instrument_type).toLowerCase(),
      )}, as priced at the measurement date.`,
    ),
    table({ head: ['Term', 'Value'], rows }),
  ]);
}

function creditExhibit(data: DebtReportData): ReportPdfSection | null {
  const terms = data.creditTerms;
  const result = data.valuation?.result ?? {};
  const rows: string[][] = [];
  const push = (name: string, value: string | null) => {
    if (value !== null) rows.push([name, value]);
  };

  if (terms) {
    push('Credit rating', terms.rating ? esc(terms.rating) : null);
    push('Seniority', esc(SENIORITY_LABELS[terms.seniority] ?? label(terms.seniority)));
    push('Secured', terms.secured ? 'Yes' : 'No');
  }
  // The yield build-up as the engine reported it, which is the authority: a
  // credit_spread run returns the benchmark, the spread and the all-in yield
  // it actually discounted at, and those can differ from the stored credit
  // terms when the run carried an override. Fall back to the stored terms only
  // where the run said nothing.
  const rate = (value: unknown): string | null => (num(value) === null ? null : pct(value, 3));
  push('Benchmark yield', rate(result.benchmark_yield) ?? rate(terms?.benchmark_yield));
  push('Credit spread', rate(result.credit_spread) ?? rate(terms?.spread));
  push('All-in discount yield', rate(result.all_in_yield) ?? rate(result.market_yield));

  if (rows.length === 0) return null;
  return section('Exhibit — Credit Terms & Discount Rate', [
    P(
      'The credit characteristics of the instrument and the yield at which its contractual cash flows were discounted.',
    ),
    table({ head: ['Input', 'Value'], rows }),
  ]);
}

/** Result keys that are the measurement itself, in the order a reader wants them. */
const RESULT_ORDER: Array<[key: string, name: string, kind: 'money' | 'rate' | 'number' | 'text']> = [
  ['fair_value', 'Fair value', 'money'],
  ['clean_price', 'Clean price', 'money'],
  ['accrued_interest', 'Accrued interest', 'money'],
  ['dirty_price', 'Dirty price', 'money'],
  ['premium_discount_to_par', 'Premium / (discount) to par', 'money'],
  ['straight_debt_value', 'Straight debt value', 'money'],
  ['option_value', 'Embedded option value', 'money'],
  ['parity', 'Conversion parity', 'money'],
  ['market_yield', 'Market yield', 'rate'],
  ['macaulay_duration', 'Macaulay duration (years)', 'number'],
  ['modified_duration', 'Modified duration', 'number'],
  ['convexity', 'Convexity', 'number'],
  ['shares_received', 'Shares received on conversion', 'number'],
  ['ownership_pct', 'Ownership on conversion', 'rate'],
  ['conversion_price', 'Conversion price', 'money'],
  ['moic', 'Multiple on invested capital', 'number'],
  ['structure', 'Amortization structure', 'text'],
  ['converted_via', 'Conversion mechanism', 'text'],
];

function valuationExhibit(data: DebtReportData, ctx: ExhibitContext): ReportPdfSection | null {
  const result = data.valuation?.result;
  if (!result) return null;
  const rows: string[][] = [];
  for (const [key, name, kind] of RESULT_ORDER) {
    const value = result[key];
    if (value === null || value === undefined) continue;
    if (kind === 'text') {
      rows.push([name, esc(label(String(value)))]);
      continue;
    }
    const n = num(value);
    if (n === null) continue;
    rows.push([name, kind === 'money' ? moneyCell(n, ctx, 2) : kind === 'rate' ? pct(n, 3) : n.toFixed(4)]);
  }
  if (rows.length === 0) return null;
  return section('Exhibit — Valuation Result', [
    P(`The measurement produced by the credit engine at ${esc(isoDate(data.valuation!.valuation_date))}.`),
    table({ head: ['Measure', 'Value'], rows }),
  ]);
}

function cashFlowExhibit(data: DebtReportData, ctx: ExhibitContext): ReportPdfSection | null {
  const schedule = data.valuation?.result?.schedule;
  if (!Array.isArray(schedule) || schedule.length === 0) return null;
  const rows = schedule
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r))
    .map((r) => [
      String(num(r.period) ?? ''),
      num(r.t_years) === null ? '—' : (num(r.t_years) as number).toFixed(4),
      moneyCell(r.interest, ctx, 2),
      moneyCell(r.principal, ctx, 2),
      moneyCell(r.amount, ctx, 2),
      moneyCell(r.balance, ctx, 2),
    ]);
  if (rows.length === 0) return null;
  const total = schedule.reduce<number>(
    (sum, r) => sum + (num((r as Record<string, unknown>)?.amount) ?? 0),
    0,
  );
  return section('Exhibit — Contractual Cash Flows', [
    P('The contractual interest and principal payments discounted to arrive at the fair value above.'),
    table({
      head: ['Period', 'Years', 'Interest', 'Principal', 'Payment', 'Balance'],
      rows,
      foot: ['Total', '', '', '', moneyCell(total, ctx, 2), ''],
    }),
  ]);
}

function historyExhibit(data: DebtReportData, ctx: ExhibitContext): ReportPdfSection | null {
  // One valuation is the measurement, not a history — the result exhibit
  // already states it, and a one-row "history" table adds nothing.
  if (data.history.length < 2) return null;
  const rows = data.history.map((v) => [esc(isoDate(v.valuation_date)), moneyCell(v.fair_value, ctx, 2)]);
  return section('Exhibit — Valuation History', [
    P('Prior measurements of this instrument, most recent first.'),
    table({ head: ['Valuation date', 'Fair value'], rows }),
  ]);
}

export function buildDebtExhibits(data: DebtReportData | null, ctx: ExhibitContext): ReportPdfSection[] {
  if (!data) return [];
  return [
    instrumentExhibit(data, ctx),
    creditExhibit(data),
    valuationExhibit(data, ctx),
    cashFlowExhibit(data, ctx),
    historyExhibit(data, ctx),
  ].filter((s): s is ReportPdfSection => s !== null);
}
