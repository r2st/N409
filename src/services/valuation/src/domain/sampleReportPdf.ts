import type { ReportPdfInput, ReportPdfSection, ReportPdfSummary } from '@n409/report/pdf';
import {
  DISCOUNT_RATE_SCHEDULE,
  instantiateTemplate,
  templateForKind,
  visibleSections,
  type ReportContent,
  type ReportTemplate,
} from './report.js';
import { resolveExhibitReferences } from './reportExhibitIndex.js';
import { resolveSignatures } from './reportSignatures.js';
import { SCHEDULE } from './reportExhibits.js';
import { fillFigures, reportFigures } from './reportFigures.js';
import { formatCurrency, formatPercent } from './reportSummary.js';
import { esc, table } from './exhibitHtml.js';
import type { CalculationRow } from '../repos/calculations.js';
import type { ValuationKind } from './valuation.js';

/**
 * The downloadable sample 409A (`GET /api/v1/sample-report/pdf`).
 *
 * `/sample-report` describes the deliverable chapter by chapter; a prospect's
 * next question is what it actually looks like, and 409.ai answers it with a
 * PDF. The page could not, so the one thing a founder wanted to take to their
 * board was the one thing the marketing surface did not produce.
 *
 * ## Why this is built rather than checked in
 *
 * A sample PDF committed as bytes is a screenshot of a template that has moved
 * 59 versions and will move again: it goes stale silently, and nobody diffs a
 * binary against a skeleton. So this renders through the *production* path —
 * `templateForKind` → `instantiateTemplate` → `resolveExhibitReferences` →
 * `resolveSignatures` → `fillFigures` → `renderReportPdf` — with a fabricated
 * engagement standing in for the database. Change the 409A template and the
 * sample changes with it;
 * break the renderer and the sample's own test fails alongside the real one's.
 *
 * ## Why the figures are derived and not typed
 *
 * `/sample-report` prints a summary strip, the PDF prints an executive summary,
 * and Exhibits B/F/H print the arithmetic behind both. Three copies of six
 * numbers is three chances to disagree, and a valuation document whose cover
 * contradicts its own Exhibit H is worse than no sample at all. So the
 * primitives below are stated once, everything else is computed from them, and
 * `SAMPLE_FIGURES` is served to the marketing page rather than re-typed there.
 *
 * ## Why every page says SAMPLE
 *
 * This renders the genuine article, publicly, to anyone — which is exactly what
 * makes it dangerous. A document that looks like a signed appraisal and is not
 * one must not be able to be passed off as evidence of an appraisal, whether by
 * mistake or otherwise. Three independent marks, none of which survives a
 * casual crop: the footer on every page, a cover fact, and the opening sentence
 * of the executive summary. `Northwind Robotics, Inc.` is fictitious, and the
 * certification chapter is instantiated with no analyst's name because nobody
 * signed this.
 */

/** The fictitious subject. Not a real company, and named so it cannot be one. */
export const SAMPLE_COMPANY = 'Northwind Robotics, Inc.';
export const SAMPLE_CURRENCY = 'USD';

/**
 * The valuation date of the worked example.
 *
 * Fixed rather than "today minus a quarter": a sample whose date moves produces
 * different bytes on every request, which defeats caching and makes the golden
 * assertions in the tests untestable. A reader comparing two downloads a month
 * apart should get the same document.
 */
export const SAMPLE_VALUATION_DATE = '2026-03-31';

/**
 * The inputs. Everything below is computed from them, and nothing anywhere in
 * the document states a number this file cannot reproduce.
 *
 * Written this way because the first version declared the conclusions —
 * `EQUITY_VALUE = 32_000_000` and an Exhibit B whose weights happened to reach
 * it — and the coherence test immediately found the body pointing at an
 * Exhibit C the sample did not print. A sample built from conclusions is a
 * sample where the schedules are decoration; built from inputs, the schedules
 * are the derivation and the summary is what falls out of them.
 */

/** The DCF behind the income approach (Exhibit C). Balance sheet in ADJUSTMENTS. */
const DCF = {
  first_year: 2027,
  /** Free cash flow, discounted at year end. Negative early — this is a Series B. */
  free_cash_flow: [-1_200_000, 400_000, 2_100_000, 4_300_000, 6_800_000],
  wacc: 0.185,
  terminal_growth: 0.035,
} as const;

/** The guideline-company multiple behind the market approach (Exhibit D). */
const MARKET = {
  ltm_revenue: 8_400_000,
  /** Selected EV/Revenue, at the median of the peer set below. */
  multiple: 3.5,
  peers: [
    { name: 'Guideline Company A', ev_revenue: 4.1 },
    { name: 'Guideline Company B', ev_revenue: 3.6 },
    { name: 'Guideline Company C', ev_revenue: 3.4 },
    { name: 'Guideline Company D', ev_revenue: 2.9 },
  ],
} as const;

/** Enterprise value to equity value: the same bridge for both approaches. */
const ADJUSTMENTS = { cash: 1_000_000, debt: 700_000 } as const;

/** The round the OPM is calibrated to. A backsolve concludes equity directly. */
const BACKSOLVE_INDICATION = 34_000_000;

/** Value the option-pricing model allocates to the pool, ahead of common. */
const POOL_VALUE = 5_500_000;
const DLOM = 0.275;
/** No control discount: the interest appraised is already a minority one. */
const DLOC = 0;

/**
 * The option-pricing model's own inputs.
 *
 * Named rather than typed inline in `sampleResults` because the Economic
 * Outlook chapter states the interest-rate environment the risk-free rate was
 * taken from, and the Valuation Methodology chapter states the expected time to
 * a liquidity event. A sample whose prose says 4.2% while its allocation
 * discounts at something else is the defect the whole of this file is arranged
 * to make impossible.
 */
const OPM = { volatility: 0.62, risk_free_rate: 0.0418, time_to_exit_years: 3.5 } as const;

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const discountFactor = (year: number) => 1 / (1 + DCF.wacc) ** year;

/** PV of the explicit forecast plus the PV of a Gordon-growth terminal value. */
const DCF_ENTERPRISE_VALUE = (() => {
  const pvForecast = sum(DCF.free_cash_flow.map((cf, i) => cf * discountFactor(i + 1)));
  const terminal =
    (DCF.free_cash_flow[DCF.free_cash_flow.length - 1]! * (1 + DCF.terminal_growth)) /
    (DCF.wacc - DCF.terminal_growth);
  return pvForecast + terminal * discountFactor(DCF.free_cash_flow.length);
})();

