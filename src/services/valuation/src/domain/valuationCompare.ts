/*
 * The label maps are imported, not restated. Both were local copies here and
 * both had gone stale against the engine: the allocation map held the four
 * analyst-chosen methods and none of the seven *mechanisms* `allocation.method`
 * reports, and the DLOM map held three of eight methods. Since `allocationMethod`
 * falls back to an upper-cased echo of the key, a comparison of two OPM runs
 * offered "OPM_WATERFALL" as the answer to what allocation they used — the same
 * defect `ALLOCATION_LABELS` was written to fix on the report's summary page,
 * reintroduced by copying the map instead of importing it.
 */
import {
  ALLOCATION_LABELS,
  APPROACH_LABELS,
  DLOM_LABELS,
  formatCurrency,
  formatPercent,
  num,
} from './reportSummary.js';
import { toCsv } from './csv.js';
import { isSpecialtyKind } from './specialty.js';
import type { ValuationKind } from './valuation.js';
import { numberFormat } from './numberFormat.js';

/**
 * Side-by-side comparison of two valuations.
 *
 * The question this answers is the one every board asks when a new 409A lands:
 * *why is the number different from last time?* Today that is answered by
 * opening two reports in two tabs and reading two PDFs against each other,
 * which is slow and, worse, unreliable — the figure that moved is rarely the
 * headline one. It is the volatility assumption, or a DLOM method that changed,
 * or one approach quietly picking up weight the other lost.
 *
 * So this does not diff documents. It diffs the engine `results` objects that
 * produced them, metric by metric, and reports the delta on each — which turns
 * "it went from $1.42 to $1.87" into "the DLOM fell 8 points and the market
 * approach gained 20 points of weight".
 *
 * Pure and defensive: the two sides may come from different engine versions
 * with different result shapes, so every field is optional on both sides and a
 * row that neither side reports is dropped rather than rendered as a pair of
 * dashes.
 */

/** How a metric's value should be read, and therefore rendered and compared. */
export type CompareFormat =
  | 'currency'
  | 'currency_precise'
  | 'percent'
  | 'integer'
  | 'number'
  | 'text'
  /**
   * A number off a specialty engine's own payload, whose unit this module does
   * not know. Rendered with grouping and up to four decimals and no symbol —
   * printing a currency symbol we have not established would be a claim, and a
   * ratio shown as "$0.20" is a worse answer than "0.2".
   */
  | 'scalar';

export interface CompareRow {
  key: string;
  label: string;
  format: CompareFormat;
  /** Raw values — null when that side does not report the metric. */
  a: number | string | null;
  b: number | string | null;
  /** Preformatted for display, so the UI and the API agree on rounding. */
  a_display: string | null;
  b_display: string | null;
  /** b − a. Null for text metrics and when either side is missing. */
  delta: number | null;
  delta_display: string | null;
  /** (b − a) / |a|. Null when a is zero or either side is missing. */
  pct_change: number | null;
  /**
   * Whether the two sides differ at all. Text metrics compare by equality;
   * numeric ones by an exact delta of zero.
   */
  changed: boolean;
}

export interface CompareGroup {
  key: string;
  title: string;
  rows: CompareRow[];
}

interface Results {
  /**
   * A specialty engine's own payload. Specialty runs persist
   * `results = { kind, specialty: <engine result> }` (routes/specialty.ts) and
   * write their headline into the calculation's typed columns instead — so
   * none of the keys below exist on one, and every 409A row above drops out.
   */
  specialty?: unknown;
  fmv_per_share?: unknown;
  equity_value?: unknown;
  common_equity_value?: unknown;
  fully_diluted_common?: unknown;
  fully_diluted_basis?: unknown;
  allocation_method?: unknown;
  allocation?: { method?: unknown; common_per_share?: unknown } | null;
  approaches?: Record<string, { weight?: unknown; equity_value?: unknown }> | null;
  discounts?: { dloc?: unknown; dlom?: unknown; dlom_method?: unknown } | null;
  assumptions?: {
    volatility?: unknown;
    risk_free_rate?: unknown;
    time_to_exit_years?: unknown;
    expected_time_to_exit_years?: unknown;
  } | null;
}

