import type { ReportPdfSummary, ChartSpec } from '@n409/report/pdf';
import type { CalculationRow } from '../repos/calculations.js';

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

const ALLOCATION_LABELS: Record<string, string> = {
  opm: 'Option pricing model',
  pwerm: 'PWERM',
  hybrid: 'Hybrid (OPM + PWERM)',
  cvm: 'Current value method',
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
    figures.push({
      label: 'Fully diluted common',
      value: new Intl.NumberFormat('en-US').format(Math.round(dilutedShares)),
      note: 'Common shares plus options outstanding',
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

  const charts = [approachChart(results, currency), discountChart(results, currency)].filter(
    (c): c is ChartSpec => c !== null,
  );

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
