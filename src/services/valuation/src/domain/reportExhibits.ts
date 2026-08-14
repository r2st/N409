import type { ReportPdfSection } from '@n409/report/pdf';
import type { CalculationRow } from '../repos/calculations.js';
import {
  APPROACH_LABELS,
  ALLOCATION_LABELS,
  DLOM_LABELS,
  formatCurrency,
  formatPercent,
  num,
} from './reportSummary.js';
import { buildSpecialtyExhibits } from './specialtyExhibits.js';
import { esc, P, section, table } from './exhibitHtml.js';
import { CLASS_VOLATILITY_SCHEDULE } from './report.js';
import { MULTIPLE_LABELS, type MultipleKey } from './comparables.js';
import { isProjectionColumn, type ComputedSheet, type WorkbookFormat } from './workbook.js';
import { requiredReturnRows } from './requiredReturns.js';
import { sensitivityGrid, sensitivityTables, type OpmInputs } from './sensitivity.js';
import { VOLATILITY_CONFIDENCE_NOTES, VOLATILITY_METHOD_LABELS } from './volatility.js';
import type { VolatilityEstimateRow } from '../repos/volatilityEstimates.js';
import type { ProjectionRow, ProjectionYear } from '../repos/projections.js';
import type { RollforwardRunRow } from '../repos/rollforwardRuns.js';

/**
 * The supporting exhibits of the deliverable — the schedules a reviewer checks
 * the opinion against.
 *
 * The report body is authored: a template skeleton an analyst fills in with
 * prose. Nothing in it was ever *computed*, so a 409A left this service with a
 * conclusion section reading "the fair market value … is $ … per share" and a
 * methodology section describing an OPM in the abstract, while every figure the
 * engine had produced — the cap table it allocated, the four approach values it
 * weighted, the breakpoints it priced, the discounts it applied — existed only
 * in a jsonb column. The summary page (domain/reportSummary.ts) closed part of
 * that for a board member, who wants one number; it does nothing for the
 * auditor or the reviewing appraiser, who wants the workings.
 *
 * These sections are built at render time from the calculation that produced
 * the conclusion, and appended after the authored body. Two consequences are
 * deliberate:
 *
 *   * they cannot go stale against the engine, because they are not stored —
 *     a re-render after a recalculation shows the new figures; and
 *   * they cannot be edited away in the report editor, which is the right
 *     default for a schedule whose whole value is that it says what the model
 *     actually did.
 *
 * Everything degrades: an absent, partial or unfamiliar results shape drops the
 * exhibit rather than throwing inside a PDF render. A report drawn before the
 * engine has run gets no exhibits and is otherwise unchanged.
 */

export interface ExhibitContext {
  currency: string;
  /** Valuation date as the report states it (YYYY-MM-DD), when known. */
  valuationDate?: string | null;
  companyName: string;
  /**
   * The persisted peer set (migration 0119), when the engagement has one.
   * Absent for every engagement nobody has screened, and Exhibit D-1 is then
   * simply not rendered — the report reads exactly as it did before.
   */
  peers?: readonly ExhibitPeer[];
  /**
   * The valuation workbook, resolved (`workbook.computeWorkbook`). Absent for
   * an engagement whose financials nobody has entered, and Appendix II is then
   * simply not rendered.
   */
  financials?: readonly ComputedSheet[];
  /**
   * The stage of enterprise development the analyst concluded (AICPA scale),
   * from the methodology params. Null until somebody has concluded one — it is
   * never inferred — and Appendix III is then not rendered.
   */
  developmentStage?: number | null;
  /**
   * A firm's own required-return table, replacing the built-in ladder, as
   * `valuation_params.required_return_table` stores it.
   */
  requiredReturnTable?: unknown;
  /**
   * The volatility derivation that counts (migration 0134), when one has been
   * run. Absent for every engagement whose sigma was selected by judgement, and
   * Exhibit F-1 is then not rendered — the report reads exactly as it did
   * before the derivation existed.
   */
  volatility?: VolatilityEstimateRow | null;
  /**
   * Where the DCF's cash flows came from (migration 0136), when they were
   * projected rather than typed. Absent for every engagement whose analyst
   * entered the stream by hand, and Exhibit C-1 is then not rendered.
   */
  projection?: ProjectionRow | null;
  /**
   * The bridge from the prior 409A (migration 0150), when one was adopted. The
   * *applied* run only — a roll-forward nobody adopted describes an anchor the
   * calculation did not run on. Absent for every engagement valued from
   * scratch, and Exhibit B-2 is then not rendered.
   */
  rollforward?: RollforwardRunRow | null;
}

/** One row of the peer set, as Exhibit D-1 prints it. */
export interface ExhibitPeer {
  ticker: string | null;
  name: string;
  included: boolean;
  exclude_reason: string | null;
  source: string;
  score: number | null;
  multiples: Partial<Record<MultipleKey, number | null>>;
  /** Migration 0133 — where the figures came from, and when. Null on rows written before it. */
  figures_source?: string | null;
  figures_as_of?: Date | string | null;
}

/** The identifier the index and the body's pointers use for a schedule. */
export type ScheduleId =
  | 'A'
  | 'B'
  | 'B-1'
  | 'B-2'
  | 'C'
  | 'C-1'
  | 'D'
  | 'D-1'
  | 'E'
  | 'F'
  | 'F-1'
  | 'F-2'
  | 'F-3'
  | 'G'
  | 'H'
  | 'H-1'
  | 'I'
  | 'II'
  | 'II-1'
  | 'III'
  | 'IV';

export interface ScheduleDescriptor {
  id: ScheduleId;
  /** Lettered schedules are exhibits; the trailing support is an appendix. */
  kind: 'Exhibit' | 'Appendix';
  /** The name without the `Exhibit A — ` prefix. */
  name: string;
  /** True when every completed 409A carries it, whatever the engagement. */
  always: boolean;
}

/**
 * Every schedule `buildExhibits` can print, in printed order.
 *
 * This is the *catalogue*, and it exists because the identity of a schedule was
 * previously stated in three places that could disagree: the builder's own
 * heading literal, the public sample page's `SAMPLE_EXHIBITS` list, and the
 * reader's expectation. They did disagree. `domain/sampleReport.ts` promised a
 * prospect twelve schedules — A through H-1 — while `buildExhibits` had grown
 * three appendices (the WACC build-up, the historical statements, the
 * required-return ladder) that the page never mentioned. The sections of that
 * page are derived from the real template and so could not drift; the exhibit
 * list was hand-maintained and did.
 *
 * So the builders take their headings from here (`SCHEDULE`), the public page
 * derives its list from here, and a new schedule is unreachable until it has an
 * entry — which is the only arrangement in which the page and the deliverable
 * cannot come apart.
 *
 * `always` means "every completed 409A carries it": a company with no DCF gets
 * no Exhibit C, and one whose analyst chose sigma by judgement gets no F-1, so
 * only the cap table, the reconciliation, the allocation and the conclusion are
 * guaranteed. The appendices are conditional on data nobody is obliged to
 * enter, so none of them is `always` either.
 */
export const SCHEDULE_CATALOGUE: readonly ScheduleDescriptor[] = [
  { id: 'A', kind: 'Exhibit', name: 'Capitalization Table', always: true },
  { id: 'B', kind: 'Exhibit', name: 'Reconciliation of Valuation Approaches', always: true },
  { id: 'B-1', kind: 'Exhibit', name: 'Level of Value', always: false },
  { id: 'B-2', kind: 'Exhibit', name: 'Roll-Forward from the Prior Valuation', always: false },
  { id: 'C', kind: 'Exhibit', name: 'Income Approach (Discounted Cash Flow)', always: false },
  { id: 'C-1', kind: 'Exhibit', name: 'Basis of the Cash-Flow Forecast', always: false },
  { id: 'D', kind: 'Exhibit', name: 'Market Approach (Guideline Multiples)', always: false },
  { id: 'D-1', kind: 'Exhibit', name: 'Guideline Company Set', always: false },
  { id: 'E', kind: 'Exhibit', name: 'Asset Approach', always: false },
  { id: 'F', kind: 'Exhibit', name: 'Allocation of Equity Value', always: true },
  { id: 'F-1', kind: 'Exhibit', name: 'Selected Volatility', always: false },
  { id: 'F-2', kind: 'Exhibit', name: 'Allocation Sensitivity', always: false },
  { id: 'F-3', kind: 'Exhibit', name: 'Risk-Free Rate Sensitivity', always: false },
  { id: 'G', kind: 'Exhibit', name: 'Probability-Weighted Expected Return Scenarios', always: false },
  { id: 'H', kind: 'Exhibit', name: 'Discounts and Concluded Value', always: true },
  { id: 'H-1', kind: 'Exhibit', name: 'Marketability Discount: Derivation', always: false },
  { id: 'I', kind: 'Appendix', name: 'Discount Rate Build-Up (WACC)', always: false },
  { id: 'II', kind: 'Appendix', name: 'Historical Financial Statements', always: false },
  // `II-1` rather than `V`, and the suffix is load-bearing in two ways. It puts
  // the operating series immediately behind the statements it explains, the
  // same relationship D-1 has with D and F-1 with F; and it adds a schedule
  // without renumbering one, so no prose already authored against "Appendix
  // III" or "Appendix IV" starts pointing at the wrong page.
  { id: 'II-1', kind: 'Appendix', name: 'Core Operating Metrics', always: false },
  { id: 'III', kind: 'Appendix', name: 'Required Rates of Return by Stage of Development', always: false },
  { id: 'IV', kind: 'Appendix', name: 'Option Pricing Model Calculations', always: false },
];

/** `Exhibit D-1 — Guideline Company Set`, as the heading is printed. */
export function scheduleTitle(s: ScheduleDescriptor): string {
  return `${s.kind} ${s.id} — ${s.name}`;
}

/**
 * Headings by id, for the builders. A typo is a compile error rather than a
 * schedule that silently drops out of the index and the sample page.
 */
export const SCHEDULE: Readonly<Record<ScheduleId, string>> = Object.freeze(
  Object.fromEntries(SCHEDULE_CATALOGUE.map((s) => [s.id, scheduleTitle(s)])) as Record<ScheduleId, string>,
);

/**
 * Text → HTML text. Class names, scenario names and DLOM method labels all
 * originate with the client, travel through jsonb untouched, and land inside
 * table cells; `sanitizeHtml` is not in this path because these fragments are
 * built rather than saved. See domain/exhibitHtml.ts, which owns `esc`,
 * `table` and `P` for every exhibit module.
 */

const INT = new Intl.NumberFormat('en-US');

function shares(value: number): string {
  return INT.format(Math.round(value));
}

/** `1.2345x` — a multiple, a conversion ratio, a discount factor. */
function ratio(value: number, digits = 4): string {
  return `${value.toFixed(digits)}x`;
}

