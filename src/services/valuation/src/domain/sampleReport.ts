import { templateForKind, type ReportTemplate } from './report.js';
import { SCHEDULE_CATALOGUE } from './reportExhibits.js';
import type { ValuationKind } from './valuation.js';

/**
 * The public "see a sample report" outline behind `/sample-report`.
 *
 * A marketing page that lists what is in the deliverable is a page that goes
 * stale the first time the deliverable changes, and nobody notices because
 * nobody diffs marketing copy against a report template. So this derives the
 * outline from `templateForKind` — the same skeleton the renderer instantiates
 * — and carries only the *explanations* as copy. Add a chapter to the 409A
 * template and it appears here; rename one and the heading here changes with
 * it. The one thing that can drift is a blurb, and `sampleReportOutline`
 * reports which sections have none so a test can hold the set closed.
 *
 * The blurbs answer "what does this part do for me", because a chapter list is
 * a table of contents and the question a founder is actually asking is why the
 * document is 28 chapters long instead of one page with a number on it.
 */

/** Prose for a chapter, keyed by the template's own section key. */
const SECTION_BLURBS: Record<string, string> = {
  introduction:
    'The subject, the valuation date, and the standard the conclusion is measured against — the number your board resolution references.',
  purpose_and_scope:
    'Who may rely on this report and for what. An appraisal used outside its stated purpose is one an auditor can set aside.',
  standard_of_value:
    'Fair market value as Revenue Ruling 59-60 defines it, on a going-concern premise: the definition the rest of the document is answerable to.',
  sources_of_information:
    'Every document and data source the analysis relied on, and a statement of what was accepted from management without independent verification.',
  company_overview:
    'Your business, what it sells, and the financing history that brought it to the valuation date.',
  company_analysis:
    'Stage of development, the risks specific to this company, and where it sits against the milestones that move value.',
  capital_structure:
    'A share-class-by-share-class cap table with liquidation preferences, participation rights and the option pool, as supplied during onboarding.',
  economic_outlook:
    'The macro conditions as of the valuation date. A valuation is an opinion at a moment, and this is the moment.',
  industry_market:
    'The sector, the comparable-company set, and the market conditions that frame the enterprise value.',
  financial_analysis:
    'Historical results and management projections, with the trends and anomalies the approaches below are built on.',
  methodology:
    'Which of the market, income and asset approaches were considered, which were applied, and why — including the ones rejected.',
  income_approach:
    'A discounted cash-flow analysis: the forecast, the discount rate build-up, the terminal value, and the resulting indication.',
  market_approach:
    'Guideline public companies and transactions, the multiples selected from them, and the indication they produce.',
  asset_approach:
    'The adjusted net asset value, which governs for asset-heavy and early-stage companies and is considered for the rest.',
  market_movement:
    'Where the concluded value is calibrated to a priced round, the movement in public comparables between that round and the valuation date.',
  reconciliation:
    'How the indications from each approach were weighted into a single total equity value, and the reasoning behind the weights.',
  allocation:
    'How total equity value is split across preferred and common — OPM, PWERM, hybrid or current value — with every breakpoint documented.',
  selected_volatility:
    'The volatility input to the allocation model, derived from guideline companies over a horizon matched to the expected time to exit.',
  dloc: 'The discount for lack of control applicable to a minority interest, supported by control-premium studies rather than asserted.',
  dlom: 'The discount for lack of marketability, supported by Finnerty and Chaffe option models and restricted-stock studies.',
  conclusion:
    'The concluded fair market value per share of common stock, and the arithmetic that gets there from total equity value.',
  asc718:
    'The grant-date fair value measurement and expense attribution for share-based compensation, for your auditors.',
  limiting_conditions:
    'The assumptions the conclusion rests on and the conditions that limit it — the first pages an audit team turns to.',
  use_and_distribution:
    'Who may distribute this report, what happens if the analyst is subpoenaed, and the fact that it is not updated for later events.',
  safe_harbor:
    'How this appraisal meets the independent-appraisal presumption of reasonableness under Section 409A.',
  certification:
    "The appraiser's certification: the statement of independence and professional standards that makes the document an appraisal.",
  qualifications:
    'The credentials of the analyst who signed it — the CPA, CFA and FRM designations an auditor checks.',
  exhibit_index:
    'A directory of the supporting schedules, each traceable back to the chapter that relies on it.',
};

/**
 * What each supporting schedule does for the reader, keyed by its catalogue id.
 *
 * Only the *explanations* live here. The set of schedules, their ids, their
 * titles and which of them every engagement receives all come from
 * `SCHEDULE_CATALOGUE` — the same catalogue the builders take their headings
 * from — because a hand-maintained second list is precisely what went wrong
 * before: this page promised A through H-1 while the renderer had grown three
 * appendices nobody had told the prospect about.
 */
