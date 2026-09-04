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
 *
 * **A run whose tickers were never verified says so.** "The agent selects only
 * from candidates the engine recognised" is true of the agent's normal path and
 * false of its degraded one: when the market-data service is unreachable the
 * agent falls back to the model's raw suggestions, flags them `verified: false`
 * and reports `market_data_verified: false` on the run. This mapping read
 * neither. Every such row arrived with no figures, so it was set aside as
 * unpriced — under a reason that reads "the market data carried no revenue to
 * strike a multiple on", which vouches for a ticker nothing had checked. An
 * analyst told the feed merely lacks a revenue figure types one in; an analyst
 * told the ticker was never verified goes and looks. Same row, opposite
 * actions, and only one of the two sentences is true.
 */

import type { ComparableFiguresSource } from './comparables.js';
import { sliceChars } from './textSlice.js';

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
  /**
   * Counts for the audit event and the response — what actually landed.
   *
   * `unusable` and `unverified` are both "the agent chose it and it is not in
   * the set", and they are counted apart because they are opposite findings:
   * one is a real company the reference data could not price, the other is a
   * name nothing has confirmed exists.
   */
  summary: { selected: number; excluded: number; unusable: number; unverified: number };
}

/** The reason stored against a selected comp the engine could not price. */
export const UNPRICED_REASON =
  'selected by the AI agent, but the market data carried no revenue to strike a multiple on';

/**
 * The reason stored against a comp from a run that never reached the market
 * data — see the header. Deliberately not phrased as a data gap: the ticker
 * itself is the unchecked thing.
 */
export const UNVERIFIED_REASON =
  'selected by the AI agent while the market-data service was unreachable, so this ticker was ' +
  'never checked against it — confirm the company exists and is listed before including it';

const MAX_ROWS = 40;

function str(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : sliceChars(trimmed, limit);
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
  /*
   * Only an explicit `false` counts as unverified, on both the run and the row.
   * A stored result from before the agent reported either field says nothing
   * about verification, and reading its silence as a failure would relabel
   * every historical peer set as unchecked.
   */
  const runVerified = doc.market_data_verified !== false;

  const rows: MappedComparable[] = [];
  const seen = new Set<string>();
  let unusable = 0;
  let unverified = 0;

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
    const rowVerified = runVerified && candidate.verified !== false;
    const priced = rowVerified && revenueLtm !== null && ev !== null;
    // Checked before `unusable`, because an unverified row is also unpriced and
    // the two counters must not both claim it. Which sentence the analyst gets
    // is the whole point of separating them.
    if (!rowVerified) unverified += 1;
    else if (!priced) unusable += 1;

    rows.push({
      ticker,
      name: str(candidate.name, 200) ?? ticker,
      sic: str(candidate.sic_code, 12),
      included: priced,
      excludeReason: priced ? null : rowVerified ? UNPRICED_REASON : UNVERIFIED_REASON,
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
  return { rows, summary: { selected, excluded: rows.length - selected, unusable, unverified } };
}