/** The `{ params, inputs }` document the engine was called with. */
interface Payload {
  params?: Record<string, unknown> | null;
  inputs?: Record<string, unknown> | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// ── Exhibit A — capitalization ───────────────────────────────────────────────

/** Seniority as the cap table prints it: absent means rank 1, unusable means unknown. */
function seniorityCell(value: unknown): string {
  if (value === null || value === undefined) return '1';
  const rank = num(value);
  return rank === null ? '—' : String(rank);
}

/**
 * The conversion ratio the allocation used, on an engine `share_classes` entry.
 *
 * Same convention as `capTable.ts`'s `asConvertedShares`, which is the
 * canonical statement of it but reads the *stored* cap-table row rather than
 * the engine payload this exhibit transcribes. Only preferred converts; common
 * and options are already in common-equivalent units, which is why the engine
 * attaches a ratio to no other kind and `_segments` puts an exercised option
 * pool into the residual at its bare share count.
 *
 * Absent means 1:1 — the engine's own default, and what every calculation
 * stored before the field existed meant. A ratio at or below zero counts 1:1
 * too: the engine refuses such a table outright, so it never reached a price,
 * and quoting an as-converted count of zero against it would read as a class
 * that converts into nothing rather than as the broken row it is.
 */
function conversionRatio(c: Record<string, unknown>): number {
  if (text(c.kind) !== 'preferred') return 1;
  const r = num(c.conversion_ratio);
  return r === null || r <= 0 ? 1 : r;
}

/**
 * The cap table the allocation actually ran on.
 *
 * Two shapes reach the engine and both belong here, because which one was used
 * decides how the equity was split. `share_classes` is the full table and drives
 * the breakpoint waterfall; the scalar fields (`shares_outstanding_common` and
 * friends) are the aggregate model, where one preference sits behind one blended
 * class. A reader has to be able to tell which they are looking at.
 */
export function capitalizationExhibit(
  inputs: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const classes = list(inputs.share_classes)
    .map(record)
    .filter((c): c is Record<string, unknown> => c !== null);
  const { currency } = ctx;

  if (classes.length > 0) {
    const rows = classes.map((c) => {
      const kind = text(c.kind) ?? '—';
      const count = num(c.shares);
      const conversion = conversionRatio(c);
      const preference = num(c.preference);
      const cap = num(c.participation_cap);
      const participation =
        kind !== 'preferred'
          ? '—'
          : c.participating
            ? cap !== null
              ? `Yes, capped at ${formatCurrency(cap, currency, 0)}`
              : 'Yes, uncapped'
            : 'No';
      return [
        esc(text(c.name) ?? '—'),
        kind === 'option' ? 'Options' : kind === 'preferred' ? 'Preferred' : 'Common',
        count === null ? '—' : shares(count),
        // The count the residual is actually split on, with the ratio that
        // produced it wherever it is not 1:1. Printed for every class, not only
        // the converting ones, so the column totals to the basis the allocation
        // ran on rather than to a mixture of two bases.
        count === null
          ? '—'
          : conversion === 1
            ? shares(count)
            : `${shares(count * conversion)} (${ratio(conversion)})`,
        kind === 'option'
          ? `Strike ${formatCurrency(num(c.strike) ?? 0, currency, 4)}`
          : preference === null
            ? '—'
            : formatCurrency(preference, currency, 0),
        // The only cell here that used to print its value with a bare
        // `String()`. An absent seniority is the engine's default rank of 1
        // and the prose above says so; a *present* one that is not a finite
        // number is a rank nobody supplied, and printing `[object Object]`,
        // `NaN` or `Infinity` into a cap table is worse than an em-dash.
        kind === 'preferred' ? seniorityCell(c.seniority) : '—',
        participation,
      ];
    });
    const totalShares = classes.reduce((sum, c) => sum + (num(c.shares) ?? 0), 0);
    const totalAsConverted = classes.reduce((sum, c) => sum + (num(c.shares) ?? 0) * conversionRatio(c), 0);
    const totalPreference = classes.reduce((sum, c) => sum + (num(c.preference) ?? 0), 0);
    const converts = classes.some((c) => conversionRatio(c) !== 1);
    return section(SCHEDULE.A, [
      P(
        `The capitalization of ${esc(ctx.companyName)}${ctx.valuationDate ? ` as of ${ctx.valuationDate}` : ''}, ` +
          'as allocated by the option-pricing waterfall. Liquidation preference is the aggregate ' +
          'preference of the class; seniority 1 is the most senior rank, and classes sharing a rank ' +
          'rank pari passu. The residual above the preference stack is shared on the as-converted ' +
          'basis, so it is the as-converted column — outstanding shares at each class&rsquo;s ' +
          'conversion ratio — that the allocation divides.' +
          (converts
            ? ' A class converting at other than 1:1 carries its ratio beside the converted count.'
            : ' No class on this table converts at other than 1:1.'),
      ),
      table({
        head: [
          'Class',
          'Type',
          'Shares',
          'As-converted',
          'Liquidation preference',
          'Seniority',
          'Participating',
        ],
        rows,
        foot: [
          'Total',
          '',
          shares(totalShares),
          shares(totalAsConverted),
          formatCurrency(totalPreference, currency, 0),
          '',
          `${classes.length} classes`,
        ],
      }),
    ]);
  }

  // Aggregate model.
  const common = num(inputs.shares_outstanding_common);
  const preferred = num(inputs.shares_outstanding_preferred);
  const options = num(inputs.options_outstanding);
  const preference = num(inputs.liquidation_preference);
  if (common === null && preferred === null && options === null) return null;

  const rows: string[][] = [];
  if (common !== null) rows.push(['Common stock', shares(common), '—']);
  if (preferred !== null && preferred > 0) {
    rows.push([
      'Preferred stock',
      shares(preferred),
      preference === null ? '—' : formatCurrency(preference, currency, 0),
    ]);
  }
  if (options !== null && options > 0) rows.push(['Options outstanding', shares(options), '—']);
  const total = (common ?? 0) + (preferred ?? 0) + (options ?? 0);
  return section(SCHEDULE.A, [
    P(
      'The capitalization is stated on the aggregate basis: a single blended preferred class behind a ' +
        'single liquidation preference, with common and the option pool sharing the residual. No ' +
        'class-by-class cap table was supplied for this valuation.',
    ),
    table({
      head: ['Security', 'Shares', 'Liquidation preference'],
      rows,
      foot: [
        'Fully diluted',
        shares(total),
        preference === null ? '—' : formatCurrency(preference, currency, 0),
      ],
    }),
  ]);
}

// ── Exhibit B — approaches ───────────────────────────────────────────────────

/**
 * Indicated equity value by approach, the weight applied to each, and the
 * weighted conclusion — the reconciliation a reviewer challenges first.
 *
 * PWERM has no approach block: its scenarios *are* the equity value, so the
 * exhibit is absent rather than empty on that path.
 */
export function approachExhibit(
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const approaches = record(results.approaches);
  if (!approaches) return null;
  const { currency } = ctx;

  const entries = Object.entries(approaches)
    .map(([key, raw]) => {
      const value = record(raw);
      return {
        key,
        weight: num(value?.weight) ?? 0,
        equity: num(value?.equity_value),
        enterprise: num(value?.enterprise_value),
        method: text(value?.method),
      };
    })
    .filter((e) => e.weight > 0 && e.equity !== null)
    .sort((a, b) => b.weight - a.weight);
  if (entries.length === 0) return null;

  const rows = entries.map((e) => [
    APPROACH_LABELS[e.key] ?? e.key,
    e.method ? esc(e.method.replace(/_/g, ' ')) : '—',
    e.enterprise === null ? '—' : formatCurrency(e.enterprise, currency, 0),
    formatCurrency(e.equity as number, currency, 0),
    formatPercent(e.weight, 0),
    formatCurrency((e.equity as number) * e.weight, currency, 0),
  ]);
  const concluded = num(results.equity_value);
  const weightTotal = entries.reduce((sum, e) => sum + e.weight, 0);

  /*
   * This paragraph asserted "on a marketable, controlling basis" unconditionally,
   * and for the typical 409A it is false — most of the weight sits on a backsolve
   * and on guideline multiples, neither of which produces a controlling value.
   * Exhibit H already stopped saying it (see `discountExhibit`); saying it here
   * as well left the two schedules contradicting each other in one document.
   * Where the engine has classified the mix, Exhibit B-1 prints it and this
   * sentence defers to it; where it has not, the original wording stands, since
   * nothing has been measured that would justify replacing it.
   */
  const classified = record(record(results.discounts)?.dloc_detail)?.approach_levels !== undefined;

  return section(SCHEDULE.B, [
    P(
      (classified
        ? 'Each approach indicates a value for total equity at the level of value its inputs ' +
          'carry, which is not the same for all four — Exhibit B-1 sets out which. '
        : 'Each approach indicates a value for total equity on a marketable, controlling basis. ') +
        'The concluded equity value is the weighted average of the indications, with weights ' +
        'reflecting the relevance and reliability of each approach to this company at this stage.',
    ),
    table({
      head: ['Approach', 'Method', 'Enterprise value', 'Equity value', 'Weight', 'Weighted'],
      rows,
      foot: [
        'Concluded equity value',
        '',
        '',
        '',
        formatPercent(weightTotal, 0),
        concluded === null ? '—' : formatCurrency(concluded, currency, 0),
      ],
    }),
    // Below the reconciliation rather than beside it: the adjustment is applied
    // to one indication before it is weighted, so a reader meets the weighted
    // table first and then the working behind the one figure that moved.
    ...movementBlock(results, approaches, ctx),
  ]);
}

/**
 * The market-movement adjustment, where one was applied.
 *
 * The backsolve indication in the table above is the *adjusted* figure, because
 * that is what was weighted. Printing only the adjusted one would hide the
 * single most contestable step in the reconciliation: the round transacted at a
 * price, and this valuation concluded that the price means something different
 * today. Both figures and the factor between them are set out, so the
 * adjustment can be disagreed with rather than merely noticed.
 *
 * Empty when no benchmark was supplied, which is the common case — a valuation
 * dated close to its round has nothing to adjust for, and a row reading
 * "1.0000x" would imply somebody measured one.
 */
function movementBlock(
  results: Record<string, unknown>,
  approaches: Record<string, unknown>,
  ctx: ExhibitContext,
): string[] {
  const movement = record(results.market_movement);
  if (!movement) return [];
  const backsolve = record(approaches.opm_backsolve);
  const before = num(backsolve?.unadjusted_equity_value);
  const after = num(backsolve?.equity_value);
  const factor = num(movement.factor);
  if (factor === null) return [];

  const indexName = text(movement.index_name);
  const indexReturn = num(movement.index_return);
  const beta = num(movement.beta);
  const start = num(movement.index_start);
  const end = num(movement.index_end);
  const from = text(movement.period_start);
  const to = text(movement.period_end);

  const rows: string[][] = [];
  if (before !== null) {
    rows.push([
      'Indicated equity value — last round, unadjusted',
      formatCurrency(before, ctx.currency, 0),
      'Backsolve to the round price per share',
    ]);
  }
  // Index *levels*, not multiples — `ratio` would suffix them with an "x" and
  // print the S&P at "4812.60x".
  const level = (v: number) => INT.format(Math.round(v * 100) / 100);
  rows.push([
    `Benchmark${indexName ? ` — ${esc(indexName)}` : ''}`,
    start !== null && end !== null ? `${level(start)} → ${level(end)}` : '—',
    from && to ? `${esc(from)} to ${esc(to)}` : 'Round date to valuation date',
  ]);
  if (indexReturn !== null) {
    rows.push(['Benchmark return over the period', formatPercent(indexReturn), 'End ÷ start − 1']);
  }
  if (beta !== null) {
    rows.push([
      'Sensitivity to the benchmark (β)',
      beta.toFixed(2),
      'Elasticity of the subject to the benchmark',
    ]);
  }
  rows.push(['Adjustment factor', ratio(factor), '1 + β × benchmark return']);

  return [
    P(
      'The option-pricing backsolve reads a value out of a dated financing round. Where time has ' +
        'passed between that round and the valuation date, the indication is moved by the return of ' +
        'a public benchmark over the same interval, geared by the subject’s sensitivity to it.',
    ),
    table({
      head: ['Market movement adjustment', 'Value', 'Basis'],
      rows,
      foot: [
        'Indicated equity value — last round, as adjusted',
        after === null ? '—' : formatCurrency(after, ctx.currency, 0),
        'Carried into the weighting above',
      ],
    }),
  ];
}

// ── Exhibit B-1 — level of value ─────────────────────────────────────────────

/**
 * The level of value each approach delivers, as the engine classifies it.
 *
 * `dloc.LEVEL_OF_VALUE_BY_APPROACH` is the authority and is deliberately not
 * restated here — this map only turns its vocabulary into the phrase an
 * appraisal report uses for it. A level the engine adds later prints as itself
 * rather than as a blank cell, which is the failure mode a second hand-kept
 * copy of the classification would have instead.
 */
const LEVEL_OF_VALUE_NAMES: Record<string, string> = {
  control: 'Control, marketable',
  minority: 'Minority, marketable',
  unknown: 'Not classified',
};

/** Why an approach arrives at the level it does, in one clause. */
const LEVEL_OF_VALUE_BASIS: Record<string, string> = {
  asset:
    'The adjusted net asset value of the whole enterprise — a figure only a holder able to direct ' +
    'the assets could realise',
  income:
    'The present value of the whole enterprise’s cash flows, discounted at a rate a controlling ' +
    'owner would require',
  market:
    'Guideline public company multiples are struck on minority trading prices, so the indication ' +
    'arrives already at a minority level',
  opm_backsolve:
    'The backsolve inverts the price a minority investor paid for a preferred share, so the ' +
    'indication arrives already at a minority level',
};

/**
 * Exhibit B-1 — at what level of value the weighted equity value arrived.
 *
 * Exhibit B reconciles four approaches into one equity value and, until this
 * schedule existed, said they were all "on a marketable, controlling basis".
 * For the typical 409A that is not true, and the untruth is the one that most
 * often costs a number: a discount for lack of control steps a value from
 * control down to marketable minority, so applied to an indication that was
 * already at a minority level it discounts twice for one thing. Nothing about
 * the result looks wrong — it is a plausible per-share figure that is simply
 * too low — which is exactly why it needs a page rather than a database column.
 *
 * The engine measures the mix (`dloc.minority_basis_share`, fed the very
 * `weight_by_approach` map that produced the weighted equity value) and records
 * it on `discounts.dloc_detail`. Exhibit H reads one number out of it to decide
 * whether to call its opening line "controlling", and every other figure the
 * engine computed for this — which approach sits at which level, and what share
 * of the value each side accounts for — reached no reader at all. This is that
 * working, printed beside the weights it is derived from.
 *
 * Conditional on the engine having something to say. `level_of_value_detail`
 * returns nothing when there are no approach weights to read — the PWERM path
 * derives equity value from its own exit scenarios, and a guess about its level
 * would be worse than silence — and nothing when the concluded DLOC is zero,
 * since a discount that was not applied cannot have been applied twice. Both
 * cases drop the schedule rather than printing a table with no finding in it.
 */
export function levelOfValueExhibit(
  results: Record<string, unknown>,
  _ctx: ExhibitContext,
): ReportPdfSection | null {
  const discounts = record(results.discounts);
  const detail = record(discounts?.dloc_detail);
  const levels = record(detail?.approach_levels);
  const minority = num(detail?.minority_basis_weight);
  if (!levels || minority === null) return null;

  const control = num(detail?.control_basis_weight) ?? 1 - minority;
  const approaches = record(results.approaches) ?? {};
  const dloc = num(discounts?.dloc) ?? 0;

  const entries = Object.entries(levels)
    .map(([key, raw]) => ({
      key,
      level: text(raw) ?? 'unknown',
      weight: num(record(approaches[key])?.weight),
    }))
    // The weighted ones, heaviest first, matching Exhibit B's own ordering so
    // the two tables can be read down alongside each other.
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  if (entries.length === 0) return null;

  const rows = entries.map((e) => [
    APPROACH_LABELS[e.key] ?? esc(e.key),
    e.weight === null ? '—' : formatPercent(e.weight, 0),
    LEVEL_OF_VALUE_NAMES[e.level] ?? esc(e.level),
    LEVEL_OF_VALUE_BASIS[e.key] ?? '',
  ]);

  const parts: string[] = [
    P(
      'A valuation approach does not simply produce a number: it produces a number at a level of ' +
        'value, and which level depends on what the approach was struck on. The discounts in ' +
        'Exhibit H step the concluded value down that ladder — control to marketable minority, ' +
        'then marketable minority to non-marketable minority — so the level the weighted equity ' +
        'value arrived at decides which of those steps there is still room to take.',
    ),
    table({
      head: ['Approach', 'Weight', 'Level of value indicated', 'Basis'],
      rows,
      foot: [
        'Weighted equity value',
        formatPercent(minority + control, 0),
        `${formatPercent(minority, 0)} minority, ${formatPercent(control, 0)} control`,
        '',
      ],
    }),
  ];

  /*
   * The finding, where there is one. `double_counts_minority` is the engine's
   * own threshold judgement (a majority of the weight arriving at a minority
   * level) and its `note` states the figure; both are printed as it wrote them
   * rather than re-derived, so this page cannot disagree with the pre-flight
   * warning the analyst saw about the same calculation.
   */
  if (detail?.double_counts_minority === true) {
    parts.push(
      P(
        `<strong>A discount for lack of control of ${formatPercent(dloc)} has been applied to a ` +
          `value that is ${formatPercent(minority, 0)} minority-based.</strong> ` +
          (text(detail.note) ??
            'A discount for lack of control applied to that portion discounts a second time for a ' +
              'control the value never included.') +
          ' The discount is the appraiser’s conclusion and stands as taken; it is disclosed here ' +
          'so that a reader can weigh it rather than discover it.',
      ),
    );
  } else {
    parts.push(
      P(
        `${formatPercent(control, 0)} of the weighted equity value arrived at a control level, so ` +
          `the discount for lack of control of ${formatPercent(dloc)} in Exhibit H is taken ` +
          'predominantly against value that stood at that level. The remainder was already at a ' +
          'marketable minority level and is disclosed above rather than adjusted for separately.',
      ),
    );
  }

  return section(SCHEDULE['B-1'], parts);
}

// ── Exhibit B-2 — the bridge from last year's conclusion to this one's ───────

/** `2026-06-30`, however the driver handed the date back. */
function isoDay(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * One line of the calibration trail, as the exhibit reads it.
 *
 * The engine names its steps; this names what each one *is* to a reader, and
 * the mapping is exhaustive rather than defaulting, so a step the engine grows
 * later reads as itself instead of silently printing under someone else's
 * label.
 */
function calibrationRow(
  step: RollforwardRunRow['calibration_steps'][number],
  run: RollforwardRunRow,
  currency: string,
): string[] {
  const value = formatCurrency(step.value, currency, 0);
  switch (step.step) {
    case 'prior_equity_value':
      return [
        'Prior concluded equity value',
        `${run.prior_valuation_number ? `${esc(run.prior_valuation_number)}, ` : ''}` +
          `valued as of ${isoDay(run.prior_valuation_date)}`,
        value,
      ];
    case 'time_accretion': {
      const rate = step.annual_rate ?? run.annual_accretion;
      const years = step.years ?? run.years_elapsed;
      return [
        `Calibration to ${isoDay(run.new_valuation_date)}`,
        `${formatPercent(rate, 1)} per annum over ${years.toFixed(2)} years` +
          (step.factor === undefined ? '' : ` (factor ${step.factor.toFixed(4)}x)`),
        value,
      ];
    }
    case 'new_round_post_money':
      return [
        'New priced round, post-money',
        'An arm’s-length price at the new date supersedes the calibration anchor',
        value,
      ];
    case 'adjustment':
      return [esc(step.label ?? 'Adjustment'), 'Analyst adjustment to the calibrated value', value];
    default:
      return [esc(step.step), '', value];
  }
}

/**
 * Exhibit B-2 — the prior 409A's concluded equity value, carried to this date.
 *
 * When a company re-values without a new priced round, the prior appraisal's
 * backsolve equity value is the one figure on the engagement that was
 * calibrated to an arm's-length transaction. A new valuation that does not
 * start from it has thrown away its best evidence, and — the part that shows up
 * in an audit — has no answer to "why is this different from last year's".
 *
 * The AICPA practice aid treats the calibration roll-forward as the expected
 * treatment for exactly this case, and the platform's own params table has
 * carried a `rolling_forward` flag since its first migration. Neither produced
 * a word in the deliverable until this schedule.
 *
 * Three things are printed and the third is the one a reviewer turns to first:
 *
 *   * the calibration trail, step by step, because the substance of the
 *     disclosure is the arithmetic between the two numbers and not the numbers;
 *   * every difference the engine detected between the two engagements' inputs,
 *     material or not — an immaterial one is the record that the question was
 *     asked;
 *   * how the rolled anchor compares to the equity value this valuation
 *     actually concluded. They are not the same figure and are not meant to be:
 *     the anchor is an input to the allocation, the conclusion comes out of the
 *     weighted approaches in Exhibit B. Where they diverge materially, that
 *     divergence is the finding.
 */
export function rollforwardExhibit(
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const run = ctx.rollforward;
  if (!run) return null;
  // Adopted or nothing. An unapplied run describes an anchor the calculation
  // did not use, and a schedule claiming the conclusion bridges from it would
  // be describing a different valuation. The loader filters for this too; both
  // check, because either one alone is a single point of failure for a claim
  // the report makes in the client's name.
  if (run.applied_at === null) return null;
  const { currency } = ctx;

  const steps = run.calibration_steps.map((s) => calibrationRow(s, run, currency));
  if (steps.length === 0) return null;

  const changes = run.material_changes.map((c) => [
    esc(c.field.replace(/_/g, ' ')),
    c.material ? 'Material' : 'Not material',
    esc(c.detail),
  ]);

  const concluded = num(results.equity_value);
  const drift =
    concluded !== null && run.rolled_equity_value > 0
      ? (concluded - run.rolled_equity_value) / run.rolled_equity_value
      : null;

  return section(SCHEDULE['B-2'], [
    P(
      `This valuation is a roll-forward of a prior appraisal rather than an independent re-derivation ` +
        `of value from a new market transaction. The prior concluded equity value of ` +
        `<strong>${formatCurrency(run.prior_equity_value, currency, 0)}</strong> as of ` +
        `${isoDay(run.prior_valuation_date)} was calibrated to the last arm’s-length round, and is ` +
        `carried forward to ${isoDay(run.new_valuation_date)} — ${run.years_elapsed.toFixed(2)} years ` +
        'later — as the anchor for the allocation. The steps below are that bridge.',
    ),
    table({
      head: ['Step', 'Basis', 'Equity value'],
      rows: steps,
      foot: [
        'Rolled equity value',
        `Anchor adopted for this valuation as of ${isoDay(run.new_valuation_date)}`,
        formatCurrency(run.rolled_equity_value, currency, 0),
      ],
    }),
    changes.length > 0
      ? P(
          'The following differences between the two engagements were examined in deciding whether a ' +
            'roll-forward remained appropriate. A change marked material is one that, on its own, would ' +
            'warrant a full re-derivation of value rather than a calibration.',
        )
      : P(
          'No difference between the two engagements’ inputs was found that would warrant a full ' +
            're-derivation of value in place of this calibration.',
        ),
    changes.length > 0 ? table({ head: ['Item', 'Assessment', 'Detail'], rows: changes }) : null,
    run.requires_full_revaluation
      ? P(
          '<strong>One or more of the changes above is material.</strong> The calibrated value is ' +
            'therefore presented as evidence considered alongside the approaches in Exhibit B, and not ' +
            'as the conclusion; the concluded value is the weighted result of those approaches.',
        )
      : null,
    concluded !== null
      ? P(
          `The equity value concluded by this valuation is ` +
            `<strong>${formatCurrency(concluded, currency, 0)}</strong>, against the rolled anchor of ` +
            `${formatCurrency(run.rolled_equity_value, currency, 0)}` +
            (drift === null ? '.' : ` — a difference of ${drift > 0 ? '+' : ''}${formatPercent(drift, 1)}.`) +
            ' The two are not the same measurement: the anchor is an input to the allocation, and the ' +
            'concluded value is the weighted result of the approaches reconciled in Exhibit B.',
        )
      : null,
  ]);
}

// ── Exhibit C — income approach ──────────────────────────────────────────────

export function incomeExhibit(
  inputs: Record<string, unknown>,
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const approach = record(record(results.approaches)?.income);
  if (!approach) return null;
  const income = record(inputs.income) ?? {};
  const { currency } = ctx;

  const flows = list(income.free_cash_flows)
    .map(num)
    .filter((v): v is number => v !== null);
  const revenues = list(income.revenues)
    .map(num)
    .filter((v): v is number => v !== null);
  const rate = num(income.discount_rate);
  const growth = num(income.terminal_growth) ?? 0;

  /*
   * The two methodology choices come off the *result*, not off the inputs.
   *
   * The result is what the engine actually did; the inputs are what someone
   * asked for, and a report that reads the request describes a calculation that
   * may never have run. Both fields are absent on calculations stored before
   * the engine reported them, and absent means the default it had then and has
   * now — end-of-year discounting, Gordon terminal value — so an old engagement
   * re-rendered today still prints the exhibit it printed before.
   */
  const midYear = approach.mid_year_convention === true;
  const terminalMethod = approach.terminal_method === 'exit_multiple' ? 'exit_multiple' : 'gordon';
  const terminalDetail = record(approach.terminal_detail) ?? {};

  // Under the mid-year convention a year's flows are discounted for n − 0.5
  // years, not n. Printing the end-of-year factor beside a mid-year present
  // value gives a reader a schedule whose own columns do not multiply out.
  const yearsTo = (i: number) => i + 1 - (midYear ? 0.5 : 0);

  const schedule =
    flows.length > 0
      ? table({
          head: [
            'Forecast year',
            ...(revenues.length === flows.length ? ['Revenue'] : []),
            'Free cash flow',
            'Discount factor',
            'Present value',
          ],
          rows: flows.map((fcf, i) => {
            const factor = rate === null ? null : Math.pow(1 + rate, yearsTo(i));
            return [
              `Year ${i + 1}`,
              ...(revenues.length === flows.length
                ? [formatCurrency(revenues[i] as number, currency, 0)]
                : []),
              formatCurrency(fcf, currency, 0),
              factor === null ? '—' : ratio(1 / factor),
              factor === null ? '—' : formatCurrency(fcf / factor, currency, 0),
            ];
          }),
          foot: [
            'Present value of the explicit forecast',
            ...(revenues.length === flows.length ? [''] : []),
            '',
            '',
            formatCurrency(num(approach.pv_explicit) ?? 0, currency, 0),
          ],
        })
      : null;

  const bridge: string[][] = [];
  const push = (label: string, value: number | null, note = '') => {
    if (value !== null) bridge.push([label, formatCurrency(value, currency, 0), note]);
  };
  if (rate !== null)
    bridge.push([
      'Discount rate',
      formatPercent(rate, 2),
      midYear
        ? 'Weighted average cost of capital, mid-year convention'
        : 'Weighted average cost of capital, end-of-year convention',
    ]);
  // A terminal growth rate is a Gordon input. Printing it against an
  // exit-multiple terminal value states an assumption the calculation never
  // made — and states it in the one column a reviewer reads to check the
  // method.
  if (terminalMethod === 'gordon') {
    bridge.push(['Terminal growth rate', formatPercent(growth, 2), 'Perpetual growth beyond the forecast']);
  } else {
    const multiple = num(terminalDetail.exit_multiple);
    const metric = num(terminalDetail.terminal_metric);
    const basis =
      typeof terminalDetail.terminal_metric_basis === 'string' ? terminalDetail.terminal_metric_basis : null;
    const basisLabel =
      basis === 'ebitda'
        ? 'terminal-year EBITDA'
        : basis === 'revenue'
          ? 'terminal-year revenue'
          : basis === 'fcff'
            ? 'terminal-year free cash flow'
            : 'the terminal-year metric';
    if (multiple !== null) bridge.push(['Exit multiple', ratio(multiple, 2), `Applied to ${basisLabel}`]);
    if (metric !== null)
      bridge.push([
        'Terminal-year metric',
        formatCurrency(metric, currency, 0),
        basisLabel.replace('terminal-year ', 'The ') + ' the multiple is struck on',
      ]);
  }
  push('Present value of the explicit forecast', num(approach.pv_explicit));
  push(
    'Present value of the terminal value',
    num(approach.pv_terminal),
    terminalMethod === 'gordon'
      ? 'Gordon growth on the final-year flow'
      : 'Exit multiple on the terminal-year metric',
  );
  push('Indicated enterprise value', num(approach.enterprise_value));
  push('Add: cash and equivalents', num(inputs.cash));
  push('Less: interest-bearing debt', num(inputs.debt) === null ? null : -(num(inputs.debt) as number));

  return section(SCHEDULE.C, [
    P(
      'The income approach discounts the projected free cash flows of the business to present value at ' +
        'a rate reflecting the risk of achieving them, and adds the present value of a terminal value ' +
        'representing the cash flows beyond the forecast period. The result is an enterprise value, ' +
        'bridged to equity by adding cash and deducting debt.',
    ),
    schedule,
    table({
      head: ['Component', 'Amount', 'Basis'],
      rows: bridge,
      foot: [
        'Indicated equity value — income approach',
        formatCurrency(num(approach.equity_value) ?? 0, currency, 0),
        '',
      ],
    }),
  ]);
}

// ── Exhibit C-1 — basis of the cash-flow forecast ────────────────────────────

/**
 * What produced the cash flows Exhibit C discounts.
 *
 * Exhibit C prints the stream, the discount factors and the present values —
 * everything the calculation did *with* the forecast, and nothing about where
 * the forecast came from. Until the projection was recorded (migration 0136)
 * there was nothing to print: the free cash flows were figures typed into a
 * form, and the honest answer to "what revenue, at what margin" was that the
 * report could not say. Appendix II states this in terms — management's
 * forecast "is set out where it is applied in Exhibit C" — and Exhibit C could
 * only ever set out the total.
 *
 * The relationship to Exhibit C is the one D-1 has with D and F-1 with F: the
 * supporting detail, immediately after the schedule it supports.
 *
 * The build is printed in the shape a financial statement is printed in — one
 * row per line, one column per year — because that is how a reader checks it,
 * and because the same convention already governs Appendix II. The arithmetic
 * is left visible rather than summarised: EBITDA to EBIT to NOPAT, then the two
 * deductions, so a reviewer can follow the fall to free cash flow without
 * recomputing it.
 *
 * Printed only where a projection was run. An engagement whose analyst entered
 * the stream by hand gets no exhibit rather than a schedule of assumptions
 * nobody made — and the report reads exactly as it did before.
 */

/** A forecast wider than this is squeezed past readability by the renderer. */
const MAX_FORECAST_COLUMNS = 12;

const PROJECTION_LINES: Array<[string, keyof ProjectionYear]> = [
  ['Revenue', 'revenue'],
  ['Cost of goods sold', 'cogs'],
  ['Operating expense', 'opex'],
  ['EBITDA', 'ebitda'],
  ['Depreciation and amortisation', 'da'],
  ['EBIT', 'ebit'],
  ['NOPAT', 'nopat'],
  ['Add back: depreciation and amortisation', 'da'],
  ['Less: capital expenditure', 'capex'],
  ['Less: increase in net working capital', 'delta_nwc'],
];

/** The label a stored ratio assumption prints under, in the order they read. */
const PROJECTION_RATIOS: Array<[string, string]> = [
  ['cogs_pct', 'Cost of goods sold'],
  ['opex_pct', 'Operating expense'],
  ['da_pct', 'Depreciation and amortisation'],
  ['capex_pct', 'Capital expenditure'],
  ['nwc_pct', 'Net working capital held'],
];

/**
 * A rate assumption as the run stored it — one figure, or one per year.
 *
 * A per-year vector is stated as its range rather than listed: the years are
 * the columns of the schedule below, and repeating them in the assumption table
 * would be the same forecast twice at different precisions.
 */
function rateAssumption(value: unknown): string | null {
  const single = num(value);
  if (single !== null) return formatPercent(single, 1);
  const vector = list(value)
    .map(num)
    .filter((v): v is number => v !== null);
  if (vector.length === 0) return null;
  const lo = Math.min(...vector);
  const hi = Math.max(...vector);
  return lo === hi ? formatPercent(lo, 1) : `${formatPercent(lo, 1)} to ${formatPercent(hi, 1)}, by year`;
}

export function projectionExhibit(
  inputs: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const row = ctx.projection;
  // As in F-1: a shape this exhibit cannot read drops C-1, rather than
  // throwing out of a render that had a finished report in it.
  if (!row || !Array.isArray(row.projections) || !Array.isArray(row.free_cash_flows)) return null;
  if (row.projections.length === 0) return null;
  const { currency } = ctx;
  const assumed = record(row.inputs) ?? {};

  const years = row.projections.slice(0, MAX_FORECAST_COLUMNS);
  const money = (v: number) => formatCurrency(v, currency, 0);

  const basis: string[][] = [
    [
      'Forecast method',
      row.method === 'driver'
        ? 'Bottom-up — each line forecast by year'
        : 'Top-down — revenue grown from a base, expenses as a share of it',
    ],
    ['Explicit forecast period', `${row.years} ${row.years === 1 ? 'year' : 'years'}`],
  ];
  if (row.method === 'growth') {
    const base = num(assumed.base_revenue);
    if (base !== null) basis.push(['Base revenue', money(base)]);
    const growth = rateAssumption(assumed.revenue_growth);
    if (growth !== null) basis.push(['Revenue growth', growth]);
    for (const [key, label] of PROJECTION_RATIOS) {
      const rate = rateAssumption(assumed[key]);
      if (rate !== null) basis.push([`${label}, as a share of revenue`, rate]);
    }
  }
  basis.push(['Tax rate applied to EBIT', formatPercent(row.tax_rate, 1)]);

  const buildRows = PROJECTION_LINES.map(([label, key]) => [esc(label), ...years.map((p) => money(p[key]))]);

  /*
   * Whether the forecast below is the one the calculation ran on.
   *
   * Read off the calculation's own inputs rather than off `applied_at`: a run
   * can be adopted and then superseded by a hand edit to the financial model,
   * and the adoption flag would still say it was adopted. The stream Exhibit C
   * discounts is the fact, and this exhibit sits under it.
   */
  const discounted = list(record(inputs.income)?.free_cash_flows)
    .map(num)
    .filter((v): v is number => v !== null);
  const same =
    discounted.length === row.free_cash_flows.length &&
    discounted.every((v, i) => Math.abs(v - (row.free_cash_flows[i] ?? 0)) < 1e-6);

  const adoption = same
    ? null
    : row.applied_at === null
      ? P(
          'This forecast has <strong>not been adopted</strong> as the valuation’s cash flows. The income ' +
            'approach was run on the stream set out in <strong>Exhibit C</strong>, and the build below is ' +
            'presented as corroboration rather than as the source of those figures.',
        )
      : P(
          'The cash flows discounted in <strong>Exhibit C</strong> differ from this forecast: the financial ' +
            'model was amended after the forecast was adopted. Exhibit C states the stream the conclusion ' +
            'rests on; the build below is the forecast as it was projected.',
        );

  const truncated =
    row.projections.length > years.length
      ? P(
          `The forecast runs to ${row.projections.length} years. The first ${years.length} are set out ` +
            'above; the full stream is discounted in <strong>Exhibit C</strong>.',
        )
      : null;

  return section(SCHEDULE['C-1'], [
    P(
      'The free cash flows discounted in <strong>Exhibit C</strong> are not an assumption in themselves. ' +
        'They are derived from a forecast of revenue and of the costs, capital expenditure and working ' +
        'capital required to earn it, on the assumptions set out below. Free cash flow to the firm is ' +
        'unlevered — it is struck before financing, so the capital structure enters the analysis through ' +
        'the discount rate rather than through the cash flows.',
    ),
    table({ head: ['Forecast assumption', 'Value'], rows: basis }),
    table({
      head: ['', ...years.map((p) => `Year ${p.year}`)],
      rows: buildRows,
      foot: ['Free cash flow to the firm', ...years.map((p) => money(p.fcff))],
    }),
    truncated,
    row.terminal_value !== null
      ? P(
          `A ${row.terminal_method === 'exit_multiple' ? 'terminal value struck on an exit multiple' : 'Gordon growth terminal value'} ` +
            `of ${money(row.terminal_value)} was computed with this forecast. It is stated here for ` +
            'completeness and is <strong>not</strong> the terminal value in the conclusion: the income ' +
            'approach strikes its own from the terminal method and growth rate in <strong>Exhibit C</strong>, ' +
            'and counting both would carry the terminal value into the valuation twice.',
        )
      : null,
    adoption,
  ]);
}

// ── Exhibit D — market approach ──────────────────────────────────────────────

export function marketExhibit(
  inputs: Record<string, unknown>,
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const approach = record(record(results.approaches)?.market);
  if (!approach) return null;
  const { currency } = ctx;

  const multiples = list(approach.multiples)
    .map(num)
    .filter((v): v is number => v !== null);
  const selected = num(approach.selected_multiple);
  const metric = num(approach.metric);

  const observed =
    multiples.length > 0
      ? table({
          head: ['Guideline observation', 'Multiple'],
          rows: multiples
            .slice()
            .sort((a, b) => a - b)
            .map((m, i) => [`Comparable ${i + 1}`, ratio(m, 2)]),
          foot: ['Selected multiple (median)', selected === null ? '—' : ratio(selected, 2)],
        })
      : null;

  const bridge: string[][] = [];
  if (metric !== null)
    bridge.push(['Company metric', formatCurrency(metric, currency, 0), 'As selected for the analysis']);
  if (selected !== null)
    bridge.push(['Selected multiple', ratio(selected, 2), 'Median of the guideline set']);
  const ev = num(approach.enterprise_value);
  if (ev !== null)
    bridge.push(['Indicated enterprise value', formatCurrency(ev, currency, 0), 'Metric × multiple']);
  const cash = num(inputs.cash);
  const debt = num(inputs.debt);
  if (cash !== null) bridge.push(['Add: cash and equivalents', formatCurrency(cash, currency, 0), '']);
  if (debt !== null) bridge.push(['Less: interest-bearing debt', formatCurrency(-debt, currency, 0), '']);

  return section(SCHEDULE.D, [
    P(
      'The market approach applies valuation multiples observed for comparable companies and ' +
        'transactions to the corresponding metric of the subject company. The median of the guideline ' +
        'set is selected, which limits the influence of any single outlying observation.',
    ),
    observed,
    table({
      head: ['Component', 'Amount', 'Basis'],
      rows: bridge,
      foot: [
        'Indicated equity value — market approach',
        formatCurrency(num(approach.equity_value) ?? 0, currency, 0),
        '',
      ],
    }),
  ]);
}

// ── Exhibit D-1 — the guideline company set ──────────────────────────────────

/**
 * The peer set behind Exhibit D, named.
 *
 * Exhibit D prints the multiples as "Comparable 1 … Comparable n", which is
 * every figure a reviewer needs to re-derive the value and none of what they
 * need to challenge it. The question a market approach is challenged on is not
 * "what was the median" — it is "which companies, and why not the ones you left
 * out". Both halves are on this schedule, and the excluded half carries its
 * reason, which is the whole point of storing the rows.
 *
 * Numbered D-1 rather than taking a letter of its own: the eight lettered
 * exhibits are cited by letter in reports already issued, and renumbering them
 * to insert a schedule would make every one of those citations point one
 * exhibit to the left.
 */
/**
 * The peer rows reduced to what this exhibit can print.
 *
 * Every other schedule in this module reads its payload through `record`,
 * `num` and `text` and degrades to an em-dash; this one indexed and called
 * straight into `peers`, so a `peers` that was not an array — or a row missing
 * its `multiples` — did not drop Exhibit D-1, it threw out of the render and
 * took the whole report with it. The peer set is loaded from the database
 * (migration 0119) so the shape is ordinarily right; the cost of it being
 * wrong was the entire deliverable, which is the wrong price for one bad row.
 */
function usablePeers(peers: unknown): ExhibitPeer[] {
  return list(peers)
    .map(record)
    .filter((p): p is Record<string, unknown> => p !== null)
    .map((p) => {
      const multiples: Partial<Record<MultipleKey, number | null>> = {};
      const raw = record(p.multiples) ?? {};
      for (const key of Object.keys(MULTIPLE_LABELS) as MultipleKey[]) {
        multiples[key] = num(raw[key]);
      }
      return {
        ticker: text(p.ticker),
        name: text(p.name) ?? '—',
        included: p.included === true,
        exclude_reason: text(p.exclude_reason),
        source: text(p.source) ?? '',
        score: num(p.score),
        multiples,
        figures_source: text(p.figures_source),
        figures_as_of: text(p.figures_as_of) ?? (p.figures_as_of instanceof Date ? p.figures_as_of : null),
      };
    });
}

export function peerSetExhibit(
  peers: readonly ExhibitPeer[] | undefined,
  results: Record<string, unknown>,
): ReportPdfSection | null {
  const usable = usablePeers(peers);
  if (usable.length === 0) return null;
  // No market approach in the run means no schedule: a peer set an analyst
  // screened but did not weight into the conclusion is working material, and
  // printing it as a supporting exhibit overstates its role in the opinion.
  if (!record(record(results.approaches)?.market)) return null;

  const included = usable.filter((p) => p.included);
  const excluded = usable.filter((p) => !p.included);
  // Which of the four quotients to print: whichever the included set actually
  // has. A column of dashes tells a reader nothing about the comps.
  const columns = (Object.keys(MULTIPLE_LABELS) as MultipleKey[]).filter((key) =>
    included.some((p) => typeof p.multiples[key] === 'number'),
  );

  const label = (p: ExhibitPeer) => (p.ticker ? `${esc(p.name)} (${esc(p.ticker)})` : esc(p.name));
  const cell = (value: number | null | undefined) => (typeof value === 'number' ? ratio(value, 2) : '—');

  const selected =
    included.length > 0
      ? table({
          head: ['Guideline company', ...columns.map((k) => MULTIPLE_LABELS[k]), 'Screen score'],
          rows: included.map((p) => [
            label(p),
            ...columns.map((k) => cell(p.multiples[k])),
            p.score === null ? '—' : p.score.toFixed(2),
          ]),
        })
      : null;

  const rejected =
    excluded.length > 0
      ? table({
          head: ['Company considered', 'Basis for exclusion'],
          rows: excluded.map((p) => [label(p), esc(p.exclude_reason ?? 'Not stated')]),
        })
      : null;

  /*
   * Where the figures behind these multiples came from.
   *
   * A reader cannot check a multiple without knowing whether its inputs were
   * observed in the market or taken from a maintained reference table, and
   * until migration 0133 the exhibit could not tell them because nothing
   * recorded it. Stated as a sentence under the schedule rather than a column
   * per row: it is one fact about the set in the ordinary case, and a column
   * of identical cells is noise.
   */
  const provenance = (() => {
    if (included.length === 0) return null;
    const kinds = new Set(included.map((p) => p.figures_source ?? 'snapshot'));
    const asOf = included
      .map((p) => (p.figures_as_of ? new Date(p.figures_as_of) : null))
      .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const stamp = asOf ? ` The figures were current as at ${asOf.toISOString().slice(0, 10)}.` : '';

    if (kinds.size > 1) {
      return P(
        'The financial figures behind these multiples come from more than one source across the ' +
          'set — observed market data, the maintained reference set, and analyst entry are all ' +
          `represented.${stamp}`,
      );
    }
    const only = [...kinds][0];
    if (only === 'live')
      return P(
        'The financial figures behind these multiples are observed market data for the companies ' +
          `named.${stamp}`,
      );
    if (only === 'analyst')
      return P(
        'The financial figures behind these multiples were entered by the analyst from the ' +
          `sources cited in the workpapers.${stamp}`,
      );
    return P(
      'The financial figures behind these multiples are drawn from a maintained reference set of ' +
        'public-company data rather than from a real-time market feed, and are indicative of ' +
        `scale and trading level rather than quoted as at a moment.${stamp}`,
    );
  })();

  return section(SCHEDULE['D-1'], [
    P(
      'The guideline companies below were screened on industry classification, scale, growth and ' +
        'margin profile. The multiples in Exhibit D are struck from the companies retained; the ' +
        'companies considered and set aside are listed with the basis on which each was excluded.',
    ),
    selected,
    provenance,
    excluded.length > 0
      ? P('The following companies were considered and are not reflected in the concluded multiples.')
      : null,
    rejected,
  ]);
}

// ── Exhibit E — asset approach ───────────────────────────────────────────────

export function assetExhibit(results: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const approach = record(record(results.approaches)?.asset);
  if (!approach) return null;
  const { currency } = ctx;
  const method = text(approach.method);

  const rows: string[][] = [];
  const assets = num(approach.total_assets);
  const liabilities = num(approach.total_liabilities);
  if (assets !== null) rows.push(['Total assets', formatCurrency(assets, currency, 0)]);
  if (liabilities !== null) rows.push(['Less: total liabilities', formatCurrency(-liabilities, currency, 0)]);
  if (rows.length === 0) {
    rows.push([
      'Cost to replicate the business',
      formatCurrency(num(approach.equity_value) ?? 0, currency, 0),
    ]);
  }

  return section(SCHEDULE.E, [
    P(
      method === 'cost_to_replicate'
        ? 'The asset approach is applied on a cost-to-replicate basis: the cost a market participant ' +
            'would incur to reproduce the assembled assets of the business.'
        : 'The asset approach is applied on a net-asset-value basis: the book value of total assets ' +
            'less total liabilities as of the valuation date.',
    ),
    table({
      head: ['Component', 'Amount'],
      rows,
      foot: [
        'Indicated equity value — asset approach',
        formatCurrency(num(approach.equity_value) ?? 0, currency, 0),
      ],
    }),
  ]);
}

// ── Exhibit F — allocation ───────────────────────────────────────────────────

function participantSummary(participants: Record<string, unknown>): string {
  return (
    Object.entries(participants)
      .map(([name, share]) => ({ name, share: num(share) ?? 0 }))
      .filter((p) => p.share > 0)
      .sort((a, b) => b.share - a.share)
      .map((p) => `${esc(p.name)} ${formatPercent(p.share, 1)}`)
      .join(' · ') || '—'
  );
}

/**
 * How the concluded equity value was split across the cap table.
 *
 * The breakpoint schedule is the exhibit an auditor asks for by name and the
 * one the engine has always computed and never shown: `allocation.breakpoints`
 * is a list of exit-value ranges, who shares each one and what the tranche is
 * worth under the option-pricing model. Everything else here is the same
 * allocation described at whatever resolution the method used supports — the
 * aggregate branches have a single breakpoint and no schedule to print.
 */
export function allocationExhibit(
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const allocation = record(results.allocation);
  if (!allocation) return null;
  const { currency } = ctx;
  const methodKey = String(results.allocation_method ?? allocation.method ?? '').toLowerCase();
  const label =
    ALLOCATION_LABELS[methodKey] ?? ALLOCATION_LABELS[String(allocation.method ?? '')] ?? methodKey;

  const assumptions = record(results.assumptions);
  const inputRows: string[][] = [];
  const volatility = num(assumptions?.volatility);
  const rf = num(assumptions?.risk_free_rate);
  const t = num(assumptions?.time_to_exit_years) ?? num(assumptions?.expected_time_to_exit_years);
  if (volatility !== null) inputRows.push(['Expected volatility (σ)', formatPercent(volatility, 1)]);
  if (t !== null) inputRows.push(['Expected time to liquidity (T)', `${t.toFixed(2)} years`]);
  if (rf !== null) inputRows.push(['Risk-free rate (r)', formatPercent(rf, 2)]);
  const equity = num(results.equity_value);
  if (equity !== null) inputRows.push(['Equity value allocated', formatCurrency(equity, currency, 0)]);

  const breakpoints = list(allocation.breakpoints)
    .map(record)
    .filter((b): b is Record<string, unknown> => b !== null);
  const schedule =
    breakpoints.length > 0
      ? table({
          head: ['Tranche', 'From', 'To', 'Value', 'Participants'],
          rows: breakpoints.map((b, i) => {
            const from = num(b.from);
            const to = num(b.to);
            return [
              String(i + 1),
              from === null ? '—' : formatCurrency(from, currency, 0),
              to === null ? 'and above' : formatCurrency(to, currency, 0),
              formatCurrency(num(b.value) ?? 0, currency, 0),
              participantSummary(record(b.participants) ?? {}),
            ];
          }),
        })
      : null;

  const classes = record(allocation.classes);
  const byClass = classes
    ? table({
        head: ['Class', 'Type', 'Shares', 'Allocated value', 'Value per share'],
        rows: Object.entries(classes).map(([name, raw]) => {
          const c = record(raw) ?? {};
          const count = num(c.shares);
          const value = num(c.value) ?? num(c.present_value);
          return [
            esc(name),
            text(c.kind) === 'option' ? 'Options' : text(c.kind) === 'preferred' ? 'Preferred' : 'Common',
            count === null ? '—' : shares(count),
            value === null ? '—' : formatCurrency(value, currency, 0),
            formatCurrency(num(c.per_share) ?? num(c.fmv_per_share) ?? 0, currency, 4),
          ];
        }),
      })
    : null;

  // The aggregate branches have no schedule; state the single breakpoint they
  // do have rather than leaving the exhibit with only a prose paragraph.
  const aggregate: string[][] = [];
  const breakpoint = num(allocation.breakpoint);
  if (breakpoint !== null)
    aggregate.push([
      'Breakpoint (aggregate liquidation preference)',
      formatCurrency(breakpoint, currency, 0),
    ]);
  const upside = num(allocation.upside_after_preference);
  if (upside !== null)
    aggregate.push(['Call value above the breakpoint', formatCurrency(upside, currency, 0)]);
  const fraction = num(allocation.common_fraction);
  if (fraction !== null) aggregate.push(["Common's share of the residual", formatPercent(fraction, 2)]);

  /*
   * A simulated allocation has to disclose what a closed-form one does not: how
   * many paths, drawn from which seed, and how precise the result is.
   *
   * The seed because a concluded value nobody can re-derive is not a
   * conclusion — a reviewer three years into an audit must be able to re-run
   * the engagement and get this figure back. The standard error because a
   * simulated number without one is a number pretending to be exact, and the
   * reader is entitled to see it against the fourth decimal the conclusion is
   * stated to.
   */
  const simulation: string[][] = [];
  const paths = num(allocation.paths);
  if (paths !== null) {
    simulation.push([
      'Simulated paths',
      new Intl.NumberFormat('en-US').format(Math.round(paths)) +
        (allocation.antithetic === true ? ' (antithetic pairs)' : ''),
    ]);
  }
  const seed = num(allocation.seed);
  if (seed !== null) simulation.push(['Random seed', String(Math.round(seed))]);
  const stdErr = num(allocation.standard_error_per_share);
  if (stdErr !== null) {
    simulation.push(['Standard error of the simulated value per share', formatCurrency(stdErr, currency, 6)]);
  }

  return section(SCHEDULE.F, [
    P(
      `Equity value is allocated across the capital structure using the <strong>${esc(label)}</strong>. ` +
        (breakpoints.length > 0
          ? 'Under the breakpoint method the payoff of each class is piecewise linear in exit value, so ' +
            'its expected value is the sum of Black-Scholes call spreads between consecutive ' +
            'breakpoints. The schedule below lists each tranche, its value, and the classes sharing it.'
          : 'The inputs to the allocation and the resulting value of each class are set out below.'),
    ),
    inputRows.length > 0 ? table({ head: ['Allocation input', 'Value'], rows: inputRows }) : null,
    aggregate.length > 0 ? table({ head: ['Component', 'Value'], rows: aggregate }) : null,
    simulation.length > 0 ? table({ head: ['Simulation parameter', 'Value'], rows: simulation }) : null,
    schedule,
    byClass,
  ]);
}

// ── Exhibit F-1 — selected volatility ────────────────────────────────────────

/**
 * Where the expected volatility came from.
 *
 * Exhibit F states the sigma the allocation ran on. Until this exhibit existed
 * that was the whole disclosure: a number in an inputs table, described in the
 * body as coming "from guideline companies" without naming one. Sigma drives
 * the allocation, every option-based DLOM and the ASC 718 assumptions table,
 * and it is the second thing a reviewing appraiser asks about.
 *
 * Printed only when a derivation was actually run (`domain/volatility.ts`).
 * An engagement whose analyst selected sigma by judgement gets no exhibit
 * rather than a schedule with one row in it — the judgement belongs in the
 * body, where it can be argued, and a table dressing it as a measurement would
 * be the opposite of what this is for.
 *
 * Three things the table has to carry that a median alone does not:
 *
 *   * every peer considered, with its own measurement, so the median is
 *     checkable rather than asserted;
 *   * the peers that were considered and not counted, with the reason — a
 *     dead price series and a ticker the feed could not serve are both "in the
 *     set, out of the measurement", and an exhibit that quietly omitted them
 *     would overstate the breadth of the estimate;
 *   * whether the derived figure is the one the calculation ran on. An
 *     estimate nobody adopted sitting under a heading in a signed report,
 *     beside an allocation struck on a different number, is a contradiction —
 *     so the exhibit says so in terms.
 */
export function volatilityExhibit(
  ctx: ExhibitContext,
  results: Record<string, unknown>,
): ReportPdfSection | null {
  const row = ctx.volatility;
  // The derivation is a database row, so the shape is ordinarily whatever the
  // repo selected — but this exhibit indexes straight into its arrays and
  // dates, and the cost of being wrong about that is the whole report render,
  // not this one schedule. Drop F-1 instead, which is what every other exhibit
  // here does with a shape it does not recognise.
  if (
    !row ||
    !Array.isArray(row.companies) ||
    !(row.window_start instanceof Date) ||
    !(row.window_end instanceof Date)
  ) {
    return null;
  }

  const applied = num(record(record(results.allocation)?.assumptions)?.volatility);
  const measured = row.companies.filter((c) => c.used);
  const windowStart = row.window_start.toISOString().slice(0, 10);
  const windowEnd = row.window_end.toISOString().slice(0, 10);

  const basis: string[][] = [
    ['Estimator', VOLATILITY_METHOD_LABELS[row.method]],
    ['Observation window', `${windowStart} to ${windowEnd}`],
    ['Annualization factor', `${row.periods_per_year} periods per year`],
    ['Guideline companies measured', String(measured.length)],
  ];
  if (row.time_to_exit_years !== null) {
    basis.push(['Expected time to liquidity', `${row.time_to_exit_years.toFixed(2)} years`]);
  }
  basis.push([
    'Confidence in the estimate',
    `${row.confidence.charAt(0).toUpperCase()}${row.confidence.slice(1)} — ${VOLATILITY_CONFIDENCE_NOTES[row.confidence]}`,
  ]);

  const distribution: string[][] = [];
  const push = (label: string, value: number | null) => {
    if (value !== null) distribution.push([label, formatPercent(value, 1)]);
  };
  push('Minimum', row.min_vol);
  push('Median', row.median_vol);
  push('Mean', row.mean_vol);
  push('Maximum', row.max_vol);
  if (row.coefficient_of_variation !== null) {
    distribution.push(['Coefficient of variation', ratio(row.coefficient_of_variation, 2)]);
  }

  // Descending, so the reader sees the spread the median sits inside rather
  // than the order the tickers happened to be screened in.
  const peerRows = [...row.companies]
    .sort((a, b) => b.volatility - a.volatility)
    .map((c) => [
      esc(c.ticker),
      formatPercent(c.volatility, 1),
      c.observations === undefined ? '—' : INT.format(c.observations),
      c.used ? 'Included' : 'Excluded',
    ]);

  const excludedRows = row.excluded.map((e) => [esc(e.ticker), esc(e.reason)]);

  // The one sentence the exhibit exists to be able to make — and the one place
  // it must not be softened. `applied` is read off the calculation's own
  // assumptions, so a mismatch is a fact about the run, not about the panel.
  const adoption =
    row.applied_at === null
      ? P(
          'This derivation has <strong>not been adopted</strong> as the valuation assumption. The ' +
            'allocation was run on the volatility selected by the analyst, and the figures above are ' +
            'presented as corroboration rather than as the source of the input.',
        )
      : applied !== null && Math.abs(applied - row.recommended) > 0.0001
        ? P(
            `The valuation applies <strong>${formatPercent(applied, 1)}</strong>, which departs from the ` +
              `derived ${formatPercent(row.recommended, 1)}. The basis for the departure is stated in the ` +
              'body of this report.',
          )
        : null;

  return section(SCHEDULE['F-1'], [
    P(
      'The expected volatility applied in the allocation is not an assumption of the subject company ' +
        'directly — a private company has no traded price series to measure. It is estimated from the ' +
        'observed return volatility of the guideline public companies, measured over the window below ' +
        'and taken at the median, which is robust to a single outlier peer.',
    ),
    table({ head: ['Basis of estimate', 'Value'], rows: basis }),
    peerRows.length > 0
      ? table({
          head: ['Guideline company', 'Annualized volatility', 'Observations', 'Treatment'],
          rows: peerRows,
          foot: [
            row.method === 'manual' ? 'Analyst selection' : 'Median of included peers — selected',
            formatPercent(row.recommended, 1),
            '',
            '',
          ],
        })
      : null,
    distribution.length > 0
      ? table({ head: ['Cross-sectional distribution', 'Value'], rows: distribution })
      : null,
    excludedRows.length > 0
      ? table({ head: ['Considered and not measured', 'Reason'], rows: excludedRows })
      : null,
    adoption,
  ]);
}

// ── Exhibit F-2 — what the conclusion does if the two soft inputs are wrong ──

/**
 * The aggregate liquidation preference the OPM strikes at.
 *
 * Read the same two ways `capitalizationExhibit` reads the cap table: the
 * class model when the engagement has share classes, and the single blended
 * preference when it does not. Null when neither is present, which drops the
 * exhibit — an OPM sensitivity with no strike is a Black-Scholes call on
 * nothing.
 */
function aggregatePreference(inputs: Record<string, unknown>): number | null {
  const classes = list(inputs.share_classes);
  if (classes.length > 0) {
    let total = 0;
    let sawOne = false;
    for (const raw of classes) {
      const c = record(raw);
      const p = num(c?.preference);
      if (p !== null) {
        total += p;
        sawOne = true;
      }
    }
    return sawOne ? total : null;
  }
  return num(inputs.liquidation_preference);
}

/**
 * `sensitivity.ts` is denominated in cents because the dashboard it was written
 * for deals in cents. A 409A concludes to four decimal places — the convention
 * `fmv_per_share` and Exhibit H both use — so passing cents would round $1.2345
 * to $1.23 and print a grid that disagrees with the conclusion it is testing.
 * The module's arithmetic is homogeneous in the two money inputs, so feeding it
 * ten-thousandths instead makes its integer rounding land on the fourth
 * decimal, and dividing back out is exact.
 */
const SENSITIVITY_SCALE = 10_000;

/**
 * The OPM as the sensitivity schedules re-strike it, or nothing.
 *
 * Every input or nothing. A grid struck on a defaulted volatility or a guessed
 * term would be a table of numbers with no relationship to the conclusion above
 * it, which is worse than the omission — and the allocation paths that do not
 * run an OPM (current-value, as-converted) legitimately have no sigma, so this
 * is the ordinary case rather than an error.
 *
 * Shared by F-2 and F-3 because the two schedules stress the same model on
 * different axes: they must either both be printable from a given calculation
 * or both be absent, and a second copy of this guard is how they would come to
 * disagree about which.
 */
function sensitivityBasis(
  inputs: Record<string, unknown>,
  results: Record<string, unknown>,
): OpmInputs | null {
  const assumptions = record(results.assumptions);
  const volatility = num(assumptions?.volatility);
  const termYears = num(assumptions?.time_to_exit_years);
  const riskFreeRate = num(assumptions?.risk_free_rate);
  const equityValue = num(results.equity_value);
  const commonShares = num(results.fully_diluted_common);
  const strike = aggregatePreference(inputs);
  const dlom = num(record(results.discounts)?.dlom) ?? 0;

  if (
    volatility === null ||
    termYears === null ||
    riskFreeRate === null ||
    equityValue === null ||
    commonShares === null ||
    strike === null ||
    volatility <= 0 ||
    termYears <= 0 ||
    commonShares <= 0
  ) {
    return null;
  }

  return {
    equityValueCents: equityValue * SENSITIVITY_SCALE,
    strikeCents: strike * SENSITIVITY_SCALE,
    volatility,
    termYears,
    riskFreeRate,
    commonShares,
    dlom,
  };
}

/**
 * Exhibit F-2 — the concluded value across a volatility × term grid.
 *
 * Every other schedule in this file reports what the model *did*. This one
 * reports how much that depended on two inputs nobody can observe.
 *
 * The allocation is a Black-Scholes call on total equity value, and two of its
 * inputs are judgements rather than measurements: the expected volatility
 * (estimated from guideline peers, which is what Exhibit F-1 argues) and the
 * expected time to a liquidity event (an opinion about a company's future). A
 * reviewer's first question about an OPM conclusion is what happens to it if
 * those two are wrong, and until now the deliverable had no answer — the grid
 * existed, tested, in `domain/sensitivity.ts`, but it was wired only to the
 * analyst's dashboard and never reached the client's report.
 *
 * The exhibit is not an alternative conclusion and says so: every cell but the
 * centre is a figure the valuation does *not* adopt. What it establishes is
 * the shape of the dependence — a conclusion that moves 3% across the whole
 * grid is robust, and one that doubles is a conclusion whose volatility
 * estimate is the whole valuation.
 */
export function sensitivityExhibit(
  inputs: Record<string, unknown>,
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const basis = sensitivityBasis(inputs, results);
  if (basis === null) return null;
  const { volatility, termYears } = basis;

  const grid = sensitivityGrid(basis);

  const money = (scaled: number) => formatCurrency(scaled / SENSITIVITY_SCALE, ctx.currency, 4);
  const signedPercent = (d: number) => `${d > 0 ? '+' : ''}${formatPercent(d, 1)}`;

  const head = ['Volatility', ...grid.terms.map((t) => `${t.toFixed(2)} yrs`)];
  const rows = grid.rows.map((row, i) => [
    formatPercent(grid.volatilities[i]!, 1),
    ...row.map((cell) =>
      // The base case is the conclusion, so it is marked rather than left for
      // the reader to locate by matching a number against an earlier page.
      cell.deltaFromBase === 0
        ? `<strong>${money(cell.fmvPerShareCents)}</strong> (base)`
        : `${money(cell.fmvPerShareCents)} (${signedPercent(cell.deltaFromBase)})`,
    ),
  ]);

  const flat = grid.rows.flat().map((c) => c.fmvPerShareCents);
  const low = Math.min(...flat);
  const high = Math.max(...flat);
  const base = grid.base.fmvPerShareCents;
  const spread = base > 0 ? (high - low) / base : 0;

  return section(SCHEDULE['F-2'], [
    P(
      'The allocation prices common as a call option on total equity value, and two of its inputs ' +
        'are estimates rather than observations: the expected volatility and the expected time to a ' +
        'liquidity event. The table below restates the concluded value per share across a range of ' +
        'both, holding every other input — equity value, the preference stack, the risk-free rate ' +
        'and the marketability discount — at the values the conclusion adopts.',
    ),
    table({
      head,
      rows,
      foot: [
        'Applied',
        ...grid.terms.map((t) =>
          Math.abs(t - termYears) < 0.005 ? `${formatPercent(volatility, 1)} at ${t.toFixed(2)} yrs` : '',
        ),
      ],
    }),
    P(
      `Across the range tested the concluded value runs from <strong>${money(low)}</strong> to ` +
        `<strong>${money(high)}</strong>, a spread of ${formatPercent(spread, 1)} of the concluded ` +
        `${money(base)}. <strong>No cell other than the base case is adopted by this valuation.</strong> ` +
        'The table is presented so that the sensitivity of the conclusion to its two least observable ' +
        'inputs can be judged, not to offer a range of defensible values.',
    ),
  ]);
}

// ── Exhibit F-3 — the same conclusion against the discount rate of the option ─

/** The step set the risk-free axis is stressed over: ±100bp and ±200bp. */
const RFR_STEPS = [-0.02, -0.01, 0, 0.01, 0.02];

/**
 * Index of the axis value the conclusion actually adopted.
 *
 * By position rather than by `deltaFromBase === 0`, which is what F-2 can
 * afford to do and this exhibit cannot: the concluded value barely moves across
 * a risk-free axis, so two neighbouring cells can round to the same delta and
 * both would claim to be the base. The applied cell is the one whose axis value
 * is the applied one, and there is exactly one of those.
 */
function appliedIndex(values: readonly number[], applied: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i]! - applied) < Math.abs(values[best]! - applied)) best = i;
  }
  return best;
}

