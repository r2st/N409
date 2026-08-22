import type { ReportPdfInput, ReportPdfSection, ReportPdfSummary } from '@n409/report/pdf';
import { instantiateTemplate, templateForKind, visibleSections } from './report.js';
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
 * engagement standing in
 * for the database. Change the 409A template and the sample changes with it;
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

/** The three indications and the weights the reconciliation applies to them. */
const APPROACHES = [
  { name: 'OPM backsolve to the Series B round', indication: BACKSOLVE_INDICATION, weight: 0.6 },
  { name: 'Market approach — guideline public companies', indication: MARKET_INDICATION, weight: 0.3 },
  { name: 'Income approach — discounted cash flow', indication: INCOME_INDICATION, weight: 0.1 },
] as const;

const EQUITY_VALUE = sum(APPROACHES.map((a) => a.indication * a.weight));

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
    discounts: { dloc: DLOC, dlom: DLOM },
    assumptions: { volatility: 0.62, risk_free_rate: 0.0418, time_to_exit_years: 3.5 },
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
 * The render input for the public sample, ready for `renderReportPdf`.
 *
 * Split out from the route so the assertions can read the document's structure
 * without rendering 8 MB of PDF for every case, and so `tools/sample-report.mjs`
 * has something to diff a real engagement against.
 */
export function sampleReportPdfInput(kind: ValuationKind = '409a'): ReportPdfInput {
  const template = templateForKind(kind);
  const exhibits = sampleExhibits();
  const content = fillFigures(
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
        instantiateTemplate(template, {
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