const toEquity = (enterprise: number) => enterprise + ADJUSTMENTS.cash - ADJUSTMENTS.debt;

const INCOME_INDICATION = toEquity(DCF_ENTERPRISE_VALUE);
const MARKET_ENTERPRISE_VALUE = MARKET.ltm_revenue * MARKET.multiple;
const MARKET_INDICATION = toEquity(MARKET_ENTERPRISE_VALUE);

/**
 * The three indications, the weights the reconciliation applies to them, and
 * the level of value each one arrives at.
 *
 * `level` mirrors `LEVEL_OF_VALUE_BY_APPROACH` in the engine's dloc module: a
 * backsolve inverts the price a minority investor paid and guideline public
 * company multiples are struck on minority trading prices, so neither produces
 * a controlling value; a discounted cash flow does. It is here because the body
 * *says* which level the allocation landed at, and a sample that concluded no
 * discount for lack of control while its prose called the allocated figure
 * "marketable, controlling" was contradicting its own Exhibit H two pages away.
 */
const APPROACHES = [
  {
    name: 'OPM backsolve to the Series B round',
    indication: BACKSOLVE_INDICATION,
    weight: 0.6,
    level: 'minority',
  },
  {
    name: 'Market approach — guideline public companies',
    indication: MARKET_INDICATION,
    weight: 0.3,
    level: 'minority',
  },
  {
    name: 'Income approach — discounted cash flow',
    indication: INCOME_INDICATION,
    weight: 0.1,
    level: 'control',
  },
] as const;

const EQUITY_VALUE = sum(APPROACHES.map((a) => a.indication * a.weight));

/** Share of the weighted equity value that arrived at a minority level. */
const MINORITY_BASIS_WEIGHT =
  sum(APPROACHES.filter((a) => a.level === 'minority').map((a) => a.weight)) /
  sum(APPROACHES.map((a) => a.weight));

/** Series A + Series B liquidation preference, allocated ahead of common. */
const PREFERRED_VALUE = 12_400_000;
const COMMON_SHARES = 2_480_000;

const COMMON_VALUE = EQUITY_VALUE - PREFERRED_VALUE - POOL_VALUE;
const MARKETABLE_PER_SHARE = COMMON_VALUE / COMMON_SHARES;
const FMV_PER_SHARE = MARKETABLE_PER_SHARE * (1 - DLOC) * (1 - DLOM);

/** The cap table Exhibit A prints, and the source of the allocation in F. */
const CAP_TABLE = [
  { klass: 'Series B Preferred', shares: 1_200_000, preference: 8_400_000, allocated: 8_400_000 },
  { klass: 'Series A Preferred', shares: 1_600_000, preference: 4_000_000, allocated: 4_000_000 },
  { klass: 'Options & pool', shares: 1_200_000, preference: 0, allocated: POOL_VALUE },
  { klass: 'Common Stock', shares: COMMON_SHARES, preference: 0, allocated: COMMON_VALUE },
] as const;

const money = (v: number, digits = 0) => formatCurrency(v, SAMPLE_CURRENCY, digits);
const INT = new Intl.NumberFormat('en-US');

/** A headline figure of the worked example, for the page and the PDF alike. */
export interface SampleFigure {
  label: string;
  value: string;
  note?: string;
}

/**
 * The summary strip. Served in the `/sample-report` response so the marketing
 * page renders the same six numbers the PDF concludes, from this one statement
 * of them.
 */
export const SAMPLE_FIGURES: readonly SampleFigure[] = [
  { label: 'Equity value', value: money(EQUITY_VALUE), note: 'Weighted across three approaches' },
  { label: 'Preferred', value: `−${money(PREFERRED_VALUE)}`, note: 'Liquidation preference, Series A and B' },
  { label: 'Option pool', value: `−${money(POOL_VALUE)}`, note: 'Allocated by the option-pricing model' },
  { label: 'Common', value: money(COMMON_VALUE), note: `Across ${INT.format(COMMON_SHARES)} shares` },
  { label: 'DLOM', value: `−${formatPercent(DLOM)}`, note: 'Finnerty put-option model' },
  { label: 'FMV / share', value: formatCurrency(FMV_PER_SHARE, SAMPLE_CURRENCY, 2), note: 'Common stock' },
];

/**
 * The banner that keeps this out of an audit file.
 *
 * Repeated in the footer of every page, so it survives a reader who prints one
 * chapter, and phrased as what the document is *not* rather than as a label —
 * "SAMPLE" alone is a word somebody could read as a sample *of* a real opinion.
 */
export const SAMPLE_NOTICE = 'SAMPLE — illustrative only, not a valuation opinion';

/**
 * The descriptive facts of the fabricated engagement — the ones no schedule
 * computes.
 *
 * Everything with money in it is derived above; these are the things a real
 * Company Overview states and no arithmetic can produce. Declared here rather
 * than written into the prose so the narrative chapters cannot disagree with
 * each other about how many people work there.
 */
const PROFILE = {
  incorporated: 2021,
  state: 'Delaware',
  location: 'Pittsburgh, Pennsylvania',
  headcount: 64,
  engineers: 29,
  customers: 22,
  /** Share of LTM revenue billed to the three largest customers. */
  concentration: 0.46,
  series_a_year: 2023,
} as const;

/** Capital raised: the preference stack is 1x non-participating, so it is the money in. */
const SERIES_A_RAISED = CAP_TABLE.find((r) => r.klass === 'Series A Preferred')!.preference;
const SERIES_B_RAISED = CAP_TABLE.find((r) => r.klass === 'Series B Preferred')!.preference;

