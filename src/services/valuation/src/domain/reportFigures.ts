import type { CalculationRow } from '../repos/calculations.js';
import {
  formatCurrency,
  formatExactPercent,
  formatPercent,
  marketableValuePerShare,
  num,
} from './reportSummary.js';
import { escapeTemplateVars, fillTemplateVars, type ReportContent } from './report.js';

/**
 * The concluded figures, substituted into the authored body at render time.
 *
 * The gap this closes was the most visible defect in the deliverable. The
 * report body is a prose skeleton instantiated *once*, when the report is first
 * opened — typically before the engine has run — so it can only ever carry
 * facts known at that moment: the company name, the kind, the currency. Every
 * figure the valuation actually concludes is therefore written into the
 * skeleton as an ellipsis, and the ellipsis is what shipped:
 *
 *     17. Conclusion of Value
 *     Based on the analyses described herein, the fair market value of one
 *     share of common stock of Northwind Robotics, Inc. as of 2026-06-30 is
 *     $ … per share.
 *
 * — three pages after the summary page had printed $1.4947, on a signed §409A
 * opinion whose entire purpose is to state that number. The ASC 718 assumptions
 * table was worse: eight rows, all of them "$ …". An analyst was expected to
 * type each figure back in by hand from the exhibits, on every revision, and to
 * remember to retype them all after every recalculation.
 *
 * The fix follows the architecture the exhibits and the summary page already
 * use: computed content is *render-time*, never stored. `fillTemplateVars`
 * leaves an unknown `{{placeholder}}` verbatim, so the skeleton's placeholders
 * survive instantiation untouched and resolve here against the calculation that
 * produced the conclusion. Three properties fall out of that and all three are
 * the point:
 *
 *   * the body cannot disagree with the summary page or the exhibits, because
 *     all three now read one calculation;
 *   * a re-render after a recalculation restates the body, so no revision can
 *     leave a stale number in the prose; and
 *   * an analyst who wants to *say* something else simply types over the
 *     placeholder, and their words are kept — editing still wins, as it must.
 *
 * A report with no successful calculation behind it resolves nothing and the
 * placeholders stay as they are. That is deliberate: a `{{fmv_per_share}}`
 * visibly unresolved is a draft nobody can mistake for a conclusion, whereas
 * an em-dash or a zero reads as an answer.
 */

/** Values are formatted, escaped strings destined for a sanitized HTML body. */
export type ReportFigures = Record<string, string>;

interface IncomeApproachShape {
  discount_rate?: unknown;
  forecast_years?: unknown;
  terminal_method?: unknown;
  terminal_detail?: {
    terminal_growth?: unknown;
    exit_multiple?: unknown;
    terminal_metric_basis?: unknown;
  } | null;
}

interface ResultsShape {
  fmv_per_share?: unknown;
  equity_value?: unknown;
  common_equity_value?: unknown;
  fully_diluted_common?: unknown;
  allocation?: { common_per_share?: unknown } | null;
  discounts?: {
    dloc?: unknown;
    dlom?: unknown;
    dloc_detail?: { minority_basis_weight?: unknown } | null;
  } | null;
  assumptions?: {
    volatility?: unknown;
    risk_free_rate?: unknown;
    time_to_exit_years?: unknown;
    expected_time_to_exit_years?: unknown;
  } | null;
  market_movement?: { factor?: unknown; index_return?: unknown; index_name?: unknown } | null;
}

const INT = new Intl.NumberFormat('en-US');

/**
 * The three assumptions a discounted cash flow is challenged on, as the body
 * states them.
 *
 * ## Why the body has to state them
 *
 * "Missing key assumptions" is the standard finding against a 409A that fails
 * review, and the discount rate is the assumption it is usually about. Exhibit
 * C has printed the rate and the terminal basis since it existed — but an
 * exhibit is a schedule a reader turns to, and the chapter that describes the
 * approach could only instruct its author to "state the derivation of the
 * discount rate" and then hope. Where nobody typed over the instruction, the
 * delivered report described a DCF and never said what rate it discounted at.
 *
 * ## Where they come from
 *
 * The result, which is what the engine did, in preference to the request, which
 * is what was asked for. `income_dcf` records `discount_rate` and
 * `forecast_years` for exactly this reader (see its note); calculations stored
 * before it did fall back to the request, which is the same number on every
 * path but one — `auto_wacc`, where the engine writes the build-up back into
 * the request before running, so the two agree there too.
 *
 * ## Why `terminal_basis` is prose rather than a rate
 *
 * A Gordon terminal value has a growth rate and an exit-multiple terminal value
 * does not. A `{{terminal_growth}}` figure would therefore resolve on one of
 * the two methods and stay literal on the other, in a signed PDF. One figure
 * that names whichever basis was used always resolves, and reads as the
 * sentence a valuation report actually writes.
 */
