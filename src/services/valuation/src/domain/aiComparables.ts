/**
 * The `comp_selection` agent's output, as peer-set rows (design §4.5).
 *
 * `comp_selection` has suggested guideline companies, verified their tickers
 * against the engine's market data and refined the survivors into a defensible
 * set since it was written — and had nowhere to put the answer. The result blob
 * sat in `ai_jobs`, `COMPARABLE_SOURCES` has carried `'ai'` the whole time with
 * no caller that writes one, and an analyst who wanted the agent's set in the
 * market approach retyped it by hand. This module is the missing half: the pure
 * mapping from that blob to the rows `replaceMachineComparables` stores.
 *
 * Three decisions the shape follows from.
 *
 * **The agent's multiples are not stored; its figures are.** A row holds EV and
 * the metric legs, and `impliedMultiples` divides. Storing the agent's
 * `ev_revenue` alongside a revenue it does not divide into would put two
 * disagreeing multiples on one row, and the exhibit would print whichever the
 * reader happened to look at. So EV is taken from `market_cap` — the engine's
 * snapshot uses market cap as EV, which is what makes the quotient here
 * reproduce the agent's own figure — and falls back to `ev_revenue × revenue`
 * only when there is no market cap to take.
 *
 * **A row with no verified figures is still written, and still excluded.** The
 * agent selects only from candidates the engine recognised, but a recognised
 * ticker can come back without a revenue, and a row with no denominator implies
 * no multiple. Including it would put a comp in the set that contributes
 * nothing to the median while reading as though it did; dropping it would hide
 * that the agent chose it. It is stored excluded, with the reason saying so.
 *
 * **The figures are `snapshot`, not `live`.** The agent does not report which
 * half of the engine's universe answered for a ticker, and `live` is a claim
 * about a specific observation. Labelling an unknown vintage `live` is the
 * column lying; `snapshot` — the engine's curated reference set, which calls
 * itself illustrative — is true of both cases.
 */

import type { ComparableFiguresSource } from './comparables.js';

/** An input problem the analyst has to fix — the route maps it to a 422. */
export class AiComparablesError extends Error {}

/**
 * One row as `replaceMachineComparables` takes it: `ComparableItemInput` without
 * the two fields the repo supplies itself.
 */
export interface MappedComparable {
  ticker: string | null;
  name: string;
  sic: string | null;
  included: boolean;
  excludeReason?: string | null;
  revenueLtm: number | null;
  ebitdaLtm: number | null;
  ev: number | null;
  score: number | null;
  scoreBreakdown: unknown;
  figuresSource: ComparableFiguresSource;
  figuresAsOf: Date;
}

export interface MappedComparableSet {
  rows: MappedComparable[];
  /** Counts for the audit event and the response — what actually landed. */
  summary: { selected: number; excluded: number; unusable: number };
}

/** The reason stored against a selected comp the engine could not price. */
export const UNPRICED_REASON =
  'selected by the AI agent, but the market data carried no revenue to strike a multiple on';

const MAX_ROWS = 40;

function str(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, limit);
}