const li = (items: readonly string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

/** Share counts by class, so the prose cannot disagree with Exhibit A. */
const sharesOf = (klass: string) => CAP_TABLE.find((r) => r.klass === klass)!.shares;
const SERIES_A_SHARES = sharesOf('Series A Preferred');
const SERIES_B_SHARES = sharesOf('Series B Preferred');
const POOL_SHARES = sharesOf('Options & pool');

/** A reconciliation weight, as the body states it and Exhibit B prints it. */
const weightOf = (prefix: string) =>
  formatPercent(APPROACHES.find((a) => a.name.startsWith(prefix))!.weight, 0);

/**
 * The chapters the skeleton leaves for the analyst, written for this engagement.
 *
 * ## Why this exists
 *
 * Seven chapters of the 409A skeleton are marked `authored` — their text tells
 * whoever writes the report what belongs there rather than being the report.
 * "Summarize the industry landscape, market size and growth, and competitive
 * positioning." is a to-do item, and `domain/reportReview.ts` grades a
 * deliverable still carrying one as a `fail`: there is no reading under which an
 * instruction to the analyst is the report.
 *
 * The public sample was that document. It is built by instantiating the real
 * skeleton, which is what keeps it from going stale — and instantiating the real
 * skeleton is exactly how a chapter of instructions reaches the page. So the one
 * 409A this product publishes to everyone, the document a prospect judges the
 * deliverable by, was the document the product's own publish gate exists to
 * refuse. Running `reviewReport` over it returned seven failures.
 *
 * ## Why an override map rather than a second skeleton
 *
 * A sample template of its own would drift from the real one silently, which is
 * the failure this whole file is arranged against. Keyed overrides keep the
 * sample tracking the skeleton chapter for chapter: the headings, the order, the
 * closing sections and every chapter that is *meant* to ship verbatim still come
 * from `templateForKind`. A new `authored` chapter added to the skeleton has no
 * entry here, and `sampleReportPdf.test.ts` fails until somebody writes one —
 * which is the same forcing function `missingBlurbs` gives the marketing page.
 *
 * ## Why the figures are markers and constants
 *
 * Same rule as everywhere above: nothing here states a number this file cannot
 * reproduce. Calculation figures are written as the `{{markers}}` a real chapter
 * would carry, so they resolve through `reportFigures` at render time and agree
 * with the exhibits digit for digit; the rest are interpolated from the
 * primitives at the top of the file. No number in this prose is typed twice.
 */
const SAMPLE_NARRATIVE: Readonly<Record<string, string>> = {
  company_overview:
    `<p><strong>{{company_name}}</strong> designs and sells autonomous mobile robots, together with the ` +
    `fleet-management software that coordinates them, for order fulfilment inside third-party logistics ` +
    `and grocery distribution warehouses. The company was incorporated in ${PROFILE.state} in ` +
    `${PROFILE.incorporated} and operates from a single facility in ${PROFILE.location}. It employed ` +
    `${PROFILE.headcount} people at the valuation date, ${PROFILE.engineers} of them in engineering.</p>` +
    `<p>Robots are placed under multi-year subscriptions that bundle the hardware, the software and ` +
    `on-site service into a per-robot monthly fee, so substantially all revenue is recurring and the ` +
    `company carries the residual value of the fleet on its own balance sheet. The company had ` +
    `${PROFILE.customers} customers under contract at the valuation date, and the three largest ` +
    `accounted for ${formatPercent(PROFILE.concentration)} of last-twelve-months revenue of ` +
    `${money(MARKET.ltm_revenue)}.</p>` +
    `<p>The company has raised ${money(SERIES_A_RAISED + SERIES_B_RAISED)} across two priced preferred ` +
    `rounds — ${money(SERIES_A_RAISED)} of Series A in ${PROFILE.series_a_year} and ` +
    `${money(SERIES_B_RAISED)} of Series B, which closed shortly before the valuation date. Its only ` +
    `borrowing is ${money(ADJUSTMENTS.debt)} drawn under an equipment facility.</p>`,

  company_analysis:
    `<p>Revenue Ruling 59-60 §4.01 sets out the factors to be considered in valuing the stock of a ` +
    `closely held corporation. Each is addressed below.</p>` +
    li([
      `<strong>Nature and history of the business</strong> — ${PROFILE.incorporated} formation by two ` +
        `robotics engineers; first revenue in the following year, and an unbroken record of quarter-on-` +
        `quarter growth in contracted robots since. The subscription model was adopted at the outset and ` +
        `has not changed, so the revenue record is comparable across the whole period.`,
      `<strong>Economic and industry outlook</strong> — addressed in the two sections that follow.`,
      `<strong>Book value and financial condition</strong> — book value is not indicative of value here: ` +
        `the balance sheet carries ${money(ADJUSTMENTS.cash)} of cash and the depreciated cost of a ` +
        `deployed fleet, and none of the enterprise value concluded below rests on tangible net assets.`,
      `<strong>Earning capacity</strong> — the company is not yet profitable. Management's projections, ` +
        `discussed under the income approach, reach positive free cash flow in the second forecast year ` +
        `and were prepared on a bottom-up basis from contracted robots and the fleet deployment plan.`,
      `<strong>Dividend-paying capacity</strong> — none. Cash generated is committed to fleet build and ` +
        `engineering headcount for the duration of the forecast period, and the preferred stock terms ` +
        `restrict distributions in any event.`,
      `<strong>Goodwill and other intangible value</strong> — the fleet-coordination software, the ` +
        `deployment data accumulated across ${PROFILE.customers} sites and the assembled engineering ` +
        `team. These are captured in the income and market indications rather than valued separately.`,
      `<strong>Prior sales of stock and the size of the block</strong> — the Series B round described ` +
        `above is the most recent arm's-length transaction in the company's stock and is the ` +
        `calibration point for the option-pricing backsolve. No secondary transactions in common stock ` +
        `have occurred.`,
      `<strong>Comparable companies</strong> — the guideline set is discussed under the market approach ` +
        `and set out in <strong>Exhibit D</strong>.`,
    ]) +
    `<p>The specific risks a buyer of common stock would price are customer concentration at ` +
    `${formatPercent(PROFILE.concentration)} of revenue in three accounts, competition from materially ` +
    `better-capitalised warehouse-automation vendors, dependence on the two founding engineers, and the ` +
    `financing required to reach the deployment scale the projections assume.</p>`,

  economic_outlook:
    `<p>Revenue Ruling 59-60 §4.01(b) requires consideration of the economic outlook in general, and the ` +
    `condition and outlook of the specific industry in particular.</p>` +
    `<p>At the valuation date the economy was expanding at a moderate rate with inflation close to the ` +
    `central bank's target, and the Treasury yield curve, interpolated to the ` +
    `${OPM.time_to_exit_years}-year expected time to a liquidity event applied in the allocation below, ` +
    `stood at <strong>{{risk_free_rate}}</strong>. That yield is the risk-free rate used in the ` +
    `option-pricing model, and it is stated here rather than only at the point of use because the rate ` +
    `environment is the economic condition that bears most directly on this valuation.</p>` +
    `<p>Private capital markets were selective rather than closed. Late-stage rounds were being priced, ` +
    `but on longer diligence and with a clearer requirement for a route to profitability than in the ` +
    `preceding cycle. For a company that must raise again to fund its deployment plan, that condition is ` +
    `a risk to the equity holder and is reflected both in the discount rate applied to the projections ` +
    `and in the discount for lack of marketability concluded below.</p>`,

  industry_market:
    `<p>Warehouse automation is the substitution of robotics for manual travel inside a fulfilment ` +
    `centre. The addressable market is driven by labour cost and availability in distribution ` +
    `operations rather than by discretionary technology spend, which makes demand comparatively ` +
    `durable through a slowdown; industry sources placed the mobile-robotics segment in the low tens of ` +
    `billions of dollars at the valuation date, growing at a mid-teens compound rate.</p>` +
    `<p>The segment has three tiers: the integrated materials-handling incumbents, who sell automation ` +
    `as part of a whole-facility build; a small number of scaled independents; and venture-funded ` +
    `entrants selling into single sites. <strong>{{company_name}}</strong> is in the third tier. Its ` +
    `position rests on the subscription model, which removes the capital decision from the customer, ` +
    `and on retrofit deployment into existing racking rather than a facility rebuild.</p>` +
    `<p>The guideline companies selected for the market approach traded between ` +
    `${MARKET.peers[MARKET.peers.length - 1]!.ev_revenue.toFixed(1)}x and ` +
    `${MARKET.peers[0]!.ev_revenue.toFixed(1)}x enterprise value to last-twelve-months revenue at the ` +
    `valuation date. They are larger and closer to profitability than the subject; the multiple selected ` +
    `and the basis for it are set out under the market approach and in <strong>Exhibit D</strong>.</p>`,

  financial_analysis:
    `<p>Last-twelve-months revenue to the valuation date was ${money(MARKET.ltm_revenue)}, substantially ` +
    `all of it recurring subscription revenue. The company is not profitable: gross margin is held down ` +
    `by fleet depreciation and on-site service, and operating expense is dominated by the engineering ` +
    `headcount described above.</p>` +
    `<p>Management's projections cover {{forecast_years}} years, from ${DCF.first_year} to ` +
    `${DCF.first_year + DCF.free_cash_flow.length - 1}. Free cash flow is negative in the first ` +
    `forecast year at ${money(DCF.free_cash_flow[0]!)} and turns positive in the second, reaching ` +
    `${money(DCF.free_cash_flow[DCF.free_cash_flow.length - 1]!)} in the terminal forecast year. The ` +
    `forecast is set out year by year in <strong>Exhibit C</strong>.</p>` +
    `<p>The balance sheet at the valuation date holds ${money(ADJUSTMENTS.cash)} of cash against ` +
    `${money(ADJUSTMENTS.debt)} of equipment borrowing. Measured against the first forecast year's ` +
    `outflow, that cash does not fund the plan to the point at which the business becomes ` +
    `self-financing, and management expects to raise again within the forecast period. We have taken ` +
    `the projections as management's own and have not audited or reviewed them; the risk that they are ` +
    `not achieved is carried in the discount rate rather than by adjusting the cash flows.</p>`,

  methodology:
    `<p>All three approaches to value were considered. The option-pricing backsolve was given primary ` +
    `weight, the market approach secondary weight, and the income approach a low weight; the asset ` +
    `approach was considered and rejected. The indications, the weights and the concluded equity value ` +
    `of <strong>{{equity_value}}</strong> are set out in <strong>Exhibit B</strong>.</p>` +
    li(
      APPROACHES.map(
        (a) =>
          `<strong>${a.name}</strong> — ${formatPercent(a.weight, 0)} weight, indicating ` +
          `${money(a.indication)}.`,
      ),
    ) +
    `<p>The reasoning is the quality of the inputs available to each. The Series B round transacted at ` +
    `arm's length shortly before the valuation date and is direct market evidence of this company's ` +
    `equity value, which is why it carries the majority of the weight. The guideline companies are real ` +
    `but imperfect comparables, larger and further along than the subject. The projections are ` +
    `management's own and reach beyond the point at which the company must raise again, so the income ` +
    `approach corroborates rather than concludes. The asset approach was given no weight: the value of ` +
    `this business rests on contracted recurring revenue and software rather than on tangible net ` +
    `assets, and a net-asset indication would be a floor rather than a measure.</p>` +
    `<p>The concluded equity value is then allocated across the classes in <strong>Exhibit F</strong> by ` +
    `the option-pricing method, on an expected time to a liquidity event of ${OPM.time_to_exit_years} ` +
    `years, and the resulting common-stock value is discounted as set out in <strong>Exhibit H</strong>.</p>`,

  /*
   * Framed rather than invented, and the only chapter here written in the
   * sample's own voice.
   *
   * Every other chapter can be written for Northwind Robotics because Northwind
   * Robotics does not exist. An analyst does. Naming a credentialed appraiser
   * who never examined anything, on a document that is published to the open
   * internet and looks like an appraisal, manufactures exactly the artefact the
   * three SAMPLE marks exist to prevent — and a credential is the one fact in
   * this file a reader might act on. So this chapter states the requirement and
   * then says plainly what a delivered report puts here, in the same voice the
   * summary page already uses.
   */
  qualifications:
    `<p>SSVS-1 and the independent-appraiser condition of Treasury Regulation ` +
    `§1.409A-1(b)(5)(iv)(B)(1) require this chapter to identify the analyst responsible for the ` +
    `valuation and establish their competence to have performed it.</p>` +
    `<p>${SAMPLE_NOTICE}. No analyst performed this valuation and none is named. In a client's report ` +
    `this chapter states, for each analyst who took part:</p>` +
    li([
      'their name, role and firm',
      'the professional credentials they hold (ABV, ASA, CFA, CVA or equivalent)',
      'their experience in the valuation of privately held equity securities',
      'the extent of their participation in the analyses and conclusions reported',
    ]) +
    `<p>The certification that follows carries their signature. On this document it is ruled and empty, ` +
    `which is the fourth mark separating it from an appraisal.</p>`,
};

/**
 * The instruction sentences the *mixed* chapters carry, answered.
 *
 * `SAMPLE_NARRATIVE` above replaces a chapter whole, which is the right shape
 * for the seven the skeleton flags `authored`: those are nothing but a to-do
 * list, so there is no prose underneath to preserve. Ten other chapters are the
 * opposite arrangement — a paragraph of report with one instruction standing in
 * it ("State whether the approach was applied and the weight assigned to it") —
 * and they were left alone, so the published sample still asked its reader to
 * describe the capital structure, explain the weighting and state the basis for
 * the concluded discount. Fourteen sentences, on the document a prospect judges
 * the deliverable by.
 *
 * `reportReview.ts` does not refuse those chapters and this file does not
 * relitigate that: a gate on every imperative sentence would refuse every
 * report ever drafted, which is the reasoning that check was written with. The
 * sample is held to the higher standard because it is *published*, not because
 * the rule changed.
 *
 * ## Why sentences rather than another chapter override
 *
 * Copying capital_structure or dlom into a sample version to edit one sentence
 * out reproduces the whole chapter here, and a second copy of a chapter is the
 * silent-drift failure this file is arranged against. A keyed substring keeps
 * the sample carrying the skeleton's own prose and replacing only the sentence
 * it answers — and when the skeleton edits that sentence, the replacement stops
 * matching and `unappliedSampleAnswers` names it. Loud, and in a test rather
 * than in a 500 on the marketing page.
 */
const SAMPLE_ANSWERS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  capital_structure: [
    [
      'Describe each class of stock outstanding and the economic rights that bear on the allocation of ' +
        'equity value:</p><ul><li>Liquidation preference of each preferred series, its seniority rank, and ' +
        'whether ranks are pari passu</li><li>Participation rights and any participation cap</li><li>' +
        'Conversion ratios and any anti-dilution adjustments in effect</li><li>Options, warrants and other ' +
        'dilutive instruments, with their exercise prices</li><li>Convertible notes and SAFEs outstanding, ' +
        'and the terms on which they convert</li></ul>',
      'Three classes are outstanding, together with the reserved option pool:</p>' +
        li([
          `<strong>Series B Preferred</strong> — ${INT.format(SERIES_B_SHARES)} shares carrying a 1x ` +
            `non-participating liquidation preference of ${money(SERIES_B_RAISED)}, senior to the ` +
            'Series A.',
          `<strong>Series A Preferred</strong> — ${INT.format(SERIES_A_SHARES)} shares carrying a 1x ` +
            `non-participating preference of ${money(SERIES_A_RAISED)}, junior to the Series B and ` +
            'senior to the common.',
          `<strong>Options and pool</strong> — ${INT.format(POOL_SHARES)} shares reserved under the ` +
            'stock plan, exercisable into common.',
          `<strong>Common Stock</strong> — ${INT.format(COMMON_SHARES)} shares, ranking behind both ` +
            'preferred series.',
        ]) +
        '<p>Neither preferred series participates in the residual after taking its preference, both ' +
        'convert one-for-one into common, and no anti-dilution adjustment was in effect at the ' +
        'valuation date. No convertible notes or SAFEs were outstanding.',
    ],
  ],

  income_approach: [
    [
      'State the source and reliability of the projections, the derivation of the discount rate, and the ' +
        'basis for the terminal growth rate.',
      'The projections are management’s own, prepared for its board and adopted here without ' +
        'adjustment; they rest on the robots already under contract at the valuation date and on the ' +
        'pipeline behind them. The discount rate is a required rate of return for a company at this stage ' +
        'of development rather than a weighted average cost of capital built from public comparables, ' +
        'which would understate the risk that the forecast is not met. The terminal growth rate is set ' +
        'below long-run nominal growth for the economy, on the view that the explicit forecast period ' +
        'already carries the scaling and the terminal year is a mature business.',
    ],
  ],

  market_approach: [
    [
      'Identify the guideline companies or transactions selected, the basis for selecting them, the metric ' +
        'and period chosen, and any adjustments made for differences in size, growth, margin or stage.',
      'The guideline companies are warehouse-automation and industrial-robotics businesses selling on ' +
        'recurring contracts, screened for a comparable revenue scale and growth profile; those whose ' +
        'stage or scale differed materially were excluded rather than adjusted for. The metric is ' +
        'enterprise value to last-twelve-months revenue — earnings multiples are not meaningful for a ' +
        'company at this margin — measured over the twelve months to the valuation date, and the ' +
        'selected multiple is the median of the retained set, applied without further adjustment.',
    ],
  ],

  asset_approach: [
    [
      'State whether the approach was applied and the weight assigned to it; for a going concern whose ' +
        'value rests on intangible assets and future earnings rather than tangible net assets, explain the ' +
        'reason for a low weight or for excluding it.',
      'The approach was considered and assigned no weight. The value of {{company_name}} rests on its ' +
        'contracted subscription base, its fleet-management software and its engineering organisation, ' +
        'none of which the balance sheet carries at anything like its contribution to value; a net-asset ' +
        'measure would state the depreciated cost of the deployed fleet and would understate the business ' +
        'by a wide margin.',
    ],
  ],

  market_movement: [
    [
      'Identify the benchmark selected and why it is the right proxy for this company, the measurement ' +
        'dates, and the basis for the beta applied.',
      'A report that applies one names the benchmark selected and why it is the right proxy for this ' +
        'company, the measurement dates, and the basis for the beta applied.',
    ],
    [
      'Where no adjustment has been applied — because the round is close enough to the valuation date ' +
        'that no measurable movement separates them, or because no benchmark is a defensible proxy — ' +
        'say so and state the reason. An unadjusted round indication is a conclusion, not an omission, and ' +
        'should read as one.',
      'No adjustment has been applied here. The Series B closed shortly before the valuation date, and no ' +
        'measurable movement in the market for companies of this profile separates the two, so the round ' +
        'indication is carried at the price it transacted at. That is a conclusion, not an omission.',
    ],
  ],

  reconciliation: [
    [
      'Explain the weighting: the relevance of each approach to a company of this stage and sector, the ' +
        'quality of the inputs available to it, and the reason any approach considered was assigned no ' +
        'weight.',
      `The backsolve carries ${weightOf('OPM backsolve')}: the Series B closed shortly before the ` +
        'valuation date in an arm’s-length priced round, and the price it transacted at is the ' +
        'strongest single piece of evidence available about what this equity was worth. The market ' +
        `approach carries ${weightOf('Market approach')} — the guideline set is a reasonable proxy ` +
        'for the sector, but none of its members is close to the subject on stage or on scale. The income ' +
        `approach carries ${weightOf('Income approach')}: the forecast is management’s and is not ` +
        'yet supported by a record of having met one, so it corroborates the other two rather than ' +
        'driving the conclusion. The asset approach was considered and assigned no weight, for the reason ' +
        'given above.',
    ],
  ],

  allocation: [
    [
      'Describe the option-pricing model allocation across share classes, including term, volatility and ' +
        'risk-free-rate inputs.',
      'The concluded equity value is allocated across the share classes by an option-pricing model: each ' +
        'class is valued as a claim that pays only above the exit value at which the classes ranking ahead ' +
        'of it have been satisfied, so the preferred, the option pool and the common each take value in ' +
        'the ranges where their own rights bite.',
    ],
    [
      'State the basis for the expected time to a liquidity event; the expected volatility is dealt with ' +
        'in the section that follows.',
      'The expected time to a liquidity event is the horizon over which the board’s plan contemplates ' +
        'a sale or an offering; the expected volatility is dealt with in the section that follows.',
    ],
  ],

  selected_volatility: [
    [
      'State whether the window was matched to the expected time to a liquidity event, and the basis for ' +
        'any departure from the derived figure.',
      'The observation window was matched to the expected time to a liquidity event, and the median of the ' +
        'guideline set was adopted without departure from the derived figure.',
    ],
  ],

  dloc: [
    [
      'A discount for lack of control is therefore applied to reflect the difference between a controlling ' +
        'and a minority interest in the same equity.',
      'Where the allocated value stands at a controlling level, a discount for lack of control is applied ' +
        'to reflect the difference between a controlling and a minority interest in the same equity.',
    ],
    [
      'State the basis for the concluded discount — control premium studies, the specific rights held ' +
        'by the preferred classes, or the analyst’s qualitative assessment.',
      'The conclusion rests on the level of value the weighted approaches already produced rather than on ' +
        'control-premium studies: the backsolve inverts the price a minority investor paid for the ' +
        'Series B, and the guideline companies are freely traded minority interests. The allocated value ' +
        'therefore stands at a marketable minority level already, and no further step down for lack of ' +
        'control is warranted.',
    ],
  ],

  dlom: [
    [
      'Describe the analysis supporting the concluded discount and why the method selected suits this ' +
        'holding:',
      'The discount was struck with an option-based model, which suits a holding whose illiquidity is a ' +
        'matter of time rather than of registration:',
    ],
    [
      'Where the conclusion rests on empirical studies of private placements of registered but ' +
        'unregistered-for-resale stock, name the studies relied on and note that observations predating ' +
        'the 1997 and 2008 amendments to Rule 144 measured a longer restriction than applies today.',
      'Considered and not relied on. The observations are of registered stock subject to a fixed resale ' +
        'restriction, and those predating the 1997 and 2008 amendments to Rule 144 measured a longer ' +
        'restriction than applies today.',
    ],
    [
      'State the volatility and the holding period assumed, and note that the volatility of the ' +
        '<em>subject class</em> is not the volatility of the enterprise: common is a levered claim behind ' +
        'the preference stack.',
      'The concluded discount is a Finnerty average-strike put, struck over the expected holding period ' +
        'on the volatility of the <em>common class</em> rather than of the enterprise: common is a levered ' +
        'claim behind the preference stack, so its volatility is the higher of the two.',
    ],
    [
      'Where judgement adjusts a modelled figure, identify the factors weighed — distribution ' +
        'history, transfer restrictions, the pool of likely buyers, the expected time to liquidity — ' +
        'and the direction and size of the adjustment.',
      'No judgement adjustment was made to the modelled figure. The factors a report weighs where one is ' +
        'made — distribution history, transfer restrictions, the pool of likely buyers, the expected ' +
        'time to liquidity — did not indicate a departure here.',
    ],
  ],
};

