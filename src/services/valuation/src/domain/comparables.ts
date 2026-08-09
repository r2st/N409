/**
 * The peer set — vocabulary, the multiples derived from it, and the rules about
 * who may remove a row (design §4.5, migration 0119).
 *
 * The engine stays the calculator. `engine/comparables.py` scores candidates,
 * names screening reasons and strikes quartiles; `approaches.market_multiples`
 * turns a list of multiples into an indicated value. Nothing here recomputes
 * any of that. What this module owns is the step in between: which stored rows
 * are in the set, what multiple each one implies, and which single number the
 * market approach will be handed.
 *
 * That last point is why `median` below is the plain median and not something
 * cleverer. The engine selects `statistics.median(multiples)`, so a tab that
 * displayed a harmonic mean as "the multiple" would be showing a figure the
 * report never uses. The set summary is a preview of the engine's own choice,
 * or it is misinformation.
 */

export const COMPARABLE_SOURCES = ['ai', 'analyst', 'market_feed'] as const;
export type ComparableSource = (typeof COMPARABLE_SOURCES)[number];

/**
 * Where a row's *figures* came from — a different question from who put the
 * row in the set (migration 0133).
 *
 * `snapshot` is the engine's curated static reference set, which calls itself
 * illustrative; `live` is an observed quote from the market feed, only true as
 * of the moment beside it; `analyst` is hand-entered. Every row written before
 * these existed is a `snapshot` row of unknown vintage, and is stored NULL
 * rather than backfilled to a timestamp nobody has.
 */
export const COMPARABLE_FIGURES_SOURCES = ['snapshot', 'live', 'analyst'] as const;
export type ComparableFiguresSource = (typeof COMPARABLE_FIGURES_SOURCES)[number];

export const FIGURES_SOURCE_LABELS: Record<ComparableFiguresSource, string> = {
  snapshot: 'Reference snapshot',
  live: 'Observed market data',
  analyst: 'Analyst entered',
};

/**
 * Rows an analyst may delete outright.
 *
 * Only their own. An AI- or feed-sourced row is excluded with a reason, which
 * keeps it in the exhibit under "screened out" where a reviewer can see the
 * judgement that was made. Deleting it would make the set look like it never
 * contained the comp — the difference between a screen and a selection.
 */
export const DELETABLE_SOURCES: readonly ComparableSource[] = ['analyst'];

export function isDeletableSource(source: string): boolean {
  return (DELETABLE_SOURCES as readonly string[]).includes(source);
}

export type MarketMethod = 'revenue' | 'ebitda';
export type MarketHorizon = 'ltm' | 'ntm';

/** The four multiples a stored row can imply. */
export const MULTIPLE_KEYS = ['ev_revenue_ltm', 'ev_revenue_ntm', 'ev_ebitda_ltm', 'ev_ebitda_ntm'] as const;
export type MultipleKey = (typeof MULTIPLE_KEYS)[number];

export const MULTIPLE_LABELS: Record<MultipleKey, string> = {
  ev_revenue_ltm: 'EV/LTM Revenue',
  ev_revenue_ntm: 'EV/NTM Revenue',
  ev_ebitda_ltm: 'EV/LTM EBITDA',
  ev_ebitda_ntm: 'EV/NTM EBITDA',
};

/** The multiple a (method, horizon) pair names — the same pair `engineParams` sends. */
export function multipleKeyFor(
  method: MarketMethod | string | null | undefined,
  horizon: MarketHorizon | string | null | undefined,
): MultipleKey {
  const metric = method === 'ebitda' ? 'ebitda' : 'revenue';
  const window = horizon === 'ntm' ? 'ntm' : 'ltm';
  return `ev_${metric}_${window}` as MultipleKey;
}

/** The metric legs a row carries, as numbers or nulls — `numeric` arrives as text from pg. */
export interface ComparableMetrics {
  ev: number | null;
  revenue_ltm: number | null;
  revenue_ntm: number | null;
  ebitda_ltm: number | null;
  ebitda_ntm: number | null;
}

function positive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The multiples this row implies, from EV and the metric legs.
 *
 * A non-positive denominator yields null rather than a number: an EV/EBITDA
 * struck on a loss-making comp is arithmetically defined and economically
 * meaningless, and it is exactly the observation that drags a median.
 */
export function impliedMultiples(row: Partial<ComparableMetrics>): Record<MultipleKey, number | null> {
  const ev = positive(row.ev);
  const over = (metric: unknown): number | null => {
    const denominator = positive(metric);
    if (ev === null || denominator === null) return null;
    return Number((ev / denominator).toFixed(4));
  };
  return {
    ev_revenue_ltm: over(row.revenue_ltm),
    ev_revenue_ntm: over(row.revenue_ntm),
    ev_ebitda_ltm: over(row.ebitda_ltm),
    ev_ebitda_ntm: over(row.ebitda_ntm),
  };
}

/** Plain median — the figure `approaches.market_multiples` selects. Even counts average the middle pair. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[mid]! : (ordered[mid - 1]! + ordered[mid]!) / 2;
}

export interface MultipleSummary {
  key: MultipleKey;
  label: string;
  count: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface ComparableSetRow extends Partial<ComparableMetrics> {
  included: boolean;
}

/**
 * Descriptive statistics per multiple over the *included* rows.
 *
 * Excluded rows contribute to nothing here — that is what excluding one means —
 * but they stay in the listing and in the exhibit, so the reader can see the
 * set the statistic was struck from and the set it was struck out of.
 */
export function summarizeSet(rows: readonly ComparableSetRow[]): Record<MultipleKey, MultipleSummary> {
  const included = rows.filter((r) => r.included);
  const out = {} as Record<MultipleKey, MultipleSummary>;
  for (const key of MULTIPLE_KEYS) {
    const values = included.map((r) => impliedMultiples(r)[key]).filter((v): v is number => v !== null);
    out[key] = {
      key,
      label: MULTIPLE_LABELS[key],
      count: values.length,
      median: median(values),
      min: values.length > 0 ? Math.min(...values) : null,
      max: values.length > 0 ? Math.max(...values) : null,
    };
  }
  return out;
}

/**
 * The multiples the market approach should be handed, for one (method, horizon).
 *
 * Empty when no included row implies that multiple — the caller then falls back
 * to the AI aggregate, which is the behaviour every engagement had before this
 * table existed. Silently feeding an empty list to the engine would fail the
 * whole calculation on `market.multiples must contain at least one positive
 * multiple`, turning "nobody has screened comps yet" into an engine error.
 */
export function marketMultiples(
  rows: readonly ComparableSetRow[],
  method: MarketMethod | string | null | undefined,
  horizon: MarketHorizon | string | null | undefined,
): number[] {
  const key = multipleKeyFor(method, horizon);
  return rows
    .filter((r) => r.included)
    .map((r) => impliedMultiples(r)[key])
    .filter((v): v is number => v !== null);
}

export class ComparableInputError extends Error {}

/**
 * An exclusion needs a reason; an inclusion must not carry a stale one.
 *
 * Returns the reason to store. Clearing it on re-inclusion matters: a row that
 * reads `included = true, exclude_reason = 'different industry'` is a row two
 * readers will read two ways, and the exhibit would print the contradiction.
 */
export function resolveExcludeReason(included: boolean, reason: string | null | undefined): string | null {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (included) return null;
  if (trimmed === '') {
    throw new ComparableInputError('Excluding a comparable requires a reason');
  }
  return trimmed;
}
