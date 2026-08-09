import type { ReportPdfSummary, ChartSpec } from '@n409/report/pdf';
import type { CalculationRow } from '../repos/calculations.js';
import { stageLabel } from './developmentStage.js';

/**
 * Executive summary + charts for the report PDF, derived from the calculation
 * that actually produced the conclusion.
 *
 * A 409A deliverable is read by two audiences. An auditor reads the
 * methodology sections; a board member reads one number and wants to know how
 * it was reached. This builds the second reader's page straight from the
 * engine output — headline FMV per share, the figures that qualify it, a
 * conclusion-of-value statement, and two charts:
 *
 *   * equity value by approach, so the weighting is visible at a glance; and
 *   * the discount waterfall — marketable common value per share, less DLOC,
 *     less DLOM, equals fair market value — which is exactly the chain
 *     `compute` applies (`fmv = base × (1 − DLOC) × (1 − DLOM)`).
 *
 * Everything is defensive: a partial or unfamiliar results shape degrades to
 * fewer figures rather than throwing inside a PDF render.
 */

export const APPROACH_LABELS: Record<string, string> = {
  asset: 'Asset approach',
  opm_backsolve: 'OPM backsolve',
  income: 'Income (DCF)',
  market: 'Market (comparables)',
};

/**
 * How the allocation is named on the summary page.
 *
 * Two vocabularies land here and both have to resolve. `results.allocation_method`
 * is the method the analyst chose — opm / pwerm / hybrid / cvm. `results.allocation.method`
 * is the *mechanism* the engine then used, and it is the only thing an OPM run
 * carried until the engine started emitting `allocation_method` on that path
 * too: every calculation stored before that change has `opm_waterfall`,
 * `opm_single_breakpoint` or `as_converted` and nothing else.
 *
 * Unmapped keys fall through to an upper-cased echo of the key, so the gap was
 * silent and reached paper: a board-facing 409A read "Allocation method:
 * OPM_WATERFALL". The mechanism names are mapped here rather than only fixed in
 * the engine because re-rendering an old report must not change what it says —
 * the reader gets the right words for the allocation that actually ran.
 */
export const ALLOCATION_LABELS: Record<string, string> = {
  opm: 'Option pricing model',
  pwerm: 'PWERM',
  hybrid: 'Hybrid (OPM + PWERM)',
  cvm: 'Current value method',
  monte_carlo: 'Monte Carlo simulation',
  // Mechanisms, as `allocation.method` reports them. Monte Carlo names itself
  // identically on both fields — the simulation *is* the mechanism, so there is
  // no second vocabulary for it the way the OPM has three branches.
  opm_waterfall: 'Option pricing model (cap-table waterfall)',
  opm_single_breakpoint: 'Option pricing model (single breakpoint)',
  as_converted: 'As-converted (pro-rata)',
  cvm_waterfall: 'Current value method (cap-table waterfall)',
  cvm_single_preference: 'Current value method (single preference)',
  cvm_pro_rata: 'Current value method (pro-rata)',
  cvm_common_only: 'Current value method (common only)',
};

const DLOM_LABELS: Record<string, string> = {
  chaffee: 'Chaffee protective-put model',
  finnerty: 'Finnerty average-strike put model',
  qualitative: 'Qualitative (analyst judgement)',
};

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `$1,234.5678` at four decimals — a per-share FMV is quoted to the cent-fraction. */
export function formatCurrency(value: number, currency: string, fractionDigits = 2): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    // An unknown ISO code must not sink a report render.
    return `${currency} ${value.toFixed(fractionDigits)}`;
  }
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