/**
 * Answers whose instruction is no longer in the skeleton, so they replaced
 * nothing.
 *
 * Exported rather than thrown, in the shape `sampleReportOutline` reports its
 * `missingBlurbs`: the forcing function belongs in a test, and a marketing page
 * that 500s because somebody rephrased a sentence in a skeleton is a worse
 * failure than the one being guarded against.
 */
export function unappliedSampleAnswers(): string[] {
  const skeleton = new Map(templateForKind('409a').sections.map((s) => [s.key, s.html]));
  const out: string[] = [];
  for (const [key, answers] of Object.entries(SAMPLE_ANSWERS)) {
    const html = skeleton.get(key);
    for (const [instruction] of answers) {
      if (html === undefined || !html.includes(instruction)) out.push(`${key}: ${instruction.slice(0, 60)}…`);
    }
  }
  return out;
}

/**
 * The engine results the fabricated engagement would have produced.
 *
 * Shaped for `reportFigures`, which is the point: the body's `{{fmv_per_share}}`
 * and `{{dlom}}` placeholders resolve through exactly the code path and exactly
 * the rounding conventions a client's report uses, rather than through a second
 * formatter that agrees with it until one of them is edited.
 */
function sampleResults(): Record<string, unknown> {
  return {
    fmv_per_share: FMV_PER_SHARE,
    equity_value: EQUITY_VALUE,
    common_equity_value: COMMON_VALUE,
    fully_diluted_common: CAP_TABLE.reduce((n, r) => n + r.shares, 0),
    allocation: { common_per_share: MARKETABLE_PER_SHARE },
    /*
     * `dloc_detail` is what tells the body which level of value the allocation
     * landed at (`allocated_level`), and it is stated here for the same reason
     * every other figure in this file is derived rather than typed: the sample
     * concluded a zero DLOC because the interest appraised is already a
     * minority one, and without this the Discount for Lack of Control chapter
     * opened "The allocation above produces the value of a common share on a
     * marketable, controlling basis" — over an Exhibit H whose own row reads
     * "Not applied — minority interest appraised".
     */
    discounts: {
      dloc: DLOC,
      dlom: DLOM,
      dloc_detail: {
        minority_basis_weight: MINORITY_BASIS_WEIGHT,
        control_basis_weight: 1 - MINORITY_BASIS_WEIGHT,
        double_counts_minority: false,
      },
    },
    assumptions: { ...OPM },
    // The income approach's own assumptions, in the shape `income_dcf` records
    // them. Not decoration: the body states the rate, the forecast length and
    // the terminal basis from these, and a sample that omitted them would show
    // a DCF chapter that never says what it discounted at — which is the
    // deficiency the chapter was changed to close.
    approaches: {
      income: {
        discount_rate: DCF.wacc,
        forecast_years: DCF.free_cash_flow.length,
        terminal_method: 'gordon',
        terminal_detail: { terminal_growth: DCF.terminal_growth },
      },
    },
  };
}

