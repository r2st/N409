import { CHART_SERIES_LIMITS, type ReportPdfSummary, type ChartSpec } from '@n409/report/pdf';
import type { CalculationRow } from '../repos/calculations.js';
import { stageLabel } from './developmentStage.js';
import { volatilityNarrative } from './volatility.js';
import type { VolatilityEstimateRow } from '../repos/volatilityEstimates.js';

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

/**
 * How the marketability discount's method is named, for every value the engine
 * puts in `discounts.dlom_method`.
 *
 * Study rows carry their own names; everything else is a model. `weighted` is
 * what a `dlom_methods` blend reports (compute.py `_resolve_discounts`) — the
 * legs and their weights are Exhibit H-1's business, so here it says only that
 * several were weighted.
 *
 * This lives beside `ALLOCATION_LABELS` for the reason that map documents, and
 * for the same reason it is exported: the vocabulary was written out three
 * times — here, in Exhibit H's Basis column, and in the valuation comparison —
 * and two of the three listed three methods of the eight the engine dispatches
 * on. Unmapped keys fall through to an echo of the key, so both gaps were
 * silent and both reached a reader. A 409A concluded on a restricted-stock
 * blend printed "restricted_stock" on its summary page while Exhibit H of the
 * same PDF named the studies properly, and the comparison view — whose entire
 * premise is telling a board that the DLOM *method* changed — answered that
 * question with two database slugs.
 */
