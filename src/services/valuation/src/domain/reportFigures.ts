import type { CalculationRow } from '../repos/calculations.js';
import { formatCurrency, formatPercent, marketableValuePerShare, num } from './reportSummary.js';
import { fillTemplateVars, type ReportContent } from './report.js';

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

/**
 * HTML-escape, because these land inside stored-and-then-rendered HTML.
 *
 * Everything here is engine-derived and numeric today, so nothing needs it in
 * practice. It is applied anyway for the reason the equivalent note in
 * `instantiateTemplate` gives: the set of substituted values has grown once
 * already, and the first free-text figure to join it — a DLOM method label, a
 * benchmark name an analyst typed — would otherwise be stored HTML with no
 * sanitizer between it and the auditor portal that renders section bodies
 * directly.
 */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  const put = (key: string, value: string | null) => {
    if (value !== null) out[key] = esc(value);
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

  const dloc = num(results.discounts?.dloc);
  put('dloc', dloc !== null ? formatPercent(dloc) : null);
  const dlom = num(results.discounts?.dlom);
  put('dlom', dlom !== null ? formatPercent(dlom) : null);
  if (dloc !== null && dlom !== null) {
    put('combined_discount', formatPercent(1 - (1 - dloc) * (1 - dlom)));
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

  return out;
}

/**
 * Resolve the computed placeholders in a report body.
 *
 * Applied to the section HTML on its way to the PDF writer and never written
 * back, so the stored version keeps its placeholders and a later re-render
 * picks up a later calculation. Headings are filled too — a heading is plain
 * text everywhere it is shown, and a skeleton is free to put a figure in one.
 */
export function fillFigures(content: ReportContent, figures: ReportFigures): ReportContent {
  if (Object.keys(figures).length === 0) return content;
  return {
    title: fillTemplateVars(content.title, figures),
    sections: content.sections.map((s) => ({
      ...s,
      heading: fillTemplateVars(s.heading, figures),
      html: fillTemplateVars(s.html, figures),
    })),
  };
}