/** The four schedules every 409A engagement receives, on the sample's numbers. */
function sampleExhibits(): ReportPdfSection[] {
  const fullyDiluted = CAP_TABLE.reduce((n, r) => n + r.shares, 0);
  const weighted = APPROACHES.reduce((n, a) => n + a.indication * a.weight, 0);

  const capTable: ReportPdfSection = {
    heading: SCHEDULE.A,
    html: table({
      head: ['Class', 'Shares', 'Liquidation preference', '% fully diluted'],
      rows: CAP_TABLE.map((r) => [
        esc(r.klass),
        INT.format(r.shares),
        r.preference > 0 ? money(r.preference) : '—',
        formatPercent(r.shares / fullyDiluted),
      ]),
      foot: ['Fully diluted', INT.format(fullyDiluted), money(PREFERRED_VALUE), '100.0%'],
    }),
  };

  const income: ReportPdfSection = {
    heading: SCHEDULE.C,
    // The rate row is on this schedule, so the body's sentence naming the rate
    // prints with it — see `DISCOUNT_RATE_SCHEDULE`.
    schedules: [DISCOUNT_RATE_SCHEDULE],
    html:
      table({
        head: ['Year', 'Free cash flow', `Discount factor @ ${formatPercent(DCF.wacc)}`, 'Present value'],
        rows: DCF.free_cash_flow.map((cf, i) => [
          String(DCF.first_year + i),
          money(cf),
          discountFactor(i + 1).toFixed(4),
          money(cf * discountFactor(i + 1)),
        ]),
        foot: [
          'Present value of forecast',
          '',
          '',
          money(sum(DCF.free_cash_flow.map((cf, i) => cf * discountFactor(i + 1)))),
        ],
      }) +
      table({
        head: ['Terminal value', 'Basis', 'Amount'],
        rows: [
          [
            'Gordon growth',
            `Terminal-year free cash flow grown at ${formatPercent(DCF.terminal_growth)}, ` +
              `capitalised at ${formatPercent(DCF.wacc)} less growth`,
            money(
              (DCF.free_cash_flow[DCF.free_cash_flow.length - 1]! * (1 + DCF.terminal_growth)) /
                (DCF.wacc - DCF.terminal_growth),
            ),
          ],
          [
            'Present value of terminal value',
            `Discounted ${DCF.free_cash_flow.length} years`,
            money(
              ((DCF.free_cash_flow[DCF.free_cash_flow.length - 1]! * (1 + DCF.terminal_growth)) /
                (DCF.wacc - DCF.terminal_growth)) *
                discountFactor(DCF.free_cash_flow.length),
            ),
          ],
          ['Enterprise value', 'Forecast plus terminal value', money(DCF_ENTERPRISE_VALUE)],
          ['Plus cash', 'Per the balance sheet at the valuation date', money(ADJUSTMENTS.cash)],
          [
            'Less interest-bearing debt',
            'Per the balance sheet at the valuation date',
            `−${money(ADJUSTMENTS.debt)}`,
          ],
        ],
        foot: ['Indicated equity value', '', money(INCOME_INDICATION)],
      }),
  };

  const market: ReportPdfSection = {
    heading: SCHEDULE.D,
    html:
      table({
        head: ['Guideline company', 'EV / LTM revenue'],
        rows: MARKET.peers.map((p) => [esc(p.name), `${p.ev_revenue.toFixed(1)}x`]),
        foot: ['Selected multiple', `${MARKET.multiple.toFixed(1)}x`],
      }) +
      table({
        head: ['Step', 'Basis', 'Amount'],
        rows: [
          ['LTM revenue', 'Per the financial statements', money(MARKET.ltm_revenue)],
          ['Enterprise value', `Revenue × ${MARKET.multiple.toFixed(1)}x`, money(MARKET_ENTERPRISE_VALUE)],
          ['Plus cash', 'Per the balance sheet at the valuation date', money(ADJUSTMENTS.cash)],
          [
            'Less interest-bearing debt',
            'Per the balance sheet at the valuation date',
            `−${money(ADJUSTMENTS.debt)}`,
          ],
        ],
        foot: ['Indicated equity value', '', money(MARKET_INDICATION)],
      }),
  };

  const reconciliation: ReportPdfSection = {
    heading: SCHEDULE.B,
    html: table({
      head: ['Approach', 'Indication', 'Weight', 'Weighted'],
      rows: APPROACHES.map((a) => [
        esc(a.name),
        money(a.indication),
        formatPercent(a.weight, 0),
        money(a.indication * a.weight),
      ]),
      foot: ['Concluded total equity value', '', '100%', money(weighted)],
    }),
  };

  const allocation: ReportPdfSection = {
    heading: SCHEDULE.F,
    html: table({
      head: ['Class', 'Shares', 'Allocated value', 'Per share'],
      rows: CAP_TABLE.map((r) => [
        esc(r.klass),
        INT.format(r.shares),
        money(r.allocated),
        formatCurrency(r.allocated / r.shares, SAMPLE_CURRENCY, 4),
      ]),
      foot: ['Total equity value', INT.format(fullyDiluted), money(EQUITY_VALUE), ''],
    }),
  };

  const conclusion: ReportPdfSection = {
    heading: SCHEDULE.H,
    html: table({
      head: ['Step', 'Basis', 'Amount'],
      rows: [
        ['Common equity value', 'Residual after preferred and pool', money(COMMON_VALUE)],
        ['Common shares outstanding', 'Per Exhibit A', INT.format(COMMON_SHARES)],
        [
          'Marketable value per share',
          'Before discounts',
          formatCurrency(MARKETABLE_PER_SHARE, SAMPLE_CURRENCY, 4),
        ],
        ['Discount for lack of control', 'Not applied — minority interest appraised', formatPercent(DLOC)],
        ['Discount for lack of marketability', 'Finnerty put-option model', `−${formatPercent(DLOM)}`],
      ],
      foot: [
        'Fair market value per common share',
        `As of ${SAMPLE_VALUATION_DATE}`,
        formatCurrency(FMV_PER_SHARE, SAMPLE_CURRENCY, 4),
      ],
    }),
  };

  // Letter order, which is the order `buildExhibits` prints a real engagement's
  // schedules in and the order SAMPLE_EXHIBITS lists them for the page. A
  // sample whose exhibits ran A, C, D, B would be describing a different
  // document from the one the outline promises.
  //
  // The headings come from `SCHEDULE` for the same reason: three of these were
  // hand-written and three of those had drifted from the renderer's own — the
  // sample called Exhibit H "Discounts & Conclusion" where a client's report
  // says "Discounts and Concluded Value". A sample exists to show the real
  // document, so it does not get to name its schedules differently.
  return [capTable, reconciliation, income, market, allocation, conclusion];
}