/**
 * The vocabulary a kind's engine results are written in.
 *
 * The 409A engine writes one shape — `fmv_per_share`, `approaches`,
 * `discounts` — and every kind that runs it shares it, so a 409A and an ASC 718
 * run of the same company diff metric for metric. Each specialty engine writes
 * its own instead, and two of them have no key in common: an EMI run's
 * `amv_per_share` and an IFRS 2 run's expense attribution are not the same
 * measurement under two names.
 */
export function comparisonFamily(kind: string): string {
  return isSpecialtyKind(kind as ValuationKind) ? kind : '409a-engine';
}

/**
 * Whether two kinds can be put in one delta column at all.
 *
 * The same judgement the route already makes about currency: a signed number
 * between two figures that do not measure the same thing is worse than no
 * number. Two different specialty kinds share no metric, so every row would be
 * a value against a dash — a table of "changed" that reports only that the two
 * engagements are different products, which the picker already said.
 */
export function comparableKinds(a: string, b: string): boolean {
  return comparisonFamily(a) === comparisonFamily(b);
}

/** One side of the comparison: a valuation and the calculation being read. */
export interface CompareSide {
  valuation_id: string;
  company_name: string;
  kind: string;
  currency: string;
  state: string;
  /** Null when the valuation has never produced a successful calculation. */
  calculation_id: string | null;
  engine_version: string | null;
  calculated_at: string | null;
  valuation_date: string | null;
  results: Record<string, unknown> | null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function formatValue(value: number | string | null, format: CompareFormat, currency: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  switch (format) {
    case 'currency':
      return formatCurrency(value, currency, 0);
    case 'currency_precise':
      return formatCurrency(value, currency, 4);
    case 'percent':
      return formatPercent(value);
    case 'integer':
      return numberFormat('en-US').format(Math.round(value));
    case 'number':
      return value.toFixed(2);
    case 'scalar':
      return formatScalar(value);
    case 'text':
      return String(value);
  }
}

/**
 * A number whose unit is unknown, printed as itself.
 *
 * Grouped so a share count stays readable, and trailing zeros trimmed so a
 * boolean-ish 1 does not arrive as "1.0000" — these paths carry discounts,
 * counts, ratios and per-share figures indiscriminately, and the only honest
 * rendering is the number the engine reported.
 */
function formatScalar(value: number): string {
  return numberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
}

/**
 * Signed delta, formatted the same way as the values it sits between.
 *
 * Percentages read as point moves rather than percentages-of-percentages: a
 * DLOM going 30% → 22% is "−8.0 pts", not "−26.7%", because that is the number
 * an analyst defends.
 */
function formatDelta(delta: number, format: CompareFormat, currency: string): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const magnitude = Math.abs(delta);
  switch (format) {
    case 'currency':
      return `${sign}${formatCurrency(magnitude, currency, 0)}`;
    case 'currency_precise':
      return `${sign}${formatCurrency(magnitude, currency, 4)}`;
    case 'percent':
      return `${sign}${(magnitude * 100).toFixed(1)} pts`;
    case 'integer':
      return `${sign}${numberFormat('en-US').format(Math.round(magnitude))}`;
    case 'scalar':
      return `${sign}${formatScalar(magnitude)}`;
    default:
      return `${sign}${magnitude.toFixed(2)}`;
  }
}

function row(
  key: string,
  label: string,
  format: CompareFormat,
  a: number | string | null,
  b: number | string | null,
  currency: string,
): CompareRow | null {
  // A metric neither engine run reported is not a difference — it is silence,
  // and rendering it as a row of dashes buries the rows that matter.
  if (a === null && b === null) return null;

  const numeric = typeof a === 'number' && typeof b === 'number';
  const delta = numeric ? b - a : null;
  const pct = numeric && a !== 0 ? (b - a) / Math.abs(a) : null;

  return {
    key,
    label,
    format,
    a,
    b,
    a_display: formatValue(a, format, currency),
    b_display: formatValue(b, format, currency),
    delta,
    delta_display: delta === null ? null : formatDelta(delta, format, currency),
    pct_change: pct,
    changed: numeric ? delta !== 0 : a !== b,
  };
}

function allocationMethod(r: Results): string | null {
  const raw = text(r.allocation_method ?? r.allocation?.method);
  if (raw === null) return null;
  return ALLOCATION_LABELS[raw.toLowerCase()] ?? raw.toUpperCase();
}

function timeToExit(r: Results): number | null {
  return num(r.assumptions?.time_to_exit_years) ?? num(r.assumptions?.expected_time_to_exit_years);
}