interface ResultsShape {
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
 * The pre-discount common value per share: what the allocation produced before
 * DLOC and DLOM. Taken from the allocation when it reports it, otherwise
 * inverted from the FMV — `compute` guarantees the identity, and inverting
 * keeps the waterfall closing exactly even when the allocation block is thin.
 */
export function marketableValuePerShare(results: ResultsShape): number | null {
  const direct = num(results.allocation?.common_per_share);
  if (direct !== null && direct > 0) return direct;
  const fmv = num(results.fmv_per_share);
  const dloc = num(results.discounts?.dloc) ?? 0;
  const dlom = num(results.discounts?.dlom) ?? 0;
  const factor = (1 - dloc) * (1 - dlom);
  if (fmv === null || factor <= 0) return null;
  return fmv / factor;
}

/** Equity value by weighted approach, largest first — the bar chart. */
export function approachChart(results: ResultsShape, currency: string): ChartSpec | null {
  const approaches = results.approaches;
  if (!approaches || typeof approaches !== 'object') return null;
  const points = Object.entries(approaches)
    .map(([key, value]) => ({
      label: APPROACH_LABELS[key] ?? key,
      weight: num(value?.weight) ?? 0,
      value: num(value?.equity_value) ?? 0,
    }))
    .filter((p) => p.weight > 0)
    .sort((a, b) => b.value - a.value);
  if (points.length === 0) return null;

  const weighted = num(results.equity_value);
  return {
    type: 'bar',
    title: 'Equity value by approach',
    points: points.map((p) => ({
      label: `${p.label} · ${formatPercent(p.weight, 0)}`,
      value: p.value,
      display: formatCurrency(p.value, currency, 0),
    })),
    note:
      weighted !== null
        ? `Weighted concluded equity value: ${formatCurrency(weighted, currency, 0)}.`
        : undefined,
  };
}

/**
 * Approach weighting as a ring.
 *
 * The bar chart above it answers "how big is each approach"; this answers "how
 * much did each one count", which is a different question and the one a
 * reviewer challenges. Showing it as parts of a whole makes the weights
 * self-evidently sum to 100% — a set of bars requires the reader to add up
 * four percentages and trust the result.
 */
export function weightingChart(results: ResultsShape): ChartSpec | null {
  const approaches = results.approaches;
  if (!approaches || typeof approaches !== 'object') return null;
  const slices = Object.entries(approaches)
    .map(([key, value]) => ({
      label: APPROACH_LABELS[key] ?? key,
      weight: num(value?.weight) ?? 0,
    }))
    .filter((s) => s.weight > 0);
  // A single approach at 100% is a full ring saying nothing the sentence
  // above it does not already say.
  if (slices.length < 2) return null;

  return {
    type: 'donut',
    title: 'Approach weighting',
    slices: slices.map((s) => ({
      label: s.label,
      value: s.weight,
      display: formatPercent(s.weight, 0),
    })),
    center: `${slices.length}`,
    center_note: 'approaches',
    note: 'Weights applied to each approach in concluding equity value.',
  };
}

/** One point per prior valuation of this company, oldest first. */
export interface HistoryPoint {
  /** ISO date the calculation was produced. */
  as_of: string;
  fmv_per_share: number;
}

/**
 * FMV per share over time.
 *
 * A board's first question about a new 409A is how it compares with the last
 * one. Answering it inside the report — rather than leaving the reader to find
 * the previous PDF — is the difference between a document and an answer.
 * Suppressed below two points, where a "trend" would be a single dot.
 */
export function historyChart(history: readonly HistoryPoint[], currency: string): ChartSpec | null {
  const points = history.filter((h) => Number.isFinite(h.fmv_per_share));
  if (points.length < 2) return null;

  return {
    type: 'line',
    title: 'Fair market value per common share over time',
    points: points.map((p) => ({
      label: p.as_of.slice(0, 10),
      value: p.fmv_per_share,
      display: formatCurrency(p.fmv_per_share, currency, 4),
    })),
    note: 'Concluded FMV of each prior valuation of this company, oldest first.',
  };
}

/** Marketable value per share → DLOC → DLOM → FMV. */
export function discountChart(results: ResultsShape, currency: string): ChartSpec | null {
  const fmv = num(results.fmv_per_share);
  const base = marketableValuePerShare(results);
  if (fmv === null || base === null || base <= 0) return null;

  const dloc = num(results.discounts?.dloc) ?? 0;
  const dlom = num(results.discounts?.dlom) ?? 0;
  const afterDloc = base * (1 - dloc);
  const points: Array<{ label: string; value: number; display: string }> = [];
  if (dloc > 0) {
    points.push({
      label: `Less DLOC ${formatPercent(dloc)}`,
      value: afterDloc - base,
      display: `−${formatCurrency(base - afterDloc, currency, 4)}`,
    });
  }
  if (dlom > 0) {
    points.push({
      label: `Less DLOM ${formatPercent(dlom)}`,
      value: fmv - afterDloc,
      display: `−${formatCurrency(afterDloc - fmv, currency, 4)}`,
    });
  }
  if (points.length === 0) return null;

  return {
    type: 'waterfall',
    title: 'From marketable value to fair market value (per common share)',
    start: {
      label: 'Marketable common',
      value: base,
      display: formatCurrency(base, currency, 4),
    },
    steps: points,
    end_label: 'Concluded FMV',
    end_value: fmv,
    end_display: formatCurrency(fmv, currency, 4),
    note: 'Discounts are applied multiplicatively, in the order shown.',
  };
}

export interface SummaryContext {
  currency: string;
  /** Valuation date as the report states it (YYYY-MM-DD). */
  valuationDate?: string | null;
  companyName: string;
  /**
   * Prior concluded values for this company, oldest first, for the trend
   * chart. Omit (or pass fewer than two) and the chart is left out.
   */
  history?: readonly HistoryPoint[];
  /**
   * AICPA stage of enterprise development, as the analyst concluded it. Absent
   * until they have — it is never inferred, so a report with no stage on it is
   * a report where nobody has said which one applies.
   */
  developmentStage?: number | null;
}

/**
 * Builds the summary page for a report version. Returns null when there is no
 * successful calculation to summarise — a report drafted before the engine has
 * run keeps its previous shape rather than showing an empty headline.
 */
export function buildReportSummary(
  calculation: CalculationRow | null,
  context: SummaryContext,
): ReportPdfSummary | null {
  if (!calculation || calculation.status !== 'succeeded' || !calculation.results) return null;
  const results = calculation.results as ResultsShape;
  const fmv = num(results.fmv_per_share);
  if (fmv === null) return null;

  const { currency } = context;
  const equity = num(results.equity_value);
  const dloc = num(results.discounts?.dloc);
  const dlom = num(results.discounts?.dlom);
  const dilutedShares = num(results.fully_diluted_common);
  const allocation = String(results.allocation_method ?? results.allocation?.method ?? 'opm').toLowerCase();
  const volatility = num(results.assumptions?.volatility);
  const timeToExit =
    num(results.assumptions?.time_to_exit_years) ?? num(results.assumptions?.expected_time_to_exit_years);

  const figures: ReportPdfSummary['figures'] = [];
  if (equity !== null) {
    figures.push({ label: 'Concluded equity value', value: formatCurrency(equity, currency, 0) });
  }
  if (dilutedShares !== null && dilutedShares > 0) {
    // Which count this is depends on how the equity was allocated, and the two
    // are different numbers. Under the cap-table waterfall the option pool is
    // its own class holding its own value, so the concluded per-share figure is
    // over the common classes alone; under the aggregate models the pool is
    // folded into fully diluted common and shares one slice with it.
    //
    // Naming the wrong one is what made the page contradict itself: it printed
    // the fully diluted count beside a common equity value that excluded the
    // pool, so a board dividing the two got a figure well under the FMV the
    // same page asked them to adopt. The engine now says which basis it used
    // (`fully_diluted_basis`); older calculations predate the field and took
    // the aggregate wording, which is what they were computed on.
    const capTableBasis = results.fully_diluted_basis === 'cap_table_common';
    figures.push({
      label: capTableBasis ? 'Common shares outstanding' : 'Fully diluted common',
      value: new Intl.NumberFormat('en-US').format(Math.round(dilutedShares)),
      note: capTableBasis
        ? 'Common classes per the cap table; options are allocated separately'
        : 'Common shares plus options outstanding',
    });
  }
  figures.push({
    label: 'Allocation method',
    value: ALLOCATION_LABELS[allocation] ?? allocation.toUpperCase(),
  });
  if (dloc !== null) {
    figures.push({ label: 'Discount for lack of control', value: formatPercent(dloc) });
  }
  if (dlom !== null) {
    const method = results.discounts?.dlom_method;
    figures.push({
      label: 'Discount for lack of marketability',
      value: formatPercent(dlom),
      note: typeof method === 'string' ? (DLOM_LABELS[method] ?? method) : undefined,
    });
  }
  /*
   * The premise every other choice in the report rests on.
   *
   * The AICPA practice aid frames the valuation around where the company sits
   * on its six-stage scale: it is what justifies weighting the market approach
   * over the income approach, reaching for a backsolve rather than a DCF, and
   * concluding a marketability discount at the top of the supportable range. A
   * reviewing auditor looks for it stated, and it belongs on the page they read
   * first rather than three chapters in.
   */
  const stage = stageLabel(context.developmentStage);
  if (stage) {
    const [heading, detail] = stage.split(' — ');
    figures.push({
      label: 'Stage of enterprise development',
      value: heading!,
      note: detail,
    });
  }

  if (volatility !== null || timeToExit !== null) {
    const parts: string[] = [];
    if (volatility !== null) parts.push(`σ ${formatPercent(volatility, 0)}`);
    if (timeToExit !== null) parts.push(`T ${timeToExit.toFixed(2)}y`);
    figures.push({ label: 'Key assumptions', value: parts.join(' · ') });
  }

  const asOf = context.valuationDate ? ` as of ${context.valuationDate}` : '';
  const statement =
    `Based on the analysis set out in this report, it is our opinion that the fair market value ` +
    `of one share of common stock of ${context.companyName}${asOf} is ` +
    `${formatCurrency(fmv, currency, 4)} per share, on a non-marketable, minority-interest basis.`;

  // Ordered as the page is read: what the approaches produced, how they were
  // weighted, how the discounts got from there to the conclusion, and how the
  // conclusion compares with the last one.
  const charts = [
    approachChart(results, currency),
    weightingChart(results),
    discountChart(results, currency),
    historyChart(context.history ?? [], currency),
  ].filter((c): c is ChartSpec => c !== null);

  return {
    headline: {
      label: 'Fair market value per common share',
      value: formatCurrency(fmv, currency, 4),
      note: context.valuationDate
        ? `Valuation date ${context.valuationDate} · engine ${calculation.engine_version}`
        : `Engine ${calculation.engine_version}`,
    },
    figures,
    statement,
    charts,
  };
}