function sampleSummary(): ReportPdfSummary {
  const [, ...rest] = SAMPLE_FIGURES;
  return {
    headline: {
      label: 'Fair market value per common share',
      value: formatCurrency(FMV_PER_SHARE, SAMPLE_CURRENCY, 4),
      note: `${SAMPLE_COMPANY} · as of ${SAMPLE_VALUATION_DATE}`,
    },
    figures: rest.map((f) => ({ label: f.label, value: f.value, ...(f.note ? { note: f.note } : {}) })),
    statement:
      `${SAMPLE_NOTICE}. ${SAMPLE_COMPANY} is a fictitious company and the figures below are ` +
      `illustrative; no appraisal was performed and nobody has signed this document. It is published ` +
      `to show the structure, schedules and level of support of the report an engagement produces. ` +
      `In a client's report this page states the concluded fair market value of the common stock as of ` +
      `the valuation date, the total equity value it was allocated from, and the discounts applied.`,
    charts: [
      {
        type: 'waterfall',
        title: 'Total equity value to common',
        start: { label: 'Equity value', value: EQUITY_VALUE, display: money(EQUITY_VALUE) },
        steps: [
          { label: 'Preferred', value: -PREFERRED_VALUE, display: `−${money(PREFERRED_VALUE)}` },
          { label: 'Option pool', value: -POOL_VALUE, display: `−${money(POOL_VALUE)}` },
        ],
        end_label: 'Common',
        end_value: COMMON_VALUE,
        end_display: money(COMMON_VALUE),
        note: 'Illustrative — see Exhibit F for the allocation this summarises.',
      },
    ],
  };
}