/**
 * Whether this run's per-share figure was taken over the cap table's common
 * classes alone. Absent on calculations stored before the engine said so, which
 * were computed on common + options — the aggregate wording, which is the
 * default here.
 */
function capTableBasis(r: Results): boolean {
  return r.fully_diluted_basis === 'cap_table_common';
}

/**
 * The comparison table for two sides.
 *
 * Currency is taken from side A: comparing two valuations denominated
 * differently is a question the UI has to answer before it gets here, and
 * silently mixing symbols in one column would be worse than refusing.
 */
export function compareValuations(a: CompareSide, b: CompareSide): CompareGroup[] {
  const ra = (a.results ?? {}) as Results;
  const rb = (b.results ?? {}) as Results;
  const currency = a.currency;
  const make = (
    key: string,
    label: string,
    format: CompareFormat,
    left: number | string | null,
    right: number | string | null,
  ) => row(key, label, format, left, right, currency);

  const conclusion = [
    make(
      'fmv_per_share',
      'FMV per common share',
      'currency_precise',
      num(ra.fmv_per_share),
      num(rb.fmv_per_share),
    ),
    make('equity_value', 'Concluded equity value', 'currency', num(ra.equity_value), num(rb.equity_value)),
    make(
      'common_equity_value',
      'Common equity value',
      'currency',
      num(ra.common_equity_value),
      num(rb.common_equity_value),
    ),
    make(
      'fully_diluted_common',
      // The row is the denominator behind the FMV above it, and the two
      // allocation families divide by different counts — the cap table's
      // common classes under the breakpoint waterfall (the option pool is its
      // own class there), common + options under the aggregate models. Calling
      // both "fully diluted" would mislabel a waterfall run against the very
      // common equity value sitting one row up. Named from the pair, so a
      // comparison of two runs of the same engagement — which is what this
      // page is for — reads correctly; a mixed pair keeps the neutral wording
      // and the delta is what shows the basis moved.
      capTableBasis(ra) && capTableBasis(rb) ? 'Common shares outstanding' : 'Fully diluted common',
      'integer',
      num(ra.fully_diluted_common),
      num(rb.fully_diluted_common),
    ),
  ];

  const method = [
    make('allocation_method', 'Allocation method', 'text', allocationMethod(ra), allocationMethod(rb)),
    make('dloc', 'Discount for lack of control', 'percent', num(ra.discounts?.dloc), num(rb.discounts?.dloc)),
    make(
      'dlom',
      'Discount for lack of marketability',
      'percent',
      num(ra.discounts?.dlom),
      num(rb.discounts?.dlom),
    ),
    make(
      'dlom_method',
      'DLOM model',
      'text',
      dlomLabel(ra.discounts?.dlom_method),
      dlomLabel(rb.discounts?.dlom_method),
    ),
  ];

  const assumptions = [
    make(
      'volatility',
      'Volatility (σ)',
      'percent',
      num(ra.assumptions?.volatility),
      num(rb.assumptions?.volatility),
    ),
    make(
      'risk_free_rate',
      'Risk-free rate',
      'percent',
      num(ra.assumptions?.risk_free_rate),
      num(rb.assumptions?.risk_free_rate),
    ),
    make('time_to_exit', 'Time to exit (years)', 'number', timeToExit(ra), timeToExit(rb)),
  ];

  // Approaches are keyed by the engine, and the two runs need not use the same
  // set — an approach dropped between runs is exactly the kind of change this
  // view exists to surface, so the union is taken rather than the intersection.
  const approachKeys = [
    ...new Set([...Object.keys(ra.approaches ?? {}), ...Object.keys(rb.approaches ?? {})]),
  ];
  const approaches = approachKeys.flatMap((key) => {
    const label = APPROACH_LABELS[key] ?? key;
    return [
      make(
        `approach_${key}_weight`,
        `${label} — weight`,
        'percent',
        num(ra.approaches?.[key]?.weight),
        num(rb.approaches?.[key]?.weight),
      ),
      make(
        `approach_${key}_value`,
        `${label} — equity value`,
        'currency',
        num(ra.approaches?.[key]?.equity_value),
        num(rb.approaches?.[key]?.equity_value),
      ),
    ];
  });

  const groups: CompareGroup[] = [
    { key: 'conclusion', title: 'Conclusion', rows: conclusion.filter(isRow) },
    { key: 'method', title: 'Method & discounts', rows: method.filter(isRow) },
    { key: 'assumptions', title: 'Key assumptions', rows: assumptions.filter(isRow) },
    { key: 'approaches', title: 'Approach weighting', rows: approaches.filter(isRow) },
    { key: 'specialty', title: 'Specialty result', rows: specialtyRows(ra, rb, currency) },
  ];

  return groups.filter((g) => g.rows.length > 0);
}