/**
 * Exhibit F-3 — the concluded value against the risk-free rate.
 *
 * F-2 stresses the two inputs nobody can observe. This one stresses the third
 * input of the same option model, and it is here for a different reason: the
 * risk-free rate *is* observable — a constant-maturity Treasury yield at the
 * valuation date — so the question a reviewer asks is not "what if it is wrong"
 * but "what if you matched the wrong maturity". Term-matching is a choice, the
 * curve between two and ten years is not flat, and the deliverable never said
 * what the choice was worth.
 *
 * Two tables rather than one, because the rate does not act alone: it enters
 * Black-Scholes through the discounted strike, so its effect depends on how far
 * out the strike sits (the term) and on how much of the option's value is time
 * value rather than intrinsic (the volatility). Stressing it against each in
 * turn is what shows whether the two interact.
 *
 * The usual outcome — and the one worth being able to demonstrate — is that a
 * 200bp move in the rate is worth a fraction of what a 10% move in sigma is.
 * That is a robustness statement about the conclusion, and it can only be made
 * by printing it. As in F-2, no cell but the applied one is adopted.
 */
export function rfrSensitivityExhibit(
  inputs: Record<string, unknown>,
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const basis = sensitivityBasis(inputs, results);
  if (basis === null) return null;
  const { volatility, termYears, riskFreeRate } = basis;

  /*
   * A rate near zero clamps the downward steps onto 0, and the table would then
   * print the same row twice under two different headings. Deduplicating the
   * resulting *rates* rather than the steps keeps the applied row and drops
   * only the repeats — a 2021-dated valuation struck at 45bp gets a short
   * table, which is the honest one.
   */
  const rfrSteps = [...new Set(RFR_STEPS.map((s) => Math.max(0, riskFreeRate + s)))]
    .map((rate) => rate - riskFreeRate)
    .sort((a, b) => a - b);

  const { base, tables } = sensitivityTables(basis, { rfrSteps });
  const money = (scaled: number) => formatCurrency(scaled / SENSITIVITY_SCALE, ctx.currency, 4);
  // Two decimals, not F-2's one: the moves this exhibit reports are small by
  // construction, and "+0.0%" against four different cells says nothing.
  const signedPercent = (d: number) => `${d > 0 ? '+' : ''}${formatPercent(d, 2)}`;

  const rfrValues = tables.rfr_vol.rowValues;
  const baseRfrRow = appliedIndex(rfrValues, riskFreeRate);

  /** One stress table, rates down the side and `label(v)` across the top. */
  const grid = (
    table_: typeof tables.rfr_vol,
    label: (value: number) => string,
    appliedCol: number,
  ): string =>
    table({
      head: ['Risk-free rate', ...table_.colValues.map(label)],
      rows: table_.rows.map((row, i) => [
        formatPercent(table_.rowValues[i]!, 2),
        ...row.map((cell, j) =>
          i === baseRfrRow && j === appliedCol
            ? `<strong>${money(cell.fmvPerShareCents)}</strong> (base)`
            : `${money(cell.fmvPerShareCents)} (${signedPercent(cell.deltaFromBase)})`,
        ),
      ]),
    });

  const volCol = appliedIndex(tables.rfr_vol.colValues, volatility);
  const termCol = appliedIndex(tables.rfr_term.colValues, termYears);

  // The rate's effect in isolation: the applied volatility held, the rate moved.
  const isolated = tables.rfr_vol.rows.map((row) => row[volCol]!.fmvPerShareCents);
  const low = Math.min(...isolated);
  const high = Math.max(...isolated);
  const concluded = base.fmvPerShareCents;
  const spread = concluded > 0 ? (high - low) / concluded : 0;

  return section(SCHEDULE['F-3'], [
    P(
      `The allocation discounts the preference stack at the risk-free rate, applied here at ` +
        `<strong>${formatPercent(riskFreeRate, 2)}</strong> — the constant-maturity Treasury yield ` +
        `matched to the ${termYears.toFixed(2)}-year expected term at the valuation date. Unlike the ` +
        'volatility and the term of Exhibit F-2 the rate is observed rather than estimated, so what is ' +
        'tested below is not the rate itself but the maturity it was matched to: the tables restate the ' +
        'concluded value per share with the rate moved 100 and 200 basis points either way, against the ' +
        'volatility and against the term in turn.',
    ),
    P('<strong>Risk-free rate against expected volatility</strong>'),
    grid(tables.rfr_vol, (v) => formatPercent(v, 1), volCol),
    P('<strong>Risk-free rate against expected term</strong>'),
    grid(tables.rfr_term, (t) => `${t.toFixed(2)} yrs`, termCol),
    P(
      `Holding the volatility and term at the values the conclusion adopts, the full ±200 basis-point ` +
        `range moves the concluded value from <strong>${money(low)}</strong> to ` +
        `<strong>${money(high)}</strong> — a spread of ${formatPercent(spread, 2)} of the concluded ` +
        `${money(concluded)}. <strong>No cell other than the base case is adopted by this valuation.</strong>`,
    ),
  ]);
}