/**
 * The skeleton with the sample's narrative swapped into the chapters it leaves
 * for the analyst.
 *
 * `authored` is left on the overridden sections deliberately. It is the
 * skeleton's declaration of what *kind* of chapter this is, not a claim about
 * this copy's contents, and the census test reads it from `templateForKind`
 * anyway — clearing it here would only hide a chapter from the very check that
 * is supposed to notice a missing override.
 */
function sampleTemplate(kind: ValuationKind): ReportTemplate {
  const template = templateForKind(kind);
  return {
    ...template,
    sections: template.sections.map((s) => {
      const written = SAMPLE_NARRATIVE[s.key];
      if (written !== undefined) return { ...s, html: written };
      // The mixed chapters: the skeleton's own prose, with the sentences that
      // ask the analyst for something replaced by this engagement's answer. A
      // replacement that no longer matches leaves the chapter as it was and is
      // reported by `unappliedSampleAnswers`.
      const answers = SAMPLE_ANSWERS[s.key];
      if (answers === undefined) return s;
      let html = s.html;
      for (const [instruction, answer] of answers) html = html.replace(instruction, answer);
      return { ...s, html };
    }),
  };
}

/**
 * The sample's body, resolved exactly as the render will print it.
 *
 * Split out of `sampleReportPdfInput` so `reviewReport` can be run over the
 * document with its section keys intact. The keys are what every check in
 * `domain/reportReview.ts` is written against, and `ReportPdfInput.sections`
 * has dropped them by the time the renderer sees it — so a test built from the
 * render input could only rejoin body and finding by matching headings, which
 * is a second opinion about the document rather than the document.
 */