/**
 * The differing leaves of two specialty payloads.
 *
 * Every row above reads a key the 409A engine writes. A specialty run reports
 * a different vocabulary entirely — an EMI run has `amv_per_share` and a
 * qualification checklist, an ASC 820 measurement has a fair-value hierarchy —
 * so all of them dropped out and `compareValuations` returned *no groups at
 * all*. The view then printed "Every metric these two report is identical"
 * over two runs that had nothing in common but the sentence: the comparator
 * had not found no differences, it had looked in the wrong place.
 *
 * Rather than hand-model eleven engine vocabularies, the payloads are compared
 * leaf by leaf on the union of their dotted paths — the same shape the
 * workbook's audit sheets take, and the same shape a re-run's diff wants. A
 * key one side dropped is a real finding, so the union is taken rather than
 * the intersection, exactly as approach keys are above.
 *
 * Paths are the labels. They are the engine's own words, and inventing prose
 * for `qualification.checks.individual_limit.passed` would put a name on a
 * figure that this module cannot actually interpret — the mistake specialty
 * captions were written to stop.
 */
function specialtyRows(ra: Results, rb: Results, currency: string): CompareRow[] {
  const a = flattenSpecialty(ra.specialty);
  const b = flattenSpecialty(rb.specialty);
  if (a.size === 0 && b.size === 0) return [];

  const paths = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y));
  return paths
    .map((path) => {
      const left = a.get(path) ?? null;
      const right = b.get(path) ?? null;
      // Format follows the values, not the path: a leaf is numeric only when
      // both sides that report it are numbers, so a field that changed type
      // between engine versions compares as text instead of silently dropping
      // its delta.
      const numeric =
        (typeof left === 'number' || left === null) &&
        (typeof right === 'number' || right === null) &&
        (typeof left === 'number' || typeof right === 'number');
      return row(
        `specialty_${path}`,
        path,
        numeric ? 'scalar' : 'text',
        numeric ? left : stringify(left),
        numeric ? right : stringify(right),
        currency,
      );
    })
    .filter(isRow);
}

/** Nesting past this is stringified — a malformed blob cannot become a table. */
const MAX_SPECIALTY_DEPTH = 8;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text form of a scalar leaf; null stays null so a missing side reads as one. */
function stringify(value: number | string | null): string | null {
  return value === null ? null : String(value);
}

/**
 * A specialty payload as `path → scalar`.
 *
 * Arrays of scalars collapse to one joined leaf and arrays of objects keep
 * indexed paths, matching `flattenForAudit` in the workbook so the same run
 * addresses the same way in the export and in this diff. Empty objects and
 * arrays are dropped rather than emitted as null leaves: an absent branch is
 * not a metric, and a column of dashes buries the rows that moved.
 */