function incomeAssumptions(
  calculation: CalculationRow,
  results: ResultsShape,
): Record<string, string | null> {
  // Read through a local view rather than off `ResultsShape`: that interface is
  // structurally assignable to `reportSummary`'s reading of the same payload,
  // and narrowing `approaches` here would break the assignment for every other
  // figure that goes through it.
  const approaches = (results as { approaches?: Record<string, unknown> | null }).approaches;
  const approach = (approaches?.income ?? null) as IncomeApproachShape | null;
  if (!approach) return {};
  // `{ params, inputs }` — the document the engine was called with, as
  // `buildExhibits` reads it. Only reached for a calculation predating the
  // engine recording these on the result.
  const payload = (calculation.inputs ?? {}) as { inputs?: { income?: Record<string, unknown> } | null };
  const requested = payload.inputs?.income ?? {};

  const rate = num(approach.discount_rate) ?? num(requested.discount_rate);
  const years = (num(approach.forecast_years) ?? list(requested.free_cash_flows).length) || null;

  const detail = approach.terminal_detail ?? {};
  const growth = num(detail.terminal_growth) ?? num(requested.terminal_growth);
  const multiple = num(detail.exit_multiple);
  const basis =
    approach.terminal_method === 'exit_multiple'
      ? multiple === null
        ? 'an exit multiple applied to the terminal-year metric'
        : `an exit multiple of ${multiple.toFixed(1)}x applied to the terminal-year ` +
          `${terminalMetricName(detail.terminal_metric_basis)}`
      : `a perpetual growth rate of ${formatPercent(growth ?? 0, 2)} beyond the forecast period`;

  return {
    discount_rate: rate === null ? null : formatPercent(rate, 2),
    forecast_years: years === null ? null : String(Math.round(years)),
    terminal_basis: basis,
  };
}