// ── Exhibit G — PWERM scenarios ──────────────────────────────────────────────

export function pwermExhibit(results: Record<string, unknown>, ctx: ExhibitContext): ReportPdfSection | null {
  const allocation = record(results.allocation);
  /*
   * The Monte Carlo allocation also reports `allocation.scenarios`, and its
   * entries are a different thing: a horizon and a volatility, with no exit
   * value, because the whole point is that the exit is a distribution rather
   * than a point. Rendering them through the columns below would print an exit
   * equity value of $0 and a present value of $0 for every scenario in a
   * board-facing exhibit headed "Probability-Weighted Expected Return".
   *
   * Keyed on the allocation method rather than on sniffing for an
   * `exit_equity_value` field: this exhibit belongs to PWERM, and the next
   * method that reports scenarios should be excluded by default too.
   */
  const methodKey = String(results.allocation_method ?? allocation?.method ?? '').toLowerCase();
  if (methodKey === 'monte_carlo') return null;
  /*
   * A hybrid reports its two legs nested — `allocation.opm` and
   * `allocation.pwerm` — so its scenarios are one level down. Reading only the
   * flat key meant the exhibit was silently absent from exactly the reports
   * that most need it: on a hybrid, PWERM often carries the majority of the
   * weight, and the body's Allocation chapter sends the reader to Exhibit G.
   */
  const scenarios = list(
    allocation?.scenarios ??
      record(allocation?.pwerm)?.scenarios ??
      // Where a hybrid also reports its PWERM leg at the top level. Read last
      // and deliberately: it makes the exhibit appear for hybrid valuations
      // already stored, which would otherwise need re-running the engine to
      // gain a schedule their own body already refers them to.
      record(results.pwerm_allocation)?.scenarios,
  )
    .map(record)
    .filter((s): s is Record<string, unknown> => s !== null);
  if (scenarios.length === 0) return null;
  const { currency } = ctx;

  return section(SCHEDULE.G, [
    P(
      'Under PWERM the value of common stock is the probability-weighted present value of its proceeds ' +
        'in each modelled future outcome. Each scenario is allocated through the liquidation waterfall ' +
        'at its own exit value, discounted at its own rate over its own horizon, and weighted by its ' +
        'probability of occurring.',
    ),
    table({
      head: ['Scenario', 'Type', 'Probability', 'Exit equity value', 'Years', 'PV to common'],
      rows: scenarios.map((s) => [
        esc(text(s.name) ?? '—'),
        esc((text(s.type) ?? '—').replace(/_/g, ' ')),
        formatPercent(num(s.probability) ?? 0, 1),
        formatCurrency(num(s.exit_equity_value) ?? 0, currency, 0),
        (num(s.time_to_exit_years) ?? 0).toFixed(2),
        formatCurrency(num(s.common_present_value) ?? 0, currency, 0),
      ]),
      /*
       * Totalled from the rows above rather than from the concluded results.
       *
       * The footer used to print `results.equity_value` and
       * `results.common_equity_value` — the equity concluded across *all*
       * approaches and the common value after the full weighting. Neither is the
       * total of the column it sat under, so a reviewer adding up the exhibit
       * got a different number from the one printed on it. On a hybrid the
       * discrepancy is structural: these rows are the PWERM leg alone, and the
       * concluded figures include the OPM leg and every other approach.
       *
       * Each column is weighted by the probability in its own row, which is what
       * "probability-weighted" means and what the scenario values are built to
       * be summed as (`weighted_value` / `weighted_time` in engine/pwerm.py).
       */
      foot: [
        'Probability-weighted',
        '',
        formatPercent(
          scenarios.reduce((sum, s) => sum + (num(s.probability) ?? 0), 0),
          0,
        ),
        formatCurrency(
          scenarios.reduce((sum, s) => sum + (num(s.probability) ?? 0) * (num(s.exit_equity_value) ?? 0), 0),
          currency,
          0,
        ),
        scenarios
          .reduce((sum, s) => sum + (num(s.probability) ?? 0) * (num(s.time_to_exit_years) ?? 0), 0)
          .toFixed(2),
        formatCurrency(
          scenarios.reduce(
            (sum, s) => sum + (num(s.probability) ?? 0) * (num(s.common_present_value) ?? 0),
            0,
          ),
          currency,
          0,
        ),
      ],
    }),
  ]);
}