function flattenSpecialty(source: unknown): Map<string, number | string | null> {
  const out = new Map<string, number | string | null>();
  if (!isPlainObject(source)) return out;

  const walk = (value: unknown, path: string, depth: number): void => {
    if (value === null || value === undefined) {
      if (path !== '') out.set(path, null);
      return;
    }
    if (depth >= MAX_SPECIALTY_DEPTH) {
      out.set(path, JSON.stringify(value) ?? String(value));
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      if (value.every((v) => !isPlainObject(v) && !Array.isArray(v))) {
        out.set(path, value.map((v) => (v === null || v === undefined ? '' : String(v))).join('; '));
        return;
      }
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) return;
      for (const key of keys) walk(value[key], path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    if (typeof value === 'number') {
      // A non-finite figure is a computation that failed, not a value; kept as
      // its own text so the row shows "Infinity" instead of comparing as null.
      out.set(path, Number.isFinite(value) ? value : String(value));
      return;
    }
    out.set(path, typeof value === 'boolean' ? String(value) : String(value));
  };

  walk(source, '', 0);
  return out;
}

function dlomLabel(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  return DLOM_LABELS[raw.toLowerCase()] ?? raw;
}

function isRow(r: CompareRow | null): r is CompareRow {
  return r !== null;
}

/** Rows that actually moved, across every group — the "what changed" summary. */
export function changedRows(groups: readonly CompareGroup[]): CompareRow[] {
  return groups.flatMap((g) => g.rows).filter((r) => r.changed);
}

/**
 * Which way a metric moved, as a word rather than a colour.
 *
 * The screen colours the delta green or red, which is unreadable to the ~8% of
 * men with a red-green deficiency and carries nothing at all into a CSV. This
 * is the same judgement stated in text, and it is the same judgement: up is not
 * good and down is not bad — a rising DLOM pushes the FMV *down*, so discounts
 * read the other way round. Metrics we have not reasoned about get 'changed',
 * not a guess.
 */
export const INVERTED_METRICS: ReadonlySet<string> = new Set(['dloc', 'dlom']);

export type CompareDirection = 'up' | 'down' | 'changed' | 'unchanged';

export function direction(row: Pick<CompareRow, 'key' | 'delta' | 'changed'>): CompareDirection {
  if (!row.changed) return 'unchanged';
  if (row.delta === null || row.delta === 0) return 'changed';
  return row.delta > 0 ? 'up' : 'down';
}

/** Whether a move in this direction is favourable to the concluded value. */
export function isFavourable(row: Pick<CompareRow, 'key' | 'delta' | 'changed'>): boolean | null {
  const dir = direction(row);
  if (dir === 'up' || dir === 'down') {
    return INVERTED_METRICS.has(row.key) ? dir === 'down' : dir === 'up';
  }
  return null;
}

/**
 * The comparison as a CSV.
 *
 * The board pack is built in a spreadsheet, and until now the only way to get
 * these numbers into one was to retype them off the screen — which is how a
 * transposed digit reaches a board. Every column the page shows is here,
 * including the raw values beside the formatted ones: the formatted column is
 * what a reader checks against the report, the raw one is what a formula can
 * actually compute on.
 *
 * Direction travels as a word rather than as the screen's colour, because a CSV
 * has no colour and a reader with a red-green deficiency never had it either.
 */
export function comparisonCsv(
  a: Pick<CompareSide, 'company_name' | 'valuation_date'>,
  b: Pick<CompareSide, 'company_name' | 'valuation_date'>,
  groups: readonly CompareGroup[],
): string {
  const sideLabel = (side: Pick<CompareSide, 'company_name' | 'valuation_date'>): string =>
    side.valuation_date ? `${side.company_name} (${side.valuation_date})` : side.company_name;

  return toCsv(
    [
      'group',
      'metric',
      'a_label',
      'a_value',
      'a_raw',
      'b_label',
      'b_value',
      'b_raw',
      'change',
      'change_raw',
      'percent_change',
      'direction',
      'changed',
    ],
    groups.flatMap((group) =>
      group.rows.map((row) => ({
        group: group.title,
        metric: row.label,
        a_label: sideLabel(a),
        a_value: row.a_display ?? '',
        a_raw: row.a ?? '',
        b_label: sideLabel(b),
        b_value: row.b_display ?? '',
        b_raw: row.b ?? '',
        change: row.delta_display ?? '',
        change_raw: row.delta ?? '',
        // Written as a proportion, not a pre-multiplied percentage: the header
        // says percent_change and a spreadsheet's own percent format multiplies
        // by 100, so shipping 12.5 for a 12.5% move renders as 1250%.
        percent_change: row.pct_change ?? '',
        direction: direction(row),
        changed: row.changed ? 'yes' : 'no',
      })),
    ),
  );
}

/**
 * One sentence on the headline move, for the top of the view and for anywhere
 * a comparison has to fit on a single line.
 */
export function headlineSummary(groups: readonly CompareGroup[]): string | null {
  const fmv = groups.flatMap((g) => g.rows).find((r) => r.key === 'fmv_per_share');
  if (!fmv || fmv.a_display === null || fmv.b_display === null) return null;
  if (!fmv.changed) return `FMV per share is unchanged at ${fmv.a_display}.`;
  const direction = (fmv.delta ?? 0) > 0 ? 'up' : 'down';
  const pct = fmv.pct_change === null ? '' : ` (${formatPercent(Math.abs(fmv.pct_change))})`;
  return `FMV per share is ${direction} from ${fmv.a_display} to ${fmv.b_display}${pct}.`;
}