function fin(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Positive-only: a non-positive denominator implies no usable multiple. */
function positive(value: unknown): number | null {
  const n = fin(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * The EV to store for one verified candidate.
 *
 * `market_cap` first — see the header. `ev_revenue × revenue` is the fallback
 * that at least reproduces the agent's headline multiple; when neither is
 * available the row has no EV and therefore no multiple, which is the honest
 * answer rather than a zero.
 */
export function enterpriseValueFor(candidate: Record<string, unknown>): number | null {
  const marketCap = positive(candidate.market_cap);
  if (marketCap !== null) return marketCap;
  const revenue = positive(candidate.revenue);
  const evRevenue = positive(candidate.ev_revenue);
  if (revenue !== null && evRevenue !== null) return Number((revenue * evRevenue).toFixed(4));
  return null;
}

/**
 * EBITDA from revenue and the reported margin — the same derivation the
 * deterministic screen uses, and for the same reason `Company.ebitda_margin`
 * gives: a margin stored independently of the two figures it comes from is a
 * third number that eventually disagrees with both.
 */
export function ebitdaFor(candidate: Record<string, unknown>): number | null {
  const revenue = positive(candidate.revenue);
  const margin = fin(candidate.ebitda_margin);
  if (revenue === null || margin === null) return null;
  return Number((revenue * margin).toFixed(4));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Map a stored `comp_selection` result into peer-set rows.
 *
 * Throws `AiComparablesError` when the run produced nothing to apply — a job
 * that failed verification, or one whose model selected no comp at all. The
 * route turns that into a 422 naming the fix rather than writing an empty set
 * over whatever the analyst already had.
 */
export function mapAgentComparables(result: unknown, observedAt: Date): MappedComparableSet {
  const doc = asRecord(result);
  if (doc === null) {
    throw new AiComparablesError('That comparable-selection run stored no result to apply');
  }

  const selectedRaw = Array.isArray(doc.selected) ? doc.selected : [];
  const excludedRaw = Array.isArray(doc.excluded) ? doc.excluded : [];

  const rows: MappedComparable[] = [];
  const seen = new Set<string>();
  let unusable = 0;

  for (const entry of selectedRaw.slice(0, MAX_ROWS)) {
    const candidate = asRecord(entry);
    if (candidate === null) continue;
    const ticker = str(candidate.ticker, 12)?.toUpperCase() ?? null;
    // A selected comp with no ticker cannot be reconciled against the analyst's
    // own rows, refreshed from the feed, or carried into the next screen — the
    // three things a stored peer is for.
    if (ticker === null || seen.has(ticker)) continue;
    seen.add(ticker);

    const revenueLtm = positive(candidate.revenue);
    const ev = enterpriseValueFor(candidate);
    // The justification is the agent's own sentence about why the comp belongs;
    // the one-line rationale from the suggest step is the fallback.
    const priced = revenueLtm !== null && ev !== null;
    if (!priced) unusable += 1;

    rows.push({
      ticker,
      name: str(candidate.name, 200) ?? ticker,
      sic: str(candidate.sic_code, 12),
      included: priced,
      excludeReason: priced ? null : UNPRICED_REASON,
      revenueLtm,
      ebitdaLtm: ebitdaFor(candidate),
      ev,
      score: fin(candidate.score),
      scoreBreakdown: asRecord(candidate.score_breakdown) ?? {},
      figuresSource: 'snapshot',
      figuresAsOf: observedAt,
    });
  }

  // The rejected half. It is stored for the reason the screen's is: "why not
  // that one" is a question only the excluded list answers, and an auditor asks
  // it about the comps that are missing, not the ones that are there.
  for (const entry of excludedRaw.slice(0, MAX_ROWS)) {
    const candidate = asRecord(entry);
    if (candidate === null) continue;
    const ticker = str(candidate.ticker, 12)?.toUpperCase() ?? null;
    if (ticker === null || seen.has(ticker)) continue;
    seen.add(ticker);
    rows.push({
      ticker,
      name: str(candidate.name, 200) ?? ticker,
      sic: null,
      included: false,
      excludeReason: str(candidate.reason, 500) ?? 'not selected by the AI comparable agent',
      revenueLtm: null,
      ebitdaLtm: null,
      ev: null,
      score: null,
      scoreBreakdown: {},
      figuresSource: 'snapshot',
      figuresAsOf: observedAt,
    });
  }

  if (rows.length === 0) {
    throw new AiComparablesError(
      'That comparable-selection run named no company with a ticker — re-run the agent, or add ' +
        'comps by hand',
    );
  }

  const selected = rows.filter((r) => r.included).length;
  return { rows, summary: { selected, excluded: rows.length - selected, unusable } };
}