// ── Exhibit H — discounts and conclusion ─────────────────────────────────────

/** The same as `DLOM_LABELS`, for the control discount (engine dloc.py DLOC_METHODS). */
const DLOC_METHOD_NAMES: Record<string, string> = {
  control_premium: 'Inverted from a stated control premium',
  studies: 'Blended from published control-premium studies',
  qualitative: 'Qualitative — analyst judgement',
};

/**
 * The last three lines of the opinion, as arithmetic: the allocated common
 * value per share, the two discounts, and the concluded fair market value.
 *
 * `compute` guarantees `fmv = base × (1 − DLOC) × (1 − DLOM)`, so the exhibit
 * closes exactly. The base is taken from the allocation when it reports one and
 * inverted from the identity otherwise, which is what `marketableValuePerShare`
 * does for the summary chart — the two must not be able to disagree, so the
 * table is built the same way.
 */
export function discountExhibit(
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const fmv = num(results.fmv_per_share);
  if (fmv === null) return null;
  const { currency } = ctx;
  const discounts = record(results.discounts) ?? {};
  const dloc = num(discounts.dloc) ?? 0;
  const dlom = num(discounts.dlom) ?? 0;

  const direct = num(record(results.allocation)?.common_per_share);
  const factor = (1 - dloc) * (1 - dlom);
  const base = direct !== null && direct > 0 ? direct : factor > 0 ? fmv / factor : null;
  if (base === null) return null;

  const afterDloc = base * (1 - dloc);
  const method = text(discounts.dlom_method);
  const dlocDetail = record(discounts.dloc_detail);
  const dlocMethod = text(discounts.dloc_method);

  /*
   * What level of value the allocation actually produced.
   *
   * This line said "marketable, controlling" unconditionally, and for the
   * typical 409A that is not true: most of the weight sits on a backsolve,
   * which inverts the price a minority investor paid, and on guideline public
   * company multiples, which are struck on minority trading prices. Neither
   * produces a controlling value. The engine now measures the mix
   * (`dloc.minority_basis_share`) and records it, so the label follows the
   * calculation rather than asserting the case the exhibit was first written
   * for.
   */
  const minorityWeight = num(dlocDetail?.minority_basis_weight);
  const controlling = minorityWeight === null || minorityWeight <= 0.5;
  const openingLabel = controlling
    ? 'Marketable, controlling value per common share'
    : 'Marketable value per common share, as allocated';
  const openingBasis =
    minorityWeight === null || minorityWeight === 0
      ? 'Per the allocation above'
      : `Per the allocation above; ${formatPercent(minorityWeight, 0)} of the weighted equity ` +
        'value came from approaches that already produce a minority value';

  const rows: string[][] = [[openingLabel, formatCurrency(base, currency, 4), openingBasis]];
  if (dloc > 0 || controlling) {
    rows.push(
      [
        `Less: discount for lack of control — ${formatPercent(dloc)}`,
        `(${formatCurrency(base - afterDloc, currency, 4)})`,
        dlocMethod
          ? (DLOC_METHOD_NAMES[dlocMethod] ?? esc(dlocMethod))
          : 'A minority holder cannot compel a liquidity event or direct the business',
      ],
      ['Marketable, minority value per common share', formatCurrency(afterDloc, currency, 4), ''],
    );
  }
  rows.push([
    `Less: discount for lack of marketability — ${formatPercent(dlom)}`,
    `(${formatCurrency(afterDloc - fmv, currency, 4)})`,
    method ? (DLOM_LABELS[method] ?? esc(method)) : 'No active market exists for the shares',
  ]);

  return section(SCHEDULE.H, [
    P(
      (controlling
        ? 'The allocation produces the value of a common share on a marketable, controlling basis. '
        : 'The allocation produces the value of a common share on the basis its inputs carry — see ' +
          'the note below. ') +
        'Section 409A requires the fair market value of a minority interest in shares for which no ' +
        'market exists, so a discount for lack of control and a discount for lack of marketability ' +
        'are applied in turn. The discounts are multiplicative, in the order shown.',
    ),
    table({
      head: ['Step', 'Per share', 'Basis'],
      rows,
      foot: [
        `Concluded fair market value per common share${ctx.valuationDate ? ` as of ${ctx.valuationDate}` : ''}`,
        formatCurrency(fmv, currency, 4),
        'Non-marketable, minority basis',
      ],
    }),
    ...dlocDerivationBlock(dlocDetail, dloc),
    ...classValueBlock(results, dloc, dlom, ctx, controlling),
  ]);
}