export const DLOM_LABELS: Record<string, string> = {
  chaffee: 'Chaffee protective-put model',
  finnerty: 'Finnerty average-strike put model',
  ghaidarov: 'Ghaidarov average-strike put model',
  longstaff: 'Longstaff upper bound',
  restricted_stock: 'Restricted-stock studies',
  pre_ipo: 'Pre-IPO transaction studies',
  qualitative: 'Qualitative — analyst judgement',
  weighted: 'Several methods, weighted',
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

/**
 * A rate stated to the precision it was actually applied at.
 *
 * `formatPercent` rounds to a tenth, which is right for a rate that only has to
 * be read and wrong for one the reader is invited to multiply. The concluded
 * discounts are both: Exhibit H labels each deduction with its rate and prints
 * the money it took out to four decimal places, so "Less: DLOM — 31.4%" sat
 * beside a figure struck at 0.3142. A reviewer checking the step table with a
 * calculator misses by a tenth of a cent per share on every line and cannot
 * tell whether the exhibit is rounded or wrong — on the one schedule that
 * states the conclusion of the valuation.
 *
 * The engine stores these at six decimal places, so four on the percentage is
 * always enough to be exact. Trailing zeros are trimmed to a minimum of one, so
 * an ordinary 15% still reads "15.0%" and only a rate that needs the digits
 * carries them.
 */
export function formatExactPercent(fraction: number, minDigits = 1, maxDigits = 4): string {
  const pct = fraction * 100;
  for (let d = minDigits; d < maxDigits; d += 1) {
    // Exact at this many places — the reader multiplying by what they read
    // reproduces the figure beside it.
    if (Math.abs(Number(pct.toFixed(d)) - pct) < 1e-9) return `${pct.toFixed(d)}%`;
  }
  return `${pct.toFixed(maxDigits)}%`;
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
    /** The σ the DLOM ran on, where the engine records one — see the DLOM figure. */
    dlom_volatility?: unknown;
    /** `class` or `enterprise`; absent on calculations predating the distinction. */
    dlom_volatility_basis?: unknown;
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
  const weighted_ = Object.entries(approaches)
    .map(([key, value]) => ({
      label: APPROACH_LABELS[key] ?? key,
      weight: num(value?.weight) ?? 0,
      value: num(value?.equity_value) ?? 0,
    }))
    .filter((p) => p.weight > 0)
    .sort((a, b) => b.value - a.value);
  if (weighted_.length === 0) return null;

  /*
   * Bounded at the renderer's series limit, and *truncated* rather than
   * aggregated: a bar chart of equity value by approach shows alternative
   * estimates of one quantity, so an "other approaches" bar would be a sum of
   * numbers that must not be added. The largest are the ones a reviewer
   * challenges, so the largest are what survives, and the note says how many
   * did not.
   *
   * Unreachable from today's engine, which writes four approaches. That is a
   * fact about another service's current version rather than a property of this
   * function's input — `results` is a JSON column written by whatever version
   * ran — and the cost of it being wrong is not a bad chart but a 422 on the
   * render hop, which falls back silently to blocking this event loop.
   */
  const points = weighted_.slice(0, CHART_SERIES_LIMITS.bar);
  const dropped = weighted_.length - points.length;

  const weighted = num(results.equity_value);
  const conclusion =
    weighted !== null ? `Weighted concluded equity value: ${formatCurrency(weighted, currency, 0)}.` : null;
  const omission =
    dropped > 0
      ? `The ${points.length} largest of ${weighted_.length} weighted approaches; ${dropped} smaller ` +
        `${dropped === 1 ? 'approach is' : 'approaches are'} not plotted.`
      : null;
  return {
    type: 'bar',
    title: 'Equity value by approach',
    points: points.map((p) => ({
      label: `${p.label} · ${formatPercent(p.weight, 0)}`,
      value: p.value,
      display: formatCurrency(p.value, currency, 0),
    })),
    note: [conclusion, omission].filter((n): n is string => n !== null).join(' ') || undefined,
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
  const all = Object.entries(approaches)
    .map(([key, value]) => ({
      label: APPROACH_LABELS[key] ?? key,
      weight: num(value?.weight) ?? 0,
    }))
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  // A single approach at 100% is a full ring saying nothing the sentence
  // above it does not already say.
  if (all.length < 2) return null;

  /*
   * Bounded at the renderer's series limit by *folding* the tail rather than
   * dropping it, which is the opposite of what the bar chart above does and for
   * the reason this chart exists: the whole point of showing weights as a ring
   * is that the reader can see them sum to one without adding anything up. A
   * truncated ring makes that false, and a ring that is quietly not a whole is
   * worse than four bars.
   *
   * Weights are addends — unlike the equity values beside them — so the fold is
   * arithmetically honest as well as visually necessary.
   */
  const slices =
    all.length <= CHART_SERIES_LIMITS.donut
      ? all
      : [
          ...all.slice(0, CHART_SERIES_LIMITS.donut - 1),
          {
            label: `Other approaches (${all.length - CHART_SERIES_LIMITS.donut + 1})`,
            weight: all.slice(CHART_SERIES_LIMITS.donut - 1).reduce((sum, s) => sum + s.weight, 0),
          },
        ];

  return {
    type: 'donut',
    title: 'Approach weighting',
    slices: slices.map((s) => ({
      label: s.label,
      value: s.weight,
      display: formatPercent(s.weight, 0),
    })),
    // The number of approaches, not the number of arcs: a folded tail must not
    // make the centre understate how many approaches were weighted.
    center: `${all.length}`,
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
  const all = history.filter((h) => Number.isFinite(h.fmv_per_share));
  if (all.length < 2) return null;

  /*
   * The trend is one point per prior valuation and `historyFor` bounds neither
   * end of it: the scope is every valuation of this company under this firm, so
   * the series grows for the whole life of the client relationship and never
   * shrinks. Past `CHART_SERIES_LIMITS.line` that is two separate problems.
   *
   * The visible one is the plot: markers of radius 2.6 spaced `plotWidth / n`
   * apart across about 450pt stop being a line and become a bar of ink.
   *
   * The one that has no symptom is the wire contract. `RenderBody` enforces the
   * same limit, so the first client to reach it made every render of every
   * report for that company a 422 — and a 422 is not a failure, it is a
   * *fallback*: `clients/reportRender.ts` renders the identical bytes
   * in-process instead, blocking the valuation event loop for the whole render.
   * Correct PDF, correct route, and the half-second the offload exists to
   * remove quietly back, on the engagements with the longest history and so the
   * largest reports. Nothing but `report_render_total{mode="local"}` says so.
   *
   * So the series is cut to the limit here, at the producer, where the reason
   * for the number is legible — and cut from the *old* end, because the
   * question this chart answers is how the new conclusion compares with the
   * recent ones. The note then states the omission rather than leaving the
   * reader to take a truncated series for the client's whole history: a
   * schedule that silently drops rows is the defect this platform keeps finding
   * (see the `truncated` flag on every list endpoint), and it is worse in a
   * signed report than in a list.
   */
  const points = all.slice(-CHART_SERIES_LIMITS.line);
  const omitted = all.length - points.length;

  return {
    type: 'line',
    title: 'Fair market value per common share over time',
    points: points.map((p) => ({
      label: p.as_of.slice(0, 10),
      value: p.fmv_per_share,
      display: formatCurrency(p.fmv_per_share, currency, 4),
    })),
    note:
      omitted === 0
        ? 'Concluded FMV of each prior valuation of this company, oldest first.'
        : `Concluded FMV of the most recent ${points.length} of ${all.length} prior valuations of ` +
          `this company, oldest first; ${omitted} earlier ${omitted === 1 ? 'valuation is' : 'valuations are'} not plotted.`,
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
      // Exact: the point's own `display` is the money this rate took out.
      label: `Less DLOC ${formatExactPercent(dloc)}`,
      value: afterDloc - base,
      display: `−${formatCurrency(base - afterDloc, currency, 4)}`,
    });
  }
  if (dlom > 0) {
    points.push({
      label: `Less DLOM ${formatExactPercent(dlom)}`,
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
  /**
   * The volatility derivation that counts (migration 0134), when one has been
   * run. Absent for an engagement whose sigma was selected by judgement, and
   * the key-assumptions row then reads as it always did.
   */
  volatility?: VolatilityEstimateRow | null;
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
  /*
   * Both concluded discounts, exactly — the same rate the body's conclusion
   * chapter and Exhibit H state, not a tenth-of-a-percent version of it.
   *
   * This page and Exhibit H are read together: the board member reads the
   * headline, the reviewer turns to the schedule, and the two are the same
   * document. `reportFigures` and `discountExhibit` were moved onto
   * `formatExactPercent` when the body was found stating a rate the conclusion
   * could not be reproduced from; the summary page was not, so a 409A
   * concluding a 31.42% DLOM printed "31.4%" on the page a board adopts the
   * value from and "31.42%" five pages later on the schedule that derives it.
   * Nothing reconciled the two, and only one of them is the rate that was
   * applied.
   *
   * The waterfall chart lower down this same page has labelled its steps
   * exactly all along, so the drift was visible within one page: "Discount for
   * lack of marketability 31.4%" in the figures and "Less DLOM 31.42%" in the
   * chart beneath them.
   */
  if (dloc !== null) {
    figures.push({ label: 'Discount for lack of control', value: formatExactPercent(dloc) });
  }
  if (dlom !== null) {
    const method = results.discounts?.dlom_method;
    const label = typeof method === 'string' ? (DLOM_LABELS[method] ?? method) : undefined;
    /*
     * The σ this discount was struck on, where it is not the σ on the same page.
     *
     * "Key assumptions" below states the enterprise volatility, because that is
     * what the allocation ran on. An option-based DLOM runs on the volatility of
     * the *class* — common, geared by everything senior to it — and the two differ
     * by the whole preference stack: 62% and 74% on the sample cap table. Printing
     * only the first left the summary page asserting a σ that reproduces neither
     * the discount beside it nor Exhibit H-1's derivation of it, and a reviewer
     * checking the one against the other found a number that did not divide out.
     */
    const dlomVol = num(results.assumptions?.dlom_volatility);
    const struckOn =
      results.assumptions?.dlom_volatility_basis === 'class' &&
      dlomVol !== null &&
      (volatility === null || Math.abs(dlomVol - volatility) > 0.0005)
        ? `struck on σ ${formatPercent(dlomVol)} — common's own, not the enterprise's`
        : null;
    figures.push({
      label: 'Discount for lack of marketability',
      value: formatExactPercent(dlom),
      note: [label, struckOn].filter(Boolean).join(' · ') || undefined,
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
    // One decimal, which is how the body's ASC 718 assumptions table, Exhibit F
    // and Exhibit H-1 all state σ. Rounded to the whole percent this page named
    // a volatility no other page in the document did — "σ 62%" against a
    // 62.4% that the allocation actually ran on, on the summary of a report
    // whose reviewer checks one against the other.
    if (volatility !== null) parts.push(`σ ${formatPercent(volatility)}`);
    if (timeToExit !== null) parts.push(`T ${timeToExit.toFixed(2)}y`);
    // Where sigma came from, on the one page a board member reads. A summary
    // that states the assumption without its basis is asking to be taken on
    // trust, which is the whole objection Exhibit F-1 answers; the note also
    // says when a derivation was run and not adopted, because a board should
    // not have to learn that from the exhibits.
    const basis = volatilityNarrative(context.volatility ?? null, volatility);
    figures.push({
      label: 'Key assumptions',
      value: parts.join(' · '),
      ...(basis === null ? {} : { note: basis }),
    });
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