export function sampleReportContent(kind: ValuationKind = '409a'): ReportContent {
  const exhibits = sampleExhibits();
  return fillFigures(
    /*
     * Signed by nobody, deliberately — and therefore *resolved* rather than
     * skipped. The certification carries `{{signatures}}`, so a sample that did
     * not run this step would print the marker itself on a public marketing
     * asset. Resolving it against an empty list prints the ruled, empty
     * signature lines and the sentence saying the report is unsigned and may not
     * be relied upon, which is the fourth mark (after the footer, the cover fact
     * and the summary's opening sentence) separating this document from an
     * appraisal.
     */
    resolveSignatures(
      resolveExhibitReferences(
        instantiateTemplate(sampleTemplate(kind), {
          company_name: SAMPLE_COMPANY,
          kind,
          valuation_ref: 'SAMPLE-409A',
          date: SAMPLE_VALUATION_DATE,
          currency: SAMPLE_CURRENCY,
        }),
        exhibits,
      ),
      [],
    ),
    // A plain object rather than a row: `reportFigures` reads `status` and
    // `results` and nothing else, and fabricating a whole CalculationRow would
    // couple the sample to columns it has no opinion about.
    reportFigures(
      { status: 'succeeded', results: sampleResults() } as unknown as CalculationRow,
      SAMPLE_CURRENCY,
    ),
  );
}

/**
 * The render input for the public sample, ready for `renderReportPdf`.
 *
 * Split out from the route so the assertions can read the document's structure
 * without rendering 8 MB of PDF for every case, and so `tools/sample-report.mjs`
 * has something to diff a real engagement against.
 */
export function sampleReportPdfInput(kind: ValuationKind = '409a'): ReportPdfInput {
  const template = templateForKind(kind);
  const content = sampleReportContent(kind);
  const exhibits = sampleExhibits();

  return {
    title: `${template.name} — ${SAMPLE_COMPANY} (SAMPLE)`,
    company_name: SAMPLE_COMPANY,
    meta: [
      // First, so it is the first fact on the cover rather than the last.
      { label: 'Notice', value: SAMPLE_NOTICE },
      { label: 'Engagement', value: 'SAMPLE-409A' },
      { label: 'Kind', value: kind },
      { label: 'Valuation date', value: SAMPLE_VALUATION_DATE },
      { label: 'Template', value: template.version },
      { label: 'Currency', value: SAMPLE_CURRENCY },
    ],
    sections: [...visibleSections(content).map((s) => ({ heading: s.heading, html: s.html })), ...exhibits],
    summary: sampleSummary(),
    confidentiality: SAMPLE_NOTICE,
    // Fixed, so the same request produces the same bytes and the download can
    // be cached. `generated_at` is the PDF's CreationDate; a moving one would
    // make every response a new document for no reader-visible reason.
    generated_at: new Date(`${SAMPLE_VALUATION_DATE}T00:00:00.000Z`),
    keywords: ['sample', '409A', 'valuation', template.version],
  };
}