/**
 * How the control discount was arrived at, where it was derived rather than
 * stated — and where it was applied to a value that was already at a minority
 * level, which is the finding that changes a number.
 *
 * A DLOC steps control → marketable minority. Applied to a figure that arrived
 * at a marketable minority level it discounts twice for one thing, and nothing
 * about the result looks wrong: it is a plausible per-share figure that is
 * simply too low. The engine reports the mix rather than refusing it, because
 * an appraiser may have a reason and the engine overruling the analysis would
 * be worse — but the reason has to be visible on the page that states the
 * conclusion, not in a database column.
 */
function dlocDerivationBlock(detail: Record<string, unknown> | null, dloc: number): string[] {
  if (!detail) return [];
  const rows: string[][] = [];

  const observed = num(detail.observed_control_premium);
  const applied = num(detail.control_premium_applied);
  if (observed !== null) {
    rows.push(['Control premium observed', formatPercent(observed), 'As stated or blended']);
  }
  const synergy = num(detail.synergy_share);
  if (synergy !== null && applied !== null) {
    rows.push(
      [
        'Less: share attributed to synergies',
        formatPercent(synergy),
        'An acquisition premium impounds what the buyer expected to do with the target as ' +
          'well as the value of control itself',
      ],
      ['Control premium applied', formatPercent(applied), ''],
    );
  }
  const implied = num(detail.implied_control_premium);
  if (implied !== null) {
    rows.push(['Control premium implied by the discount', formatPercent(implied), 'CP = d ÷ (1 − d)']);
  }
  if (observed !== null || implied !== null) {
    rows.push([
      'Discount for lack of control',
      formatPercent(dloc),
      'DLOC = 1 − 1 ÷ (1 + CP). The premium and the discount are the same fact from ' +
        'opposite sides, and the conversion is not symmetric',
    ]);
  }
  const basis = text(detail.basis);
  if (basis) rows.push(['Basis for the judgement', esc(basis), '']);

  const out: string[] = [];
  if (rows.length > 0) {
    out.push(P('<strong>Discount for lack of control — derivation</strong>'));
    out.push(table({ head: ['Derivation', 'Value', 'Note'], rows }));
  }

  const studies = list(detail.studies)
    .map((raw) => record(raw))
    .filter((s): s is Record<string, unknown> => s !== null);
  if (studies.length > 0) {
    out.push(
      table({
        head: ['Control-premium study', 'Period', 'Premium'],
        rows: studies.map((s) => {
          const from = num(s.period_start);
          const to = num(s.period_end);
          const premium = num(s.premium);
          return [
            text(s.study) ?? '—',
            from !== null && to !== null ? `${from}–${to}` : '—',
            premium === null ? '—' : formatPercent(premium),
          ];
        }),
      }),
    );
  }

  const caveats: string[] = [];
  if (detail.indicative_table === true) {
    caveats.push(
      'The premiums above are the engine’s built-in decade summaries rather than an extraction ' +
        'for this company’s own industry and period. The dispersion of control premiums across ' +
        'industries is wider than across decades, and a concluded discount should rest on the ' +
        'subject’s own peer transactions.',
    );
  }
  if (detail.thin_study_set === true) {
    caveats.push(
      'The selected set is fewer than three studies, which is a narrow basis on which to conclude.',
    );
  }
  if (detail.double_counts_minority === true) {
    caveats.push(
      text(detail.note) ??
        'A majority of the weighted equity value came from approaches that already produce a ' +
          'marketable minority value, and a discount for lack of control has been applied on top ' +
          'of it.',
    );
  }
  if (caveats.length > 0) {
    out.push(table({ head: ['On the control discount'], rows: caveats.map((c) => [c]) }));
  }
  return out;
}

/**
 * Each class, marketable and non-marketable side by side.
 *
 * The chain above is the *common* share, which is what a §409A concludes on.
 * A reader of the cap table wants the same two numbers for every class —
 * a 409A that allocates $13.2M to Series B and never says what that is per
 * share on a marketable and a non-marketable basis makes the reader do the
 * arithmetic from two separate exhibits.
 *
 * The discounts are applied only to the classes they were concluded for. DLOC
 * and DLOM were reasoned about a minority holder of common with no market and
 * no ability to compel an exit; a preferred series holding a board seat and a
 * registration right is not in that position, and carrying the same two
 * percentages across the whole table would assert a conclusion nobody reached.
 * Those rows state their marketable value and leave the discounted column
 * blank, with the reason in the note.
 */
function classValueBlock(
  results: Record<string, unknown>,
  dloc: number,
  dlom: number,
  ctx: ExhibitContext,
  /**
   * Whether the allocation's output really is a controlling value — the same
   * judgement the step table above makes, passed down rather than re-derived so
   * the two halves of one exhibit cannot describe the input differently. They
   * did: this paragraph asserted "marketable, controlling basis" three lines
   * under a boxed note reporting that 75% of the weighted value arrived at a
   * minority level already.
   */
  controlling: boolean,
): string[] {
  const classes = record(record(results.allocation)?.classes);
  if (!classes) return [];
  const factor = (1 - dloc) * (1 - dlom);

  const rows = Object.entries(classes)
    .map(([name, raw]) => ({ name, value: record(raw) }))
    .filter((c) => c.value !== null)
    .map((c) => {
      // `per_share` on the two OPM waterfalls, `fmv_per_share` on PWERM — the
      // same figure under the name each allocator gives it, read the same way
      // Exhibit F reads it. Reading only the first printed a PWERM valuation's
      // table as class names and share counts with an em-dash in both value
      // columns, under a paragraph explaining how the discounts were applied
      // to them.
      const perShare = num(c.value?.per_share) ?? num(c.value?.fmv_per_share);
      const kind = text(c.value?.kind) ?? '—';
      const discounted = kind === 'common' && perShare !== null ? perShare * factor : null;
      return [
        esc(c.name),
        kind,
        num(c.value?.shares) === null ? '—' : shares(num(c.value?.shares) as number),
        perShare === null ? '—' : formatCurrency(perShare, ctx.currency, 4),
        discounted === null ? '—' : formatCurrency(discounted, ctx.currency, 4),
      ];
    });
  if (rows.length === 0) return [];

  return [
    P(
      (controlling
        ? 'The allocation values every class on a marketable, controlling basis. '
        : 'The allocation values every class on the same basis as the step table above. ') +
        'The concluded discounts ' +
        'are applied below to the common stock, which is the interest this valuation concludes on. ' +
        'They are not carried across the preferred and option classes: a discount for lack of control ' +
        'and a discount for lack of marketability were reasoned about a minority holder of common with ' +
        'no market and no ability to compel an exit, and a series holding governance and registration ' +
        'rights is not in that position.',
    ),
    table({
      head: ['Class', 'Type', 'Shares', 'Value per share — marketable', 'Value per share — non-marketable'],
      rows,
    }),
  ];
}

// ── Exhibit H-1 — the marketability discount, derived ────────────────────────

/**
 * Which volatility the DLOM was struck on — `class`, `enterprise`, or unstated.
 *
 * A weighted blend records no basis of its own: the label sits on each leg,
 * because a study leg has no volatility at all and only the option-based legs
 * carry one. They cannot disagree — `_blended_dlom` passes one basis to every
 * leg — so the first leg that states one states it for the blend. Older
 * calculations predate the field entirely and answer null, which is why the
 * prose that reads this keeps its original wording for that case.
 */
function dlomVolatilityBasis(detail: Record<string, unknown>): string | null {
  const own = text(detail.volatility_basis);
  if (own) return own;
  for (const leg of list(detail.components)) {
    const basis = text(record(record(leg)?.detail)?.volatility_basis);
    if (basis) return basis;
  }
  return null;
}

/**
 * The inputs one DLOM method was struck on, as `Derivation / Value / Note` rows.
 *
 * Shared by the single-method table and by each leg of a weighted blend, so a
 * Finnerty run and a Finnerty leg are described identically. The engine records
 * the same `dlom_detail` shape for both (`compute._single_dlom`), which is what
 * makes one renderer correct for both — and a second copy of these rows for the
 * blend is how a leg would come to state a volatility the leg did not use.
 */
function derivationRows(
  detail: Record<string, unknown>,
  discounts: Record<string, unknown> | null,
): string[][] {
  const method = text(detail.method) ?? text(discounts?.dlom_method) ?? 'unknown';
  const rows: string[][] = [['Method applied', DLOM_LABELS[method] ?? esc(method), '']];

  const formula = text(detail.formula);
  if (formula) rows.push(['Basis', esc(formula), '']);

  const vol = num(detail.volatility);
  if (vol !== null) {
    // Which of the two volatilities this is, on the row that states it. The
    // engine strikes an option-based DLOM on the *class's* volatility by
    // default (`dlom_volatility_basis`), and that figure is roughly a fifth
    // higher than the enterprise one on a company with a preference stack —
    // so a reviewer checking the discount against the allocation's σ finds two
    // different numbers and no statement of which is which.
    const basis = text(detail.volatility_basis);
    rows.push([
      'Volatility applied (σ)',
      formatPercent(vol),
      basis === 'class'
        ? 'Of the class valued — common, geared by the preference stack; see the schedule below'
        : basis === 'enterprise'
          ? 'Of the enterprise as a whole, not of the class valued — see the schedule below'
          : 'Of the interest valued over the holding period',
    ]);
  }
  const term = num(detail.time_to_liquidity_years);
  if (term !== null) {
    rows.push([
      'Holding period applied (T)',
      `${term.toFixed(2)} years`,
      'Expected time to a liquidity event',
    ]);
  }
  const rate = num(detail.risk_free_rate);
  if (rate !== null) {
    rows.push(['Risk-free rate (r)', formatPercent(rate, 2), 'Matched to the holding period']);
  }
  if (detail.is_upper_bound === true) {
    const bound = num(detail.bound_multiple);
    rows.push([
      'Reported as an upper bound',
      bound === null ? 'Yes' : ratio(bound),
      'Longstaff bounds the discount rather than estimating it — the concluded ' +
        'figure is a ceiling, not a point estimate',
    ]);
  }
  const basis = text(detail.basis);
  if (basis) rows.push(['Basis for the judgement', esc(basis), '']);
  return rows;
}

/**
 * The published studies a discount was blended from, and the caveats on them.
 *
 * Set selection is the whole objection to the empirical methods, so naming the
 * studies is not a courtesy. Empty for every method that rests on no study set.
 *
 * Two families reach this, and they are not interchangeable — restricted-stock
 * placements measure what the market paid for a known resale restriction;
 * pre-IPO transactions measure the discount to an offering price that had not
 * been set yet. The prose and the caveats therefore follow `detail.method`
 * rather than being written once for the family that happened to come first: a
 * pre-IPO leg described as restricted stock, with the Rule 144 note attached,
 * is a statement about the evidence that is simply untrue.
 *
 * The caveat rows are the engine's own flags (`thin_study_set`,
 * `straddles_rule_144_amendment`, `predates_modern_ipo_market`,
 * `selection_bias`), transcribed rather than re-derived. They existed on the
 * calculation and no exhibit printed them, which put the reviewer's first
 * question — how thin is this set, and does it span the 1997 break — behind a
 * database query.
 */
function studyBlock(detail: Record<string, unknown>): string[] {
  const studies = list(detail.studies)
    .map((raw) => record(raw))
    .filter((s): s is Record<string, unknown> => s !== null);
  if (studies.length === 0) return [];
  const statistic = text(detail.statistic) ?? 'median';
  const preIpo = text(detail.method) === 'pre_ipo';

  const intro = preIpo
    ? `The discount is the ${esc(statistic)} of the selected pre-IPO studies: the prices at which ` +
      'shares changed hands privately in the months before the company’s offering, against the ' +
      'offering price itself.'
    : `The discount is the ${esc(statistic)} of the selected restricted-stock studies: the ` +
      'discounts at which stock restricted from resale under Rule 144 actually changed hands. ' +
      'Observations predating the 1997 amendment measured a two-year restriction rather than the ' +
      'one that applies today, and are identified by their period below.';

  const out = [
    P(intro),
    table({
      head: ['Study', 'Period', 'Statistic', 'Discount'],
      rows: studies.map((s) => {
        // `discount` is what the engine's tables and a firm-supplied table both
        // carry (engine dlom.py `_study_rows`). The two fallbacks are for a
        // stored calculation written before that shape settled — without them
        // this column silently printed a dash for every row, which is how it
        // shipped: a study table with no discounts in it.
        const value = num(s.discount) ?? num(s.median) ?? num(s.mean);
        const from = num(s.period_start);
        const to = num(s.period_end);
        return [
          text(s.study) ?? '—',
          from !== null && to !== null ? `${from}–${to}` : '—',
          text(s.statistic) ?? '—',
          value === null ? '—' : formatPercent(value),
        ];
      }),
    }),
  ];

  const caveats: string[] = [];
  if (detail.thin_study_set === true) {
    caveats.push(
      'The selected set is fewer than three studies, which is a narrow basis on which to conclude.',
    );
  }
  if (detail.straddles_rule_144_amendment === true) {
    caveats.push(
      'The set spans the April 1997 amendment to Rule 144, which shortened the holding period from ' +
        'two years to one. Discounts either side of it describe different securities, and the ' +
        'blended figure averages two regimes.',
    );
  }
  if (preIpo) {
    // Not conditional on a flag: it is true of every pre-IPO set, and it is
    // the reason these discounts run roughly twice the restricted-stock ones.
    const bias = text(detail.selection_bias);
    caveats.push(
      bias ??
        'The sample is companies that went on to complete an IPO, so part of the measured discount ' +
          'is the change in the company’s prospects over the period rather than marketability alone.',
    );
    if (detail.predates_modern_ipo_market === true) {
      caveats.push(
        'The set reaches back before 1990, to an IPO market with a different process and a ' +
          'different retail bid from the one a company would face today.',
      );
    }
  }
  const low = num(detail.low);
  const high = num(detail.high);
  if (low !== null && high !== null) {
    caveats.push(
      `The selected studies range from ${formatPercent(low)} to ${formatPercent(high)}; the ` +
        `concluded figure is their ${esc(statistic)}, not the midpoint of that range.`,
    );
  }
  if (caveats.length > 0) {
    out.push(
      table({
        head: ['On the study set'],
        rows: caveats.map((c) => [c]),
      }),
    );
  }
  return out;
}

/**
 * A discount concluded by weighting several methods: the weighting table first,
 * then each leg's own derivation.
 *
 * This is the table the legacy deliverable devotes to the DLOM — "DLOM Method /
 * Weight / Selected DLOM" — and the reason it exists is that a marketability
 * discount is the one figure in a 409A with no single defensible derivation. The
 * option models price the cost of being unable to sell from the subject's own
 * volatility and holding period; the restricted-stock studies report what the
 * market actually paid for restricted shares. They are evidence of different
 * kinds, and the standard appraisal answer is to weight them rather than to
 * declare one correct.
 *
 * The weighted column is stated, not left for the reader to multiply out, because
 * the concluded figure has to be visibly the sum of the column above it —
 * otherwise the table shows the ingredients of an answer without showing that it
 * is the answer.
 *
 * A nil-weighted method stays in the table. An appraiser who computed Longstaff
 * to show it as an upper bound and weighted it to nothing is documenting the
 * bound, and dropping the row would hide a method that was considered.
 */