/** How the exit multiple's denominator is named in a sentence. */
function terminalMetricName(basis: unknown): string {
  if (basis === 'ebitda') return 'EBITDA';
  if (basis === 'revenue') return 'revenue';
  if (basis === 'fcff') return 'free cash flow';
  return 'metric';
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Every figure the 409A skeleton can name, keyed by its placeholder.
 *
 * Deliberately a flat string map rather than the results object: a template
 * placeholder is authored by a human and has to be guessable, and
 * `{{fmv_per_share}}` is. It also means a placeholder that no longer resolves
 * degrades to itself rather than to "undefined".
 */
export function reportFigures(calculation: CalculationRow | null, currency: string): ReportFigures {
  if (!calculation || calculation.status !== 'succeeded' || !calculation.results) return {};
  const results = calculation.results as ResultsShape;
  const out: ReportFigures = {};
  /*
   * Stored as written, not HTML-escaped.
   *
   * These used to be escaped here, on the argument that they land inside
   * stored-and-then-rendered HTML — true of `fillFigures`'s third call and of
   * neither of its first two. A figure is substituted into the section body,
   * which is markup, and into the heading and the title, which are text: the
   * PDF writer draws a heading as a string and the table of contents repeats
   * it. Escaping at the source put `S&amp;P 500` in a chapter heading and in
   * the contents entry pointing at it, spelled out, for the one figure here
   * that is free text rather than a formatted number.
   *
   * So the escape moved to the fill, where the destination is known. Every
   * value that reaches HTML still gets it — see `fillFigures` below, and
   * `escapeTemplateVars`, which is the same rule applied to the five
   * instantiation variables.
   */
  const put = (key: string, value: string | null) => {
    if (value !== null) out[key] = value;
  };

  const fmv = num(results.fmv_per_share);
  // Four decimals on a per-share figure, two on an aggregate — the same
  // convention the summary page and Exhibit H use, so the body agrees with them
  // digit for digit rather than merely in value.
  put('fmv_per_share', fmv !== null ? formatCurrency(fmv, currency, 4) : null);

  const equity = num(results.equity_value);
  put('equity_value', equity !== null ? formatCurrency(equity, currency, 0) : null);

  const commonEquity = num(results.common_equity_value);
  put('common_equity_value', commonEquity !== null ? formatCurrency(commonEquity, currency, 0) : null);

  const marketable = marketableValuePerShare(results);
  put('marketable_value_per_share', marketable !== null ? formatCurrency(marketable, currency, 4) : null);

  const shares = num(results.fully_diluted_common);
  put('fully_diluted_common', shares !== null ? INT.format(Math.round(shares)) : null);

  /*
   * The two concluded rates, to the precision they were actually applied at.
   *
   * Exhibit H states each rate beside the money it took out, so it prints them
   * exactly; the body was printing the same two rates rounded to a tenth, and
   * the conclusion chapter then invited the reader to reproduce a figure it had
   * just made unreproducible — "allocated to a marketable value of $2.1804 per
   * share, less a discount for lack of control of 10.0% and a discount for lack
   * of marketability of 31.4%" concludes at $1.4718, and the report concluded at
   * $1.4713. Five pages later Exhibit H says 31.42% and closes exactly.
   *
   * Neither figure was wrong. The document simply stated its own concluded
   * discount two ways, and the version in the sentence that states the
   * conclusion was the one that did not reconcile.
   */
  const dloc = num(results.discounts?.dloc);
  put('dloc', dloc !== null ? formatExactPercent(dloc) : null);
  const dlom = num(results.discounts?.dlom);
  put('dlom', dlom !== null ? formatExactPercent(dlom) : null);
  if (dloc !== null && dlom !== null) {
    // Wider than the four places the two component rates need: the combined
    // rate is a product, so it carries the digits of both. Four decimal places
    // on each input is six on the percentage of the product, and this is the
    // rate the conclusion chapter asks the reader to apply to the allocated
    // value — the one place in the document where the whole discount is stated
    // as a single number.
    put('combined_discount', formatExactPercent(1 - (1 - dloc) * (1 - dlom), 1, 6));
  }

  /*
   * The level of value the allocation actually landed at, as the body names it.
   *
   * Three chapters — the allocation, the control discount and the conclusion —
   * called it "marketable, controlling" unconditionally, and for the typical
   * 409A that is not true: most of the weight sits on a backsolve, which
   * inverts the price a minority investor paid, and on guideline public company
   * multiples, which are struck on minority trading prices. The engine measures
   * the mix (`dloc.minority_basis_share`), and Exhibit H has printed the
   * qualified label since it did — so the deliverable stated one level of value
   * in its prose and declined to state it in the schedule the prose points at,
   * three pages apart, on the sentence that says what was concluded.
   *
   * Resolved by exactly the rule `discountExhibit` applies, and for that
   * reason: the two must not be able to disagree. An unmeasured mix — no
   * weights, or a zero DLOC, which cannot double-count — reads as controlling,
   * which is the case the wording was written for.
   */
  const minorityWeight = num(results.discounts?.dloc_detail?.minority_basis_weight);
  put(
    'allocated_level',
    minorityWeight === null || minorityWeight <= 0.5 ? 'marketable, controlling' : 'marketable',
  );

  const volatility = num(results.assumptions?.volatility);
  put('volatility', volatility !== null ? formatPercent(volatility) : null);
  const riskFree = num(results.assumptions?.risk_free_rate);
  put('risk_free_rate', riskFree !== null ? formatPercent(riskFree, 2) : null);
  const term =
    num(results.assumptions?.time_to_exit_years) ?? num(results.assumptions?.expected_time_to_exit_years);
  put('time_to_exit_years', term !== null ? term.toFixed(2) : null);

  // ── the market-movement adjustment ─────────────────────────────────────────
  // These three resolve either way, and that is the difference between them and
  // every other figure here. The rest are absent when the engine did not
  // produce them, so the placeholder stays visible and reads as a draft. Not
  // adjusting the round indication is not a gap though — it is the ordinary
  // case, and the right answer for a valuation dated close to its round — so
  // leaving `{{market_movement_factor}}` on the page of an otherwise complete
  // deliverable would flag a defect where there is none. They resolve to words
  // that say no adjustment was made, rather than to a factor of 1.0000x, which
  // would claim somebody measured one.
  const factor = num(results.market_movement?.factor);
  put('market_movement_factor', factor !== null ? `${factor.toFixed(4)}x` : 'none applied');
  const indexReturn = num(results.market_movement?.index_return);
  put('market_movement_return', indexReturn !== null ? formatPercent(indexReturn) : 'not measured');
  const indexName = results.market_movement?.index_name;
  put(
    'market_movement_index',
    typeof indexName === 'string' && indexName ? indexName : 'no benchmark selected',
  );

  // ── ASC 718 ────────────────────────────────────────────────────────────────
  // The grant-date measurement the 409A conclusion feeds. Its own inputs — the
  // strike, the expected term, the forfeiture rate — belong to the grants and
  // are measured by domain/asc718.ts against the awards on file; what the 409A
  // supplies is the *underlying* price and the market assumptions, which are
  // exactly the rows that were blank.
  put('asc718_underlying', fmv !== null ? formatCurrency(fmv, currency, 4) : null);

  // ── the income approach's stated assumptions ───────────────────────────────
  for (const [key, value] of Object.entries(incomeAssumptions(calculation, results))) put(key, value);

  return out;
}

/**
 * Resolve the computed placeholders in a report body.
 *
 * Applied to the section HTML on its way to the PDF writer and never written
 * back, so the stored version keeps its placeholders and a later re-render
 * picks up a later calculation. Headings are filled too — a heading is plain
 * text everywhere it is shown, and a skeleton is free to put a figure in one.
 *
 * Which is why there are two forms of the same map. The title and the heading
 * take the figure as written, because they are drawn as strings; the body takes
 * it HTML-escaped, because it is markup that is tokenized by the renderer and
 * rendered directly by the auditor portal. Nothing here is free text today
 * except the benchmark name, and one figure is enough: `S&P 500` has to reach
 * the page as itself on both sides of that split.
 */
export function fillFigures(content: ReportContent, figures: ReportFigures): ReportContent {
  if (Object.keys(figures).length === 0) return content;
  const htmlFigures = escapeTemplateVars(figures);
  return {
    title: fillTemplateVars(content.title, figures),
    sections: content.sections.map((s) => ({
      ...s,
      heading: fillTemplateVars(s.heading, figures),
      html: fillTemplateVars(s.html, htmlFigures),
    })),
  };
}