const EXHIBIT_BLURBS: Record<string, string> = {
  A: 'Every share class, its preferences and the fully diluted position at the valuation date.',
  B: 'Each indication, its weight, and the weighted total equity value.',
  'B-1':
    'At what level of value each weighted approach arrived — control or marketable minority — and what that means for the discount for lack of control.',
  C: 'The cash-flow stream, discount factors and present values.',
  'C-1': 'The forecast the DCF discounts, and the assumptions that built it.',
  D: 'The multiples selected and the indication they produce.',
  'D-1': 'The peer set behind the market approach, including the companies excluded and why.',
  E: 'The adjusted net asset build-up.',
  F: 'The breakpoint schedule and the value allocated to each class at each breakpoint.',
  'F-1': 'The guideline companies, lookback window and the selected volatility.',
  'F-2':
    'What the concluded value per share does across a range of volatility and time to exit — the two inputs of the allocation model that are estimated rather than observed.',
  G: 'Each exit scenario, its probability, and the per-share value it implies.',
  H: 'DLOC, DLOM and the concluded fair market value per share.',
  'H-1': 'The option-model inputs and the study data supporting the DLOM.',
  I: 'The discount rate the income approach applied, built up component by component — risk-free rate, equity risk premium, size premium and company-specific risk.',
  II: 'The historical income statement and balance sheet the analysis rests on, as reported.',
  III: 'The rates of return investors require of a company at this stage of development, against which the concluded discount rate is tested.',
};

/**
 * The supporting schedules, as the renderer titles them.
 *
 * Unlike the chapters these are produced at render time from the calculation
 * rather than from a stored skeleton, so there is no template to read them
 * off — but there is a catalogue, and it is the same one the builders use.
 * Each carries the `always` flag that decides whether a given engagement's
 * report contains it: a company with no DCF has no Exhibit C, and a page
 * claiming otherwise is describing a document the client will not receive.
 */
export interface SampleExhibit {
  id: string;
  title: string;
  description: string;
  /** False when the exhibit is only rendered for engagements that need it. */
  always: boolean;
}

export const SAMPLE_EXHIBITS: readonly SampleExhibit[] = SCHEDULE_CATALOGUE.map((s) => ({
  id: s.id,
  // The heading the client's own report prints, minus the `Exhibit A — `
  // prefix the `id` column already carries.
  title: s.name,
  description: EXHIBIT_BLURBS[s.id] ?? '',
  always: s.always,
}));

/** Catalogue ids carrying no explanation — empty when the copy is complete. */
export const MISSING_EXHIBIT_BLURBS: readonly string[] = SCHEDULE_CATALOGUE.filter(
  (s) => !EXHIBIT_BLURBS[s.id],
).map((s) => s.id);

export interface SampleReportSection {
  key: string;
  heading: string;
  /** What this chapter does for the reader; null when none is authored yet. */
  blurb: string | null;
}

export interface SampleReportOutline {
  kind: ValuationKind;
  /** The template version the outline was read from, e.g. `409a.v59`. */
  version: string;
  name: string;
  sections: SampleReportSection[];
  exhibits: readonly SampleExhibit[];
  /** Section keys carrying no blurb — empty when the copy is complete. */
  missingBlurbs: string[];
  /**
   * Schedule ids carrying no blurb. Empty unless a schedule has been added to
   * `SCHEDULE_CATALOGUE` without a word of explanation for the prospect; only
   * ever populated for the 409A, which is the only kind that lists exhibits.
   */
  missingExhibitBlurbs: string[];
}

/**
 * The public outline for one report kind, read off the real template.
 *
 * Exhibits are listed only for the 409A: the specialty kinds render their own
 * schedules from `specialtyExhibits`, and claiming Exhibit F on a debt
 * valuation would be describing a document nobody receives.
 */
export function sampleReportOutline(kind: ValuationKind = '409a'): SampleReportOutline {
  const template: ReportTemplate = templateForKind(kind);
  const sections = template.sections.map((s) => ({
    key: s.key,
    heading: s.heading,
    blurb: SECTION_BLURBS[s.key] ?? null,
  }));
  return {
    kind,
    version: template.version,
    name: template.name,
    sections,
    exhibits: kind === '409a' ? SAMPLE_EXHIBITS : [],
    missingBlurbs: sections.filter((s) => s.blurb === null).map((s) => s.key),
    missingExhibitBlurbs: kind === '409a' ? [...MISSING_EXHIBIT_BLURBS] : [],
  };
}