function methodWeightingBlock(
  detail: Record<string, unknown>,
  discounts: Record<string, unknown> | null,
): string[] {
  const components = list(detail.components)
    .map((raw) => record(raw))
    .filter((c): c is Record<string, unknown> => c !== null);
  if (components.length === 0) return [];

  const concluded = num(detail.dlom) ?? num(discounts?.dlom);
  const out: string[] = [
    P(
      'No single method measures marketability. The option models price the cost of being unable ' +
        'to sell from the subject’s own volatility and expected holding period; the ' +
        'restricted-stock studies report the discounts at which restricted shares actually ' +
        'changed hands. They are evidence of different kinds, and are weighted below rather than ' +
        'ranked.',
    ),
    table({
      head: ['DLOM method', 'Weight', 'Indicated DLOM', 'Weighted'],
      rows: components.map((c) => {
        const name = text(c.method) ?? 'unknown';
        const weight = num(c.weight);
        const indicated = num(c.dlom);
        const weighted = num(c.weighted);
        return [
          DLOM_LABELS[name] ?? esc(name),
          // Weights to two places, matching the footed 100.00%: a column of
          // "33.3%" thrice under a total of 100.00% invites the reader to check
          // an addition that was never done in one decimal place.
          weight === null ? '—' : formatPercent(weight, 2),
          indicated === null ? '—' : formatPercent(indicated),
          weighted === null ? '—' : formatPercent(weighted),
        ];
      }),
      foot: [
        'Selected discount for lack of marketability',
        '100.00%',
        '',
        concluded === null ? '—' : formatPercent(concluded),
      ],
    }),
  ];

  /*
   * Each leg's own inputs, under its own subheading.
   *
   * A weighted average is checked by reading the legs, so a table of four
   * percentages with nothing behind them moves the unreviewable bare figure from
   * Exhibit H to Exhibit H-1 rather than removing it. Only the legs that recorded
   * a derivation get a block — a qualitative leg has a sentence, not a model.
   */
  for (const c of components) {
    const legDetail = record(c.detail);
    if (!legDetail) continue;
    const name = text(c.method) ?? 'unknown';
    const rows = derivationRows(legDetail, null);
    if (rows.length <= 1 && list(legDetail.studies).length === 0) continue;
    out.push(
      P(`<strong>${DLOM_LABELS[name] ?? esc(name)}</strong>`),
      table({ head: ['Derivation', 'Value', 'Note'], rows }),
      ...studyBlock(legDetail),
    );
  }
  return out;
}

/**
 * The aggregate common claim, as a row of the class-volatility schedule.
 *
 * The per-class rows above it are each a single class. The interest a §409A
 * concludes on is *common*, and on any cap table carrying more than one common
 * class — founders' common beside ordinary common, a second common series from
 * a recap — no row above is the claim being valued, so the figure the discount
 * was struck on appears nowhere a reader can find it. The engine already
 * computes it: `waterfall.class_volatility` reports `common_volatility`, the
 * value-weighted mean over the common classes, which is exact rather than
 * approximate because each class contributes σ·S·δ and summing the numerators
 * and the values is the same operation as taking the elasticity of the summed
 * claim. It was on `results.class_volatility` and reached no reader.
 *
 * The delta and the gearing beside it are the sum of the printed column and the
 * ratio of the two printed volatilities — column arithmetic a reader can redo
 * against the rows above, not a second derivation of the volatility itself,
 * which is taken from the engine as it recorded it.
 *
 * Null when the waterfall reported no `common_volatility`. That happens when
 * the common classes are collectively worth nothing — so far out of the money
 * that no tranche reaches them — and the engine reports a null rather than an
 * infinity for exactly the reason this prints no row: there is no defined
 * return volatility for a claim with no value.
 */
function commonAggregateRow(
  classVol: Record<string, unknown>,
  entries: ReadonlyArray<{ name: string; value: Record<string, unknown> | null }>,
  enterprise: number,
  applied: boolean,
): string[] | null {
  const volatility = num(classVol.common_volatility);
  if (volatility === null) return null;
  const common = entries.filter((c) => text(c.value?.kind) === 'common');
  if (common.length === 0) return null;

  let delta: number | null = 0;
  for (const c of common) {
    const d = num(c.value?.delta);
    if (d === null) {
      delta = null;
      break;
    }
    delta += d;
  }

  return [
    // Marked where it is the figure the discount actually used, so a reader
    // meets it as the conclusion of the schedule rather than as one more row.
    applied ? '<strong>Common — aggregate (applied)</strong>' : '<strong>Common — aggregate</strong>',
    'common',
    delta === null ? '—' : `<strong>${delta.toFixed(4)}</strong>`,
    enterprise > 0 ? `<strong>${ratio(volatility / enterprise, 2)}</strong>` : '—',
    `<strong>${formatPercent(volatility)}</strong>`,
  ];
}

/**
 * How the DLOM was arrived at, and the class volatilities that bear on it.
 *
 * Exhibit H applies the discount; nothing said where it came from. A reviewer
 * asked to accept a 24.5% marketability discount cannot check a bare
 * percentage — the model is arithmetic nobody disputes, and the volatility and
 * holding period it was struck on *are* the argument. The legacy deliverable
 * devotes six subsections to this (its §§10.1–10.6) and N409 had none.
 *
 * Two blocks, and both are conditional on what the run produced:
 *
 *   * the derivation — the model applied and its inputs, or the study set and
 *     the statistic blended from it. `dlom_detail` is what the engine now
 *     records for every method (engine/compute.py `_model_detail`), so this is
 *     transcription rather than re-derivation: the exhibit cannot state inputs
 *     the calculation did not actually use.
 *
 *   * the class volatilities — only the breakpoint waterfall produces these,
 *     and they matter because the volatility that belongs in an option-based
 *     DLOM struck on *common* is common's own, not the enterprise's. Common
 *     sits behind the whole preference stack, so it is a levered claim and its
 *     return volatility is higher. Showing the two side by side is what lets a
 *     reader see whether the discount was struck on the right one.
 */
export function dlomDerivationExhibit(
  results: Record<string, unknown>,
  // Every figure here is a rate, a ratio or a period — nothing is denominated,
  // so unlike its neighbours this exhibit needs neither the currency nor the
  // valuation date. The parameter stays for symmetry with the rest of the
  // module and with `buildExhibits`, which calls them uniformly.
  _ctx: ExhibitContext,
): ReportPdfSection | null {
  const discounts = record(results.discounts);
  const detail = record(discounts?.dlom_detail);
  const classVol = record(results.class_volatility);
  if (!detail && !classVol) return null;

  // Whether the second of this exhibit's two blocks actually printed. The body
  // points at it by name in two chapters, and the pointer resolves against the
  // ids this section declares rather than against its heading — see
  // `CLASS_VOLATILITY_SCHEDULE`.
  let classVolatilityPrinted = false;

  const body: string[] = [
    P(
      'The discount applied in Exhibit H is derived below. The model or study is the uncontested ' +
        'part; the inputs it was struck on are the analysis, and are stated here so that the ' +
        'conclusion can be tested rather than merely read.',
    ),
  ];

  if (detail && text(detail.method) === 'weighted') {
    body.push(...methodWeightingBlock(detail, discounts));
  } else if (detail) {
    const concluded = num(detail.dlom) ?? num(discounts?.dlom);
    body.push(
      table({
        head: ['Derivation', 'Value', 'Note'],
        rows: derivationRows(detail, discounts),
        foot: [
          'Concluded discount for lack of marketability',
          concluded === null ? '—' : formatPercent(concluded),
          'Carried into Exhibit H',
        ],
      }),
      ...studyBlock(detail),
    );
  }

  if (classVol) {
    const classes = record(classVol.classes);
    const enterprise = num(classVol.enterprise_volatility);
    if (classes && enterprise !== null) {
      const entries = Object.entries(classes)
        .map(([name, raw]) => ({ name, value: record(raw) }))
        .filter((c) => c.value !== null);
      const rows = entries.map((c) => {
        const vol = num(c.value?.volatility);
        const elasticity = num(c.value?.elasticity);
        const delta = num(c.value?.delta);
        return [
          esc(c.name),
          text(c.value?.kind) ?? '—',
          delta === null ? '—' : delta.toFixed(4),
          elasticity === null ? '—' : ratio(elasticity, 2),
          vol === null ? '—' : formatPercent(vol),
        ];
      });
      // Whether the discount above was struck on the enterprise figure or on
      // common's own changes what this paragraph has to say — under the class
      // basis the σ printed above *is* the geared one, and telling the reader it
      // "describes the enterprise" contradicts the table two rows up. The
      // schedule is worth printing either way: it is what lets a reviewer see
      // the gearing the discount does or does not carry.
      const struckOn = detail ? dlomVolatilityBasis(detail) : null;
      const gearing =
        'Each share class is a levered claim on the enterprise — under the breakpoint method, a ' +
        'spread of call options — so each carries its own return volatility: σ_class = σ × (equity ' +
        'value ÷ class value) × ∂(class value)/∂(equity value). Common ranks behind the preference ' +
        'stack and is therefore the most geared.';
      const aggregate = commonAggregateRow(classVol, entries, enterprise, struckOn === 'class');
      if (aggregate) rows.push(aggregate);
      /*
       * Where the aggregate row prints, the schedule has a line the reader can
       * match against the volatility stated above it, and the paragraph says so
       * — a cap table with two common classes has no single class row that is
       * the interest being valued, which is the case that sent a reader looking
       * for a figure the table did not contain.
       */
      const foundIn = aggregate ? 'the aggregate common line of the schedule below' : 'the schedule below';
      body.push(
        P(
          struckOn === 'class'
            ? `The volatility above is common’s own, taken from ${foundIn}. ${gearing} ` +
                'An option-based discount struck on a class takes that class’s volatility, which is ' +
                'why the figure above exceeds the enterprise volatility the allocation ran on.'
            : struckOn === 'enterprise'
              ? `The volatility above describes the enterprise, not the class the discount was ` +
                `struck on. ${gearing} The volatility that belongs in an option-based discount ` +
                `struck on a particular class is that class’s own, and on ${foundIn} that ` +
                'figure is higher for common than the one applied.'
              : `The volatility above describes the enterprise. ${gearing} The volatility that ` +
                'belongs in an option-based discount struck on a particular class is that class’s own.',
        ),
        table({
          head: ['Class', 'Type', 'Delta', 'Gearing', 'Class volatility'],
          rows,
          foot: [
            'Enterprise',
            '',
            classVol.delta_total === undefined ? '' : Number(classVol.delta_total).toFixed(4),
            '1.00x',
            formatPercent(enterprise),
          ],
        }),
      );
      classVolatilityPrinted = true;
    }
  }

  return section(SCHEDULE['H-1'], body, classVolatilityPrinted ? [CLASS_VOLATILITY_SCHEDULE] : undefined);
}

// ── Appendix II — the financial statements the analysis rests on ─────────────

/** The sheets this appendix prints, in the order a statement set is read. */
const FINANCIAL_SHEET_KEYS = ['income_statement', 'balance_sheet'] as const;

/**
 * One workbook cell, formatted the way its row is denominated.
 *
 * A null is printed as an em dash rather than as a zero. The distinction is the
 * whole point of the null-propagating arithmetic in `computeWorkbook`: a
 * company with no inventory line and a company whose inventory is genuinely
 * nil are different facts, and a statement that renders both as `$0` asserts
 * the second about the first.
 */
function financialCell(value: number | null, format: WorkbookFormat, currency: string): string {
  if (value === null) return '—';
  if (format === 'percent') return formatPercent(value, 1);
  if (format === 'number') return value.toLocaleString('en-US');
  // Whole units. A statement is read for magnitude and trend, and cents across
  // five columns cost a reader width without telling them anything.
  return formatCurrency(value, currency, 0);
}

/**
 * The reported financial statements, as an appendix.
 *
 * The Financial Analysis chapter discusses historical performance in prose, and
 * before this the figures behind that prose existed only in the workbook. That
 * asks a reviewer to take the narrative on trust — the one thing an appendix
 * exists to prevent — and it is why the legacy deliverable carries an
 * `appendix-historical-financials` of its own.
 *
 * Reported periods only: `isProjectionColumn` drops FY+1 and FY+2. Management's
 * forecast is evidence of a different kind, it is already disclosed where it is
 * actually used (Exhibit C discounts it), and an appendix titled "Historical
 * Financial Statements" that carried it would misdescribe itself.
 *
 * Rows with nothing in them across every reported period are dropped. The
 * workbook's schema is fixed, so a SaaS company with no inventory and no COGS
 * would otherwise print a page of em dashes and bury the four lines that matter.
 * A row with a figure in even one period stays, dashes and all, because the gap
 * is then itself information.
 *
 * Derived rows (margins, growth, totals) are printed with their inputs rather
 * than separately, exactly as `computeWorkbook` resolved them — so the appendix
 * cannot state a margin the workbook does not agree with.
 */
export function financialsExhibit(
  sheets: readonly ComputedSheet[] | undefined,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  // Same defence as `usablePeers`, for the same reason: this appendix indexed
  // straight into a workbook the caller resolved, so a `financials` that was
  // not an array — or a sheet without its `rows` — threw out of the render
  // instead of dropping the appendix, losing a finished report over a section
  // the report is perfectly readable without.
  const usable = list(sheets).filter((s): s is ComputedSheet => {
    const sheet = record(s);
    return sheet !== null && Array.isArray(sheet.columns) && Array.isArray(sheet.rows);
  });
  if (usable.length === 0) return null;

  const blocks: string[] = [];
  for (const key of FINANCIAL_SHEET_KEYS) {
    const sheet = usable.find((s) => s.key === key);
    if (!sheet) continue;

    const columns = sheet.columns.filter((c) => record(c) !== null && !isProjectionColumn(c.key));
    if (columns.length === 0) continue;
    const keep = new Set(columns.map((c) => c.key));

    const rows = sheet.rows
      .filter((row) => record(row) !== null && Array.isArray(row.cells))
      .map((row) => ({
        row,
        cells: row.cells.filter((c) => record(c) !== null && keep.has(c.column_key)),
      }))
      .filter(({ cells }) => cells.some((c) => c.value !== null))
      .map(({ row, cells }) => [
        esc(text(row.label) ?? '—'),
        ...cells.map((c) => financialCell(num(c.value), row.format, ctx.currency)),
      ]);
    if (rows.length === 0) continue;

    blocks.push(
      `<h3>${esc(text(sheet.label) ?? '—')}</h3>`,
      table({ head: ['', ...columns.map((c) => esc(text(c.label) ?? '—'))], rows }),
    );
  }

  if (blocks.length === 0) return null;

  return section(SCHEDULE.II, [
    P(
      'The financial statements below are the reported figures the analysis rests on, as entered in ' +
        'the valuation workbook and carried into the engine without adjustment. Subtotals, margins ' +
        'and growth rates are computed from the lines above them rather than entered, so they cannot ' +
        'disagree with the statements they summarise. Periods are the company’s fiscal years; ' +
        'management’s forecast is not reproduced here, and is set out where it is applied in ' +
        '<strong>Exhibit C</strong>. A line the company does not report is shown as a dash rather ' +
        'than as nil.',
    ),
    ...blocks,
  ]);
}

// ── Appendix II-1 — the operating series behind the statements ───────────────

/** The sheet this appendix prints. Its own key, so a rename is one edit. */
const OPERATING_SHEET_KEY = 'operating_metrics';

/**
 * The core operating time series — 409.ai's `core-time-series` pages, and the
 * last of the report-structure gaps.
 *
 * ## Why this is not Appendix II again
 *
 * Appendix II prints what the company *reported*: revenue, cost, the balance
 * sheet. For a mature business that is the whole evidential record, and a
 * second appendix restating it in other units would be padding. For the
 * companies a 409A is actually written for it is not, and the difference is the
 * reason this page exists.
 *
 * A GAAP revenue line cannot distinguish a business that grew 60% by adding
 * customers from one that grew 60% by adding headcount and discounting, and the
 * two do not carry the same risk. Nor can it tell a reviewer how much cash the
 * growth cost. Those are the questions the discount rate, the stage conclusion
 * in Appendix III and the volatility in Exhibit F-1 are all answers to, and
 * before this appendix the file supported them with prose.
 *
 * ## What is here, and what is not
 *
 * Four entered series — ARR, customers, headcount, net burn — and five ratios
 * derived from them by `computeWorkbook`, never by this module. That is the
 * same rule Appendix II follows and it matters more here, because every ratio
 * on this page is one a reader could compute themselves and check: a printed
 * "ARR per employee" that does not equal the two rows above it divided is a
 * defect a reviewer will find in about four seconds.
 *
 * Reported periods only, via `isProjectionColumn`, for exactly the reason
 * Appendix II excludes them: management's operating plan is a forecast, it is
 * evidence of a different kind, and an appendix presenting next year's ARR
 * target in the same table as three years of history invites a reader to treat
 * them as the same thing.
 *
 * Rendered only where something was entered. A company that tracks none of this
 * — and many at the seed end do not — gets no appendix, rather than a page of
 * dashes implying the analyst failed to collect it.
 */
export function operatingMetricsExhibit(
  sheets: readonly ComputedSheet[] | undefined,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  // Same defensive read as `financialsExhibit`: the caller resolved this
  // workbook, and a shape that is not the one this module expects must drop the
  // appendix rather than throw out of a PDF render.
  const sheet = list(sheets)
    .filter((s): s is ComputedSheet => {
      const r = record(s);
      return r !== null && Array.isArray(r.columns) && Array.isArray(r.rows);
    })
    .find((s) => s.key === OPERATING_SHEET_KEY);
  if (!sheet) return null;

  const columns = sheet.columns.filter((c) => record(c) !== null && !isProjectionColumn(c.key));
  if (columns.length === 0) return null;
  const keep = new Set(columns.map((c) => c.key));

  const rows = sheet.rows
    .filter((row) => record(row) !== null && Array.isArray(row.cells))
    .map((row) => ({
      row,
      cells: row.cells.filter((c) => record(c) !== null && keep.has(c.column_key)),
    }))
    // A row that is empty across every reported period is dropped, for the
    // reason Appendix II drops one: the workbook's schema is fixed, and a
    // company that does not track customer counts should not be shown a
    // customer row full of dashes. A row with one figure in it stays.
    .filter(({ cells }) => cells.some((c) => c.value !== null))
    .map(({ row, cells }) => [
      esc(text(row.label) ?? '—'),
      ...cells.map((c) => financialCell(num(c.value), row.format, ctx.currency)),
    ]);
  if (rows.length === 0) return null;

  return section(SCHEDULE['II-1'], [
    P(
      'The series below are the operating measures the analysis reads alongside the reported ' +
        'statements in <strong>Appendix II</strong>. They are what the statements cannot show on their ' +
        'own: whether growth came from more customers or from larger ones, what it cost in cash, and ' +
        'how the two moved against headcount. The stage concluded in <strong>Appendix III</strong> and ' +
        'the company-specific risk premium in <strong>Appendix I</strong> are both read against this ' +
        'trajectory.',
    ),
    table({ head: ['', ...columns.map((c) => esc(text(c.label) ?? '—'))], rows }),
    P(
      'Recurring revenue, customer count, headcount and net cash burn are entered from the company’s ' +
        'own reporting; every other line is computed from them and cannot disagree with the rows above ' +
        'it. Net cash burn is stated as consumption, so a period in which the company generated cash ' +
        'carries a negative figure. The burn multiple is burn per dollar of net new recurring revenue ' +
        'and is shown only for periods in which recurring revenue grew — in a period of contraction the ' +
        'ratio is negative, which would read as efficiency, and the contraction itself is stated in the ' +
        'net new ARR line. Periods are the company’s fiscal years; management’s operating plan is not ' +
        'reproduced here.',
    ),
  ]);
}

// ── Appendix III — what a company at this stage is expected to return ────────

/**
 * The venture capital required-return ladder, against the stage concluded.
 *
 * Appendix I says how the discount rate was built. It cannot say whether the
 * result is plausible for a company at this stage, and that is the question a
 * reviewer actually has: 22% is unremarkable for a profitable business and
 * implausible for one with a prototype and no revenue. This is the table the
 * legacy deliverable carries for that purpose.
 *
 * Rendered only where a stage has been concluded. The ladder without a marked
 * row is a page of general reference in a company-specific document — and the
 * stage is a judgement nobody has recorded yet, not something to infer here.
 *
 * It corroborates; it does not derive. The concluded rate stays whatever the
 * build-up produced, and a rate outside the band is a thing for the analyst to
 * explain rather than for this appendix to overrule — which is why the row is
 * marked rather than the rate being restated from it.
 */
export function requiredReturnExhibit(ctx: ExhibitContext): ReportPdfSection | null {
  const stage = ctx.developmentStage;
  if (typeof stage !== 'number') return null;

  let rows;
  try {
    rows = requiredReturnRows(stage, ctx.requiredReturnTable);
  } catch {
    // A firm's malformed override is refused by the params route at save time.
    // Reaching here means a stored row is unreadable, and a render must not
    // die inside a PDF for it — the appendix drops, as every other one does.
    return null;
  }
  if (!rows.some((r) => r.matched)) return null;

  return section(SCHEDULE.III, [
    P(
      'The rate applied in the income approach is built up in <strong>Appendix I</strong>. The ranges ' +
        'below are the indicative required rates of return the venture capital literature reports by ' +
        'stage of enterprise development, and are set out so that the concluded rate can be read ' +
        'against what is expected of a company at this stage. Required returns fall as a company ' +
        'matures because the required return is compensation for the risk that remains, and each ' +
        'milestone retires one kind of it.',
    ),
    table({
      head: ['Stage', 'Investment category', 'Indicative range'],
      rows: rows.map((r) => [
        r.matched ? `<strong>${esc(r.label)}</strong>` : esc(r.label),
        r.matched ? `<strong>${esc(r.category)}</strong>` : esc(r.category),
        `${r.matched ? '<strong>' : ''}${formatPercent(r.low, 0)} – ${formatPercent(r.high, 0)}${r.matched ? '</strong>' : ''}`,
      ]),
    }),
    P(
      'The row in bold is the stage concluded for this enterprise. These ranges are corroborative ' +
        'context drawn from the published venture capital rate-of-return literature; they are not a ' +
        'survey vintage, and they are not the source of the concluded rate. Where the rate applied ' +
        'falls outside the range for the concluded stage, the reason is stated in the income approach.',
    ),
  ]);
}

// ── assembly ─────────────────────────────────────────────────────────────────

/**
 * Every exhibit the calculation supports, in the order a reader works through
 * them: what was owned, what the business was worth, how each approach reached
 * that, how the value was split, and how the split became the conclusion.
 *
 * Returns an empty list — not a placeholder section — when there is no
 * successful calculation. A report drafted before the engine has run renders
 * exactly as it did before this module existed.
 */
// ── Appendix I — the discount rate, built up ─────────────────────────────────

/**
 * Where the income approach's discount rate came from.
 *
 * Exhibit C states the rate and discounts the flows with it. A reviewer asked
 * to accept 28% cannot check a bare percentage: the build-up *is* the argument,
 * and it is the appendix the legacy deliverable devotes a page to. Every
 * component below is what `engine/wacc.py` actually computed and
 * `results.auto.wacc` recorded, so this is transcription rather than
 * re-derivation — the appendix cannot state a premium the calculation did not
 * use.
 *
 * Null unless the run built the rate. An analyst who typed a discount rate in
 * has no build-up to disclose, and inventing a decomposition that sums to their
 * figure would be the appendix asserting reasoning nobody did.
 */
export function waccExhibit(
  results: Record<string, unknown>,
  // Takes the standard exhibit context and happens not to need it: the build-up
  // is rates and betas end to end, so nothing here is formatted per currency.
  _ctx: ExhibitContext,
): ReportPdfSection | null {
  const wacc = record(record(results.auto)?.wacc);
  if (!wacc) return null;
  const capm = record(wacc.capm) ?? {};
  const weights = record(wacc.weights) ?? {};

  const pct = (v: unknown, dp = 2) => (num(v) === null ? '—' : formatPercent(num(v) as number, dp));
  const dec = (v: unknown, dp = 4) => (num(v) === null ? '—' : (num(v) as number).toFixed(dp));

  const equity: string[][] = [
    [
      'Risk-free rate',
      pct(capm.risk_free_rate),
      'Treasury yield at the valuation date, matched to the forecast horizon',
    ],
    [
      'Equity risk premium',
      pct(capm.equity_risk_premium),
      'Expected return on equities over the risk-free rate',
    ],
    [
      'Unlevered beta',
      dec(capm.beta_unlevered),
      'Median of the guideline set, stripped of their capital structures',
    ],
    ['Relevered beta', dec(capm.beta_relevered), 'Re-levered to the subject’s target debt-to-equity'],
    [
      'Size premium',
      pct(capm.size_premium),
      text(capm.size_tier)
        ? `Size tier: ${esc(text(capm.size_tier) as string)}`
        : 'Excess return of small capitalisations',
    ],
    [
      'Company-specific risk premium',
      pct(capm.company_specific_premium),
      'Risk of this company not captured by beta or size',
    ],
  ];

  const blend: string[][] = [
    ['Cost of equity', pct(wacc.cost_of_equity), 'Modified CAPM — the build-up above'],
    ['Cost of debt (pre-tax)', pct(wacc.cost_of_debt), ''],
    ['Cost of debt (after tax)', pct(wacc.after_tax_cost_of_debt), `Tax rate ${pct(wacc.tax_rate, 1)}`],
    [
      'Weight — equity',
      pct(weights.equity, 1),
      `Target debt-to-equity ${dec(wacc.target_debt_to_equity, 2)}`,
    ],
    ['Weight — debt', pct(weights.debt, 1), ''],
  ];

  /*
   * The guideline betas, where the relevering came from. A beta is the one
   * input in the build-up that is not a published figure or a judgement — it is
   * a calculation over a chosen set of companies, and the set is the part a
   * reviewer argues with.
   */
  const comps = list(wacc.comparables)
    .map(record)
    .filter((c): c is Record<string, unknown> => c !== null);
  const compTable =
    comps.length > 0
      ? table({
          head: ['Guideline company', 'Levered beta', 'Debt/equity', 'Unlevered beta'],
          rows: comps.map((c) => [
            esc(text(c.ticker) ?? text(c.name) ?? '—'),
            dec(c.levered_beta ?? c.beta, 3),
            dec(c.debt_to_equity, 3),
            dec(c.unlevered_beta, 3),
          ]),
        })
      : null;

  return section(SCHEDULE.I, [
    P(
      'The discount rate applied in the income approach is the weighted average cost of capital. The ' +
        'cost of equity is built up under the modified capital asset pricing model and blended with the ' +
        'after-tax cost of debt at the subject’s target capital structure. The components below are the ' +
        'figures the calculation used, not a reconstruction of them.',
    ),
    table({ head: ['Cost of equity component', 'Rate', 'Basis'], rows: equity }),
    table({ head: ['Weighted average cost of capital', 'Value', 'Basis'], rows: blend }),
    compTable,
    P(
      `<strong>Concluded weighted average cost of capital: ${pct(wacc.wacc)}</strong>` +
        (wacc.used_manual_override === true
          ? ' — superseded by the analyst’s manual discount rate, which is the figure Exhibit C applies.'
          : ' — this is the rate Exhibit C discounts the projected cash flows at.'),
    ),
  ]);
}

// ── Appendix IV — the option pricing behind the allocation ───────────────────

/**
 * The Black-Scholes working Exhibit F's tranche values come out of.
 *
 * Exhibit F discloses the breakpoints, the volatility and the time to
 * liquidity, and then prints a column of tranche values. Everything a reviewer
 * needs to *check* that column is in the calculation and none of it was on the
 * page: each tranche is a call spread, C(from) − C(to), and the calls were
 * computed, used and discarded. This appendix is the page the legacy
 * deliverable devotes to them, and it is the difference between a reader
 * accepting the allocation and a reader verifying it.
 *
 * Transcription, not re-derivation — the same rule Appendix I follows.
 * `allocation.option_schedule` is what `engine/waterfall.py` priced; a second
 * Black-Scholes implementation here would be a page asserting arithmetic that
 * is only probably the arithmetic behind the conclusion.
 *
 * Null unless the run allocated by the OPM breakpoint method and recorded a
 * schedule. A current-value or PWERM allocation has no call spreads to show, and
 * a calculation stored before the engine recorded them has nothing to
 * transcribe — in both cases the honest appendix is no appendix.
 */
export function opmCalculationsExhibit(
  results: Record<string, unknown>,
  ctx: ExhibitContext,
): ReportPdfSection | null {
  const allocation = record(results.allocation);
  const schedule = list(allocation?.option_schedule)
    .map(record)
    .filter((row): row is Record<string, unknown> => row !== null);
  if (schedule.length === 0) return null;

  const { currency } = ctx;
  const assumptions = record(results.assumptions);
  const sigma = num(assumptions?.volatility);
  const rf = num(assumptions?.risk_free_rate);
  const t = num(assumptions?.time_to_exit_years) ?? num(assumptions?.expected_time_to_exit_years);
  const equity = num(results.equity_value);

  const dec = (v: unknown, dp = 4) => (num(v) === null ? '—' : (num(v) as number).toFixed(dp));

  const inputs: string[][] = [];
  if (equity !== null)
    inputs.push(['Underlying (S) — equity value allocated', formatCurrency(equity, currency, 0)]);
  if (sigma !== null) inputs.push(['Volatility (σ)', formatPercent(sigma, 1)]);
  if (t !== null) inputs.push(['Time to liquidity (T)', `${t.toFixed(2)} years`]);
  if (rf !== null) inputs.push(['Risk-free rate (r)', formatPercent(rf, 2)]);

  /*
   * One row per strike, priced once, rather than one row per tranche with its
   * two endpoints repeated. Consecutive tranches share a boundary, so the
   * per-tranche form would print every interior call twice and invite the
   * reader to check whether the two copies agree — a question about the
   * typesetting rather than about the valuation.
   */
  const rows = schedule.map((row) => {
    const strike = num(row.strike);
    return [
      strike === null ? '—' : formatCurrency(strike, currency, 0),
      dec(row.d1),
      dec(row.d2),
      dec(row.n_d1, 6),
      dec(row.n_d2, 6),
      formatCurrency(num(row.call) ?? 0, currency, 0),
    ];
  });

  /*
   * The tranche reconciliation, restated from the schedule above rather than
   * copied from Exhibit F's own column. The point of the appendix is that the
   * two agree, and a reader who has to flip pages to check that is being asked
   * to do the work this page exists to have already done.
   */
  const calls = new Map<number, number>();
  for (const row of schedule) {
    const strike = num(row.strike);
    const call = num(row.call);
    if (strike !== null && call !== null) calls.set(strike, call);
  }
  const breakpoints = list(allocation?.breakpoints)
    .map(record)
    .filter((b): b is Record<string, unknown> => b !== null);
  const spreads = breakpoints
    .map((b, i) => {
      const from = num(b.from);
      const to = num(b.to);
      const lower = from === null ? undefined : calls.get(from);
      // The final tranche runs to infinity, where the call is worth nothing.
      const upper = to === null ? 0 : calls.get(to);
      if (lower === undefined || upper === undefined) return null;
      return [
        String(i + 1),
        from === null ? '—' : formatCurrency(from, currency, 0),
        to === null ? 'and above' : formatCurrency(to, currency, 0),
        formatCurrency(lower, currency, 0),
        formatCurrency(upper, currency, 0),
        formatCurrency(lower - upper, currency, 0),
      ];
    })
    .filter((r): r is string[] => r !== null);

  return section(SCHEDULE.IV, [
    P(
      'Under the breakpoint method each share class holds a payoff that is piecewise linear in exit ' +
        'value, so its expected value is the sum of Black-Scholes call spreads struck at consecutive ' +
        'breakpoints. The tranche values in <strong>Exhibit F</strong> are those spreads. This appendix ' +
        'states the option pricing they come from: the four inputs, the call value at each breakpoint, ' +
        'and the differences between them.',
    ),
    inputs.length > 0 ? table({ head: ['Option pricing input', 'Value'], rows: inputs }) : null,
    table({
      head: ['Strike (K)', 'd₁', 'd₂', 'N(d₁)', 'N(d₂)', 'Call value C(K)'],
      rows,
    }),
    P(
      // `e^(−rT)` rather than `e<sup>−rT</sup>`: `sup` is not in the renderer's
      // ALLOWED_TAGS, so the marked-up form would be stripped to `e−rT` — a
      // formula that reads as a subtraction, in the one paragraph on the page
      // whose whole job is to let a reader recompute the column beside it.
      'Each row above is <em>C = S·N(d₁) − K·e^(−rT)·N(d₂)</em>, with ' +
        '<em>d₁ = [ln(S/K) + (r + σ²/2)T] / σ√T</em> and <em>d₂ = d₁ − σ√T</em>. A strike of zero is ' +
        'the whole equity value by definition, which is why the first call equals S and why the class ' +
        'values below it sum to the amount allocated.',
    ),
    spreads.length > 0
      ? table({
          head: ['Tranche', 'From', 'To', 'C(from)', 'C(to)', 'Tranche value'],
          rows: spreads,
        })
      : null,
    P(
      'The tranche values in the final column are the figures <strong>Exhibit F</strong> apportions ' +
        'across the classes participating in each tranche.',
    ),
  ]);
}

export function buildExhibits(calculation: CalculationRow | null, ctx: ExhibitContext): ReportPdfSection[] {
  if (!calculation || calculation.status !== 'succeeded' || !calculation.results) return [];
  // A specialty run (routes/specialty.ts) records its engine's result under
  // results.specialty — none of the 409A schedules below can read it, and its
  // own schedules live in domain/specialtyExhibits.ts.
  if (calculation.results.specialty && typeof calculation.results.specialty === 'object') {
    return buildSpecialtyExhibits(calculation, ctx);
  }
  const results = calculation.results;
  const payload = (calculation.inputs ?? {}) as Payload;
  const inputs = record(payload.inputs) ?? {};

  return [
    capitalizationExhibit(inputs, ctx),
    approachExhibit(results, ctx),
    // Immediately after B, because it qualifies B's own total: the weights in
    // that table are what this one classifies, and the sentence B opens with
    // depends on the same reading.
    levelOfValueExhibit(results, ctx),
    // And B-2 after B-1, for the same reason: it qualifies B's total from the
    // other side — where the anchor under it came from, when the anchor was
    // last year's conclusion rather than a fresh round.
    rollforwardExhibit(results, ctx),
    incomeExhibit(inputs, results, ctx),
    // Immediately after C, because it is C's supporting detail — the same
    // relationship D-1 has with D and F-1 with F.
    projectionExhibit(inputs, ctx),
    marketExhibit(inputs, results, ctx),
    // Immediately after D, because it is D's supporting detail.
    peerSetExhibit(ctx.peers, results),
    assetExhibit(results, ctx),
    allocationExhibit(results, ctx),
    // Immediately after F, because it is F's supporting detail — the same
    // relationship D-1 has with D and H-1 with H.
    volatilityExhibit(ctx, results),
    // And F-2 after F-1: F-1 argues the volatility, F-2 shows what the
    // conclusion does if that argument is wrong.
    sensitivityExhibit(inputs, results, ctx),
    // And F-3 after F-2: the same model, the same base case, the third of its
    // three market inputs — read after the two the reader was told are
    // estimates, because the point of it is that this one is not.
    rfrSensitivityExhibit(inputs, results, ctx),
    pwermExhibit(results, ctx),
    discountExhibit(results, ctx),
    // Immediately after H, because it is H's supporting detail — the same
    // relationship D-1 has with D.
    dlomDerivationExhibit(results, ctx),
    // Appendices last: they support the exhibits rather than being read in
    // sequence with them.
    waccExhibit(results, ctx),
    financialsExhibit(ctx.financials, ctx),
    // Immediately after II, because it is II's supporting detail — the same
    // relationship D-1 has with D.
    operatingMetricsExhibit(ctx.financials, ctx),
    requiredReturnExhibit(ctx),
    // Last of the appendices: it is the most granular support on the file, and
    // the only reader who wants it has already read Exhibit F and wants to
    // check it.
    opmCalculationsExhibit(results, ctx),
  ].filter((s): s is ReportPdfSection => s !== null);
}
