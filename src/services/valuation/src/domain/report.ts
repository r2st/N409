import type { ValuationKind } from './valuation.js';

/**
 * Report domain: versioned templates (features.md — "bound to template
 * version", e.g. 409a.v53), the editor content model, and the HTML whitelist
 * shared with the PDF renderer.
 *
 * Content is a list of sections, each holding a constrained HTML fragment.
 * The whitelist is enforced server-side on every save; the PDF renderer
 * (@n409/report) understands exactly this subset.
 */

/**
 * States in which the rendered deliverable is the file of record.
 *
 * Once a 409A is published the client holds the PDF: it is attached to board
 * minutes, filed with an auditor, and relied on for a grant's safe harbour.
 * Re-rendering it in place would replace that file with a different one under
 * the same version number — same engagement, same "v3", different concluded
 * value — and nobody outside this system would have any way to notice.
 *
 * That is not hypothetical. The exhibits are computed at render time from the
 * *latest* calculation, which is what makes them agree with the summary page,
 * and it also means a recalculation moves everything a re-render would produce.
 * So the two facts together are what require this: a report whose figures are
 * derived fresh must have its rendered bytes frozen once they are delivered.
 *
 * Draft states are deliberately not here. Rendering, recalculating and
 * re-rendering is the ordinary drafting loop, and nothing outside the platform
 * holds those bytes.
 */
export const DELIVERED_REPORT_STATES: ReadonlySet<string> = new Set(['published']);

export interface ReportSection {
  key: string;
  heading: string;
  html: string;
}

export interface ReportContent {
  title: string;
  sections: ReportSection[];
}

export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'blockquote',
  'a',
]);

/**
 * Cutting a `open … close` span with one lazy regex — `<!--[\s\S]*?-->` — is
 * quadratic on input that opens spans it never closes: every `<!--` is a
 * candidate start, and with no `-->` to be found each one rescans to the end of
 * the input before failing.
 *
 * That matters here because the span markers are the cheapest bytes an author
 * can send. A report section is capped at 100,000 characters and a report takes
 * 50 of them, and 50 sections of `<!--` — the largest body the schema accepts —
 * held the event loop for 43 seconds on one `PUT .../report`. Nothing
 * allocates, so no memory bound sees it; the scan is synchronous, so no request
 * timeout interrupts it; and the stall lands on every other request the process
 * is serving. The same body then costs a viewer's browser the same 43 seconds,
 * because the editor sanitizes what it renders too.
 *
 * The two below scan forward instead. A closing marker only ever moves later in
 * the input, so a search that comes back empty has settled the question for
 * every opening marker after it too — that is what makes a missing close cost
 * one pass rather than one per candidate.
 */

/** Remove `<!-- … -->` spans, leaving an unterminated comment where it stands. */
function stripComments(html: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const start = html.indexOf('<!--', at);
    if (start === -1) break;
    const end = html.indexOf('-->', start + 4);
    if (end === -1) break; // no `-->` remains for this `<!--` or for any after it
    out += html.slice(at, start);
    at = end + 3;
  }
  return out + html.slice(at);
}

const RAW_TEXT_OPEN = /<(script|style)\b[^>]*>/gi;
const RAW_TEXT_CLOSE = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };

/** Remove `<script>…</script>` and `<style>…</style>` bodies, open tag included. */
function stripRawText(html: string): string {
  // Tracked per name, because failing to find `</script>` says nothing about
  // whether a `</style>` is still to come.
  const unclosed = new Set<string>();
  let out = '';
  let at = 0;
  RAW_TEXT_OPEN.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = RAW_TEXT_OPEN.exec(html)) !== null) {
    const name = open[1]!.toLowerCase() as keyof typeof RAW_TEXT_CLOSE;
    if (unclosed.has(name)) continue;
    const closeRe = RAW_TEXT_CLOSE[name];
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(html);
    if (close === null) {
      unclosed.add(name);
      continue;
    }
    out += html.slice(at, open.index);
    at = close.index + close[0].length;
    RAW_TEXT_OPEN.lastIndex = at;
  }
  return out + html.slice(at);
}

/** Sticky, so the tag head is matched in place rather than searched for. */
const TAG_HEAD = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b/y;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/**
 * Reduces arbitrary editor HTML to the whitelist: script/style bodies are
 * removed outright, allowed tags are kept with all attributes stripped —
 * except <a>, which keeps a validated http(s)/mailto href (gap 9) —
 * anything else is dropped (its text content survives).
 *
 * Scans for the brackets rather than letting two regexes find them, for the
 * reason the block above `stripComments` spells out at length — and which the
 * two regexes this replaces were missed by. Both ended in `[^>]*>`:
 *
 *     /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g     the tag filter
 *     /<[^a-zA-Z\/!][^>]*>/g                              the junk-tag sweep
 *
 * On input with no `>` in it, that tail runs to the end of the document from
 * every `<`, fails, backtracks the whole way, and the engine advances one
 * character and does it again. Measured on `"<p"` repeated (and identically on
 * `"<3"`, which exercises the second regex): 12.5k characters 36ms, 25k 140ms,
 * 50k 567ms, 100k 2.27s — a clean 4x per doubling against 3ms for ordinary
 * editor HTML of the same size, and 100,000 is what `reports.ts` allows per
 * section.
 *
 * Both ends of that are load-bearing. Server-side this runs on every report
 * version saved and every help article written, in a single-process service, so
 * it is 2.3 seconds during which nothing else is served. Client-side the
 * identical copy in the editor runs on *every keystroke*, so a document holding
 * that shape freezes the editor a keystroke at a time.
 *
 * Each scan is linear because `gt` only moves forward: a `>` that is not there
 * for this `<` is not there for any `<` after it either — and both regexes
 * required one, so once there is no `>` left the rest of the input is text.
 *
 * Still two passes, deliberately. They are not interchangeable with one: the
 * junk sweep runs over what the tag filter *left*, so a `<3` in front of a
 * dropped `<img …>` keeps its text ("<3") because the `>` that would have
 * closed it went with the img. Folding the two together silently ate that text
 * — caught by differentially testing the scan against the regexes it replaces
 * over every ordered pair and triple of a tag alphabet.
 */
export function sanitizeHtml(html: string): string {
  return dropJunkTags(filterTags(stripComments(stripRawText(html))));
}

/** Whitelist pass: allowed tags kept (bare), everything else dropped. */
function filterTags(source: string): string {
  let out = '';
  let last = 0;
  let at = 0;
  let gt = -1;
  for (;;) {
    const lt = source.indexOf('<', at);
    if (lt === -1) break;
    if (gt < lt) gt = source.indexOf('>', lt + 1);
    if (gt === -1) break; // no `>` remains, for this `<` or any after it
    TAG_HEAD.lastIndex = lt;
    const m = TAG_HEAD.exec(source);
    if (m === null) {
      at = lt + 1; // a `<` that starts no tag; the junk sweep decides its fate
      continue;
    }
    out += source.slice(last, lt);
    const close = m[1]!;
    const tag = m[2]!.toLowerCase();
    const attrsFrom = TAG_HEAD.lastIndex;
    last = at = gt + 1;
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (tag === 'br') {
      out += '<br>';
      continue;
    }
    if (tag === 'a' && !close) {
      // Bounded by this tag's own length, and tags do not overlap.
      const href = HREF.exec(source.slice(attrsFrom, gt));
      const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
      out += SAFE_URL.test(url) ? `<a href="${url.replace(/"/g, '&quot;')}">` : '<a>';
      continue;
    }
    out += `<${close}${tag}>`;
  }
  return out + source.slice(last);
}

/**
 * Junk sweep: `<` followed by anything that cannot begin a tag, through to its
 * `>`. `/` and `!` stay excluded as they were — a stray `</>` or a `<!` left by
 * an unterminated comment is text, not a tag.
 *
 * The closing `>` is searched from `lt + 2`, not `lt + 1`, because the regex
 * this replaces spent a character on the junk lead before looking for it: in
 * `/<[^a-zA-Z\/!][^>]*>/`, the `[^a-zA-Z\/!]` consumes `lt + 1`. So a bare `<>`
 * is not a junk tag and survives as text, which is the answer the old regex
 * gave and the differential test insisted on.
 */
function dropJunkTags(source: string): string {
  let out = '';
  let last = 0;
  let at = 0;
  let gt = -1;
  for (;;) {
    const lt = source.indexOf('<', at);
    if (lt === -1) break;
    if (gt < lt + 2) gt = source.indexOf('>', lt + 2);
    if (gt === -1) break;
    const next = source[lt + 1]!;
    if (next === '/' || next === '!' || (next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z')) {
      at = lt + 1;
      continue;
    }
    out += source.slice(last, lt);
    last = at = gt + 1;
  }
  return out + source.slice(last);
}

export function sanitizeContent(content: ReportContent): ReportContent {
  return {
    title: content.title,
    sections: content.sections.map((s) => ({ ...s, html: sanitizeHtml(s.html) })),
  };
}

// ── Templates ─────────────────────────────────────────────────────────────────

export interface ReportTemplateVars {
  company_name: string;
  kind: ValuationKind;
  valuation_ref: string;
  date: string; // YYYY-MM-DD
  currency: string;
}

interface TemplateSectionDef {
  key: string;
  heading: string;
  html: string; // may contain {{placeholders}}
}

export interface ReportTemplate {
  version: string;
  name: string;
  sections: TemplateSectionDef[];
}

const P = (text: string) => `<p>${text}</p>`;

/**
 * The 409A deliverable skeleton, modelled on the production 409a layout.
 * v54 adds the sections a reviewing auditor expects to find and the earlier
 * skeleton omitted: standard/premise of value, sources of information, the
 * §409A safe-harbor statement and the appraiser certification.
 *
 * v55 closes the rest of that list against the structure a reviewing appraiser
 * works through — Rev. Rul. 59-60, the AICPA valuation-of-privately-held-equity
 * practice aid, and USPAP/SSVS-1 reporting requirements between them ask for
 * each of the following, and the skeleton had none of them:
 *
 *   * capital structure — the rights that decide how value is split, described
 *     before the section that splits it;
 *   * economic outlook — Rev. Rul. 59-60 §4.02(b) makes the economic and
 *     industry outlook a mandatory factor, and only the industry half was here;
 *   * one section per approach applied. The skeleton described all four in a
 *     single "Valuation Methodology" paragraph, so a report that ran a DCF and
 *     a guideline-company analysis had nowhere to say what was in either;
 *   * reconciliation — how the indications were weighted into one conclusion,
 *     which is the paragraph a reviewer challenges first;
 *   * DLOC. The engine has always applied one and the summary page has always
 *     printed it, and the deliverable never said why. A minority discount that
 *     appears in the arithmetic and nowhere in the prose is exactly the kind of
 *     unsupported adjustment that costs a valuation its safe harbour;
 *   * analyst qualifications — SSVS-1 §52 and USPAP Standards Rule 10-3 both
 *     require the appraiser's credentials in the report itself.
 *
 * Each new section names the exhibit that carries its figures (domain/
 * reportExhibits.ts), so the authored prose and the computed schedules read as
 * one document rather than two.
 *
 * v56 does two things.
 *
 * First, it makes the skeleton *state the conclusion*. Every figure in the body
 * was an ellipsis — "the fair market value … is $ … per share", eight rows of
 * "$ …" in the ASC 718 table — because the skeleton is instantiated before the
 * engine has run and so could only carry facts known at that moment. The
 * placeholders below (`{{fmv_per_share}}`, `{{dlom}}`, `{{volatility}}` …)
 * resolve at *render* time against the calculation that produced the
 * conclusion; see domain/reportFigures.ts, which owns the substitution and the
 * reasoning. An analyst who wants different words still types over them.
 *
 * Second, it closes the last structural gaps against the chapter list the
 * legacy 409.ai deliverable works through, which had no counterpart here:
 *
 *   * purpose and intended use — the legacy report's §1.1/§3.2, and the first
 *     thing a reader of a tax opinion checks. The skeleton stated the standard
 *     of value and never who the report was for or what it may be relied on
 *     for, which is precisely the question a limiting-conditions section
 *     answers too late;
 *   * company analysis — the Rev. Rul. 59-60 §4.01 factors, one by one. "4.
 *     Company Overview" invited a paragraph of description; the ruling asks for
 *     eight specific findings and a reviewer works down them;
 *   * market movement — the legacy §8.1. The backsolve reads a value out of a
 *     dated financing round, and concluding on it unadjusted asserts the market
 *     did not move in between. The engine now measures the adjustment
 *     (engine/market_movement.py); this is where the report explains it;
 *   * use, distribution and subsequent events — the legacy §§12.4–12.8. A
 *     valuation report that does not say who may rely on it, what happens if
 *     the analyst is subpoenaed, and that it is not updated for later events is
 *     one whose limits are decided after the fact by whoever is arguing about
 *     it.
 */
const TEMPLATE_409A: ReportTemplate = {
  version: '409a.v56',
  name: 'IRC 409A Valuation Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our determination of the fair market value of the common stock of <strong>{{company_name}}</strong> as of {{date}}, prepared for purposes of Section 409A of the Internal Revenue Code and ASC 718.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'purpose_and_scope',
      heading: 'Purpose of the Valuation & Intended Use',
      html:
        P(
          'This valuation was prepared for <strong>{{company_name}}</strong> for the sole purpose of establishing the fair market value of its common stock, to support the exercise price of stock options granted under Section 409A of the Internal Revenue Code and the grant-date measurement of share-based compensation under ASC 718.',
        ) +
        '<ul>' +
        '<li><strong>Intended user</strong> — the board of directors of {{company_name}} and its officers, together with the company’s accountants and auditors in connection with the financial reporting of share-based payment.</li>' +
        '<li><strong>Intended use</strong> — setting option exercise prices and measuring compensation cost. No other use is intended or authorized.</li>' +
        '<li><strong>Subject interest</strong> — one share of common stock, on a non-marketable, minority-interest basis.</li>' +
        '<li><strong>Scope of work</strong> — a full appraisal reported in this detailed report; no scope limitation was agreed or applied.</li>' +
        '</ul>' +
        P(
          'The valuation is not an opinion on the price at which the company or any interest in it would transact in a negotiated sale, a fairness opinion, an audit, or investment advice, and it should not be relied on for any of those purposes.',
        ),
    },
    {
      key: 'standard_of_value',
      heading: 'Standard & Premise of Value',
      html:
        P(
          'The standard of value applied is <strong>fair market value</strong>, defined in Revenue Ruling 59-60 as the price at which the property would change hands between a willing buyer and a willing seller, neither being under any compulsion to buy or sell and both having reasonable knowledge of the relevant facts.',
        ) +
        P(
          'The premise of value is <strong>going concern</strong> — {{company_name}} is assumed to continue operating as an ongoing business enterprise rather than being liquidated.',
        ),
    },
    {
      key: 'sources_of_information',
      heading: 'Sources of Information',
      html:
        P('Our analysis relied on the following information provided by management and on public data:') +
        '<ul>' +
        '<li>Capitalization table as of the valuation date</li>' +
        '<li>Historical financial statements (income statement, balance sheet)</li>' +
        '<li>Management financial projections</li>' +
        '<li>Articles of incorporation and amendments, including preferred stock rights</li>' +
        '<li>Stock option plan and outstanding grant records</li>' +
        '<li>Financing documents for the most recent round</li>' +
        '<li>Guideline public company and transaction data</li>' +
        '</ul>' +
        P(
          'Information supplied by management has been accepted as accurate without independent verification or audit.',
        ),
    },
    {
      key: 'company_overview',
      heading: 'Company Overview',
      html: P(
        'Describe the business of {{company_name}}: products, customers, stage, headcount, and capital raised to date.',
      ),
    },
    {
      key: 'company_analysis',
      heading: 'Company Analysis',
      html:
        P(
          'Revenue Ruling 59-60 §4.01 sets out the factors to be considered in valuing the stock of a closely held corporation. Each is addressed below; where a factor carries little weight for a company at this stage, say so and why rather than omitting it.',
        ) +
        '<ul>' +
        '<li><strong>Nature and history of the business</strong> — formation, what the company does, how the business has developed and any discontinuity in that record.</li>' +
        '<li><strong>Economic and industry outlook</strong> — addressed in the two sections that follow.</li>' +
        '<li><strong>Book value and financial condition</strong> — balance-sheet position, cash and runway, and the extent to which book value bears on the value of a business of this kind.</li>' +
        '<li><strong>Earning capacity</strong> — historical and prospective, and the basis on which the projections relied on were prepared.</li>' +
        '<li><strong>Dividend-paying capacity</strong> — the capacity, not the history; a growth company that pays none may still have capacity, and the ruling asks about capacity.</li>' +
        '<li><strong>Goodwill and other intangible value</strong> — brand, technology, assembled workforce, and whether these are captured by the approaches applied.</li>' +
        '<li><strong>Prior sales of stock and the size of the block</strong> — the financing history, the terms of the most recent round, and any secondary transactions in common.</li>' +
        '<li><strong>Comparable companies</strong> — the guideline set, addressed under the market approach.</li>' +
        '</ul>' +
        P(
          'Set out the specific risks a buyer of common stock would price: concentration, competition, regulatory exposure, key-person dependence and the funding required to reach the next milestone.',
        ),
    },
    {
      key: 'capital_structure',
      heading: 'Capital Structure',
      html:
        P(
          'The capitalization of {{company_name}} as of the valuation date is set out in <strong>Exhibit A</strong>. Describe each class of stock outstanding and the economic rights that bear on the allocation of equity value:',
        ) +
        '<ul>' +
        '<li>Liquidation preference of each preferred series, its seniority rank, and whether ranks are pari passu</li>' +
        '<li>Participation rights and any participation cap</li>' +
        '<li>Conversion ratios and any anti-dilution adjustments in effect</li>' +
        '<li>Options, warrants and other dilutive instruments, with their exercise prices</li>' +
        '<li>Convertible notes and SAFEs outstanding, and the terms on which they convert</li>' +
        '</ul>' +
        P(
          'These rights determine the payoff of each class at a liquidity event and are the direct inputs to the allocation described below.',
        ),
    },
    {
      key: 'economic_outlook',
      heading: 'Economic Outlook',
      html: P(
        'Revenue Ruling 59-60 §4.01(b) requires consideration of the economic outlook in general, and the condition and outlook of the specific industry in particular. Summarize the macroeconomic conditions prevailing at the valuation date that bear on this valuation — growth, inflation, the interest-rate environment underlying the risk-free rate applied below, and the state of the private capital markets on which the company depends for funding.',
      ),
    },
    {
      key: 'industry_market',
      heading: 'Industry & Market Analysis',
      html: P('Summarize the industry landscape, market size and growth, and competitive positioning.'),
    },
    {
      key: 'financial_analysis',
      heading: 'Financial Analysis',
      html: P(
        'Summarize historical performance and management projections from the valuation workbook, noting revenue status, burn and runway.',
      ),
    },
    {
      key: 'methodology',
      heading: 'Valuation Methodology',
      html:
        P(
          'Describe the approaches considered — asset, income, market, and OPM backsolve — and their weights.',
        ) +
        '<ul><li>Asset approach</li><li>Income approach</li><li>Market approach</li><li>Option-pricing (backsolve)</li></ul>',
    },
    {
      key: 'income_approach',
      heading: 'Income Approach',
      html:
        P(
          'The income approach measures value as the present worth of the future economic benefits of the business. We applied the discounted cash flow method: management’s projected free cash flows over the explicit forecast period are discounted to present value at a rate reflecting the risk of achieving them, and a terminal value representing the cash flows beyond that period is discounted alongside them.',
        ) +
        P(
          'State the source and reliability of the projections, the derivation of the discount rate, and the basis for the terminal growth rate. The forecast, the discount factors and the bridge from enterprise to equity value are set out in <strong>Exhibit C</strong>.',
        ),
    },
    {
      key: 'market_approach',
      heading: 'Market Approach',
      html:
        P(
          'The market approach measures value by reference to prices at which comparable businesses or interests have changed hands. We considered the guideline public company method and the guideline transaction method, applying multiples observed for the selected comparables to the corresponding metric of {{company_name}}.',
        ) +
        P(
          'Identify the guideline companies or transactions selected, the basis for selecting them, the metric and period chosen, and any adjustments made for differences in size, growth, margin or stage. The observed multiples and the resulting indication are set out in <strong>Exhibit D</strong>.',
        ),
    },
    {
      key: 'asset_approach',
      heading: 'Asset Approach',
      html: P(
        'The asset approach measures value as the value of the underlying assets net of liabilities, on either a net-asset-value or a cost-to-replicate basis. State whether the approach was applied and the weight assigned to it; for a going concern whose value rests on intangible assets and future earnings rather than tangible net assets, explain the reason for a low weight or for excluding it. The computation, where applied, is set out in <strong>Exhibit E</strong>.',
      ),
    },
    {
      key: 'market_movement',
      heading: 'Adjustment Factor: Market Movement',
      html:
        P(
          'The option-pricing backsolve reads a value out of the most recent financing round: the price at which that round transacted is evidence of what the company was worth <em>on the day it closed</em>. That is the strongest single input available to this valuation, and it is also the one that decays. Where time has passed between the round and the valuation date, concluding on the round price unadjusted asserts that the market for companies of this profile did not move in the interval.',
        ) +
        P(
          'Where an adjustment has been applied, the round indication is moved by the return of a public benchmark over the same interval, geared by the subject’s sensitivity to it: <strong>factor = 1 + β × benchmark return</strong>. Identify the benchmark selected and why it is the right proxy for this company, the measurement dates, and the basis for the beta applied. Both the unadjusted and the adjusted indications are set out in <strong>Exhibit B</strong>.',
        ) +
        P(
          'Benchmark: {{market_movement_index}}. Return over the period: {{market_movement_return}}. Adjustment factor: {{market_movement_factor}}.',
        ) +
        P(
          'Where no adjustment has been applied — because the round is close enough to the valuation date that no measurable movement separates them, or because no benchmark is a defensible proxy — say so and state the reason. An unadjusted round indication is a conclusion, not an omission, and should read as one.',
        ),
    },
    {
      key: 'reconciliation',
      heading: 'Reconciliation of Value Indications',
      html:
        P(
          'The approaches applied produce separate indications of total equity value. <strong>Exhibit B</strong> sets out each indication, the weight assigned to it, and the resulting concluded equity value.',
        ) +
        P(
          'Explain the weighting: the relevance of each approach to a company of this stage and sector, the quality of the inputs available to it, and the reason any approach considered was assigned no weight. The concluded equity value carried forward to the allocation below is the weighted result.',
        ) +
        P('Concluded total equity value: <strong>{{equity_value}}</strong>.'),
    },
    {
      key: 'allocation',
      heading: 'Allocation of Equity Value',
      html:
        P(
          'Describe the option-pricing model allocation across share classes, including term, volatility and risk-free-rate inputs.',
        ) +
        P(
          'Under the breakpoint method the payoff of each class is piecewise linear in exit equity value, so its expected value is the sum of Black-Scholes call spreads between consecutive breakpoints. The breakpoints, the value of each tranche and the resulting value of each class are set out in <strong>Exhibit F</strong>. State the source of the expected volatility and the basis for the expected time to a liquidity event.',
        ) +
        P(
          'Inputs applied: expected volatility {{volatility}}, expected time to liquidity {{time_to_exit_years}} years, risk-free rate {{risk_free_rate}}. The allocation indicates a marketable, controlling value of <strong>{{marketable_value_per_share}}</strong> per common share before the discounts below.',
        ),
    },
    {
      key: 'dloc',
      heading: 'Discount for Lack of Control',
      html:
        P(
          'The allocation above produces the value of a common share on a controlling basis. A holder of common stock in {{company_name}} holds a minority interest: it cannot compel a liquidity event, set the timing or terms of an exit, direct the business, or access the company’s cash flows. A discount for lack of control is therefore applied to reflect the difference between a controlling and a minority interest in the same equity.',
        ) +
        P(
          'State the basis for the concluded discount — control premium studies, the specific rights held by the preferred classes, or the analyst’s qualitative assessment. The concluded discount is <strong>{{dloc}}</strong>, applied as set out in <strong>Exhibit H</strong>.',
        ),
    },
    {
      key: 'dlom',
      heading: 'Discount for Lack of Marketability',
      html:
        P(
          'No public market exists for the common stock of {{company_name}}, and transfer is further restricted by the company’s charter and by the terms of its stock plan. A discount for lack of marketability is applied to reflect the cost and delay of achieving liquidity.',
        ) +
        P(
          'Describe the analysis supporting the concluded discount and why the method selected suits this holding:',
        ) +
        '<ul>' +
        '<li><strong>Quantitative — restricted stock studies.</strong> Where the conclusion rests on empirical studies of private placements of registered but unregistered-for-resale stock, name the studies relied on and note that observations predating the 1997 and 2008 amendments to Rule 144 measured a longer restriction than applies today.</li>' +
        '<li><strong>Quantitative — option-based models.</strong> Chaffee prices a protective put over the holding period; Finnerty and Ghaidarov price the average-strike put — the value of giving up the choice of when to sell. State the volatility and the holding period assumed, and note that the volatility of the <em>subject class</em> is not the volatility of the enterprise: common is a levered claim behind the preference stack, and <strong>Exhibit H-1</strong> sets out the class volatilities.</li>' +
        '<li><strong>Qualitative.</strong> Where judgement adjusts a modelled figure, identify the factors weighed — distribution history, transfer restrictions, the pool of likely buyers, the expected time to liquidity — and the direction and size of the adjustment.</li>' +
        '</ul>' +
        P(
          'The concluded discount is <strong>{{dlom}}</strong>. Its derivation is set out in <strong>Exhibit H-1</strong> and its application in <strong>Exhibit H</strong>.',
        ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html:
        P(
          'Based on the analyses described herein, it is our opinion that the fair market value of one share of common stock of <strong>{{company_name}}</strong> as of {{date}} is <strong>{{fmv_per_share}}</strong> per share.',
        ) +
        P(
          'The conclusion is stated on a non-marketable, minority-interest basis. It derives from a concluded total equity value of {{equity_value}}, allocated to a marketable, controlling common value of {{marketable_value_per_share}} per share, less a discount for lack of control of {{dloc}} and a discount for lack of marketability of {{dlom}} — a combined discount of {{combined_discount}}. The full derivation is set out in <strong>Exhibit H</strong>.',
        ) +
        P(
          'This conclusion is valid as of the valuation date stated and is subject to the assumptions and limiting conditions set out below.',
        ),
    },
    {
      key: 'asc718',
      heading: 'ASC 718 Stock-Based Compensation',
      html:
        P(
          'This section presents the grant-date fair value of option awards and the related stock-based compensation expense recognized under ASC 718, measured using the concluded 409A fair market value above as the grant-date price of the underlying common stock.',
        ) +
        P(
          'Grant-date fair value is estimated with the Black-Scholes-Merton option-pricing model using the expected term, expected volatility, risk-free rate and dividend yield tabulated below; the resulting compensation cost is recognized on a straight-line basis over each award’s requisite service (vesting) period, net of expected forfeitures.',
        ) +
        // The rows the 409A supplies are filled from the calculation; the rows
        // that belong to the *grants* (strike, expected term, the resulting
        // per-option value) are left for the analyst, because they are measured
        // against the awards on file rather than by this valuation. Marked as
        // such rather than left as a bare ellipsis, so a reader can tell an
        // unfilled row from an inapplicable one.
        '<table><thead><tr><th>Assumption</th><th>Input</th><th>Source</th></tr></thead><tbody>' +
        '<tr><td>Underlying fair value (409A)</td><td>{{asc718_underlying}} per share</td><td>Concluded above</td></tr>' +
        '<tr><td>Expected volatility</td><td>{{volatility}}</td><td>As applied in the allocation</td></tr>' +
        '<tr><td>Risk-free rate</td><td>{{risk_free_rate}}</td><td>As applied in the allocation</td></tr>' +
        '<tr><td>Expected term</td><td>… years</td><td>Per grant — SAB 14 simplified method or exercise history</td></tr>' +
        '<tr><td>Exercise price</td><td>… per share</td><td>Per grant</td></tr>' +
        '<tr><td>Dividend yield</td><td>0.0%</td><td>No dividends expected over the term</td></tr>' +
        '<tr><td>Grant-date fair value per option</td><td>… per option</td><td>Black-Scholes-Merton on the above</td></tr>' +
        '<tr><td>Total compensation cost</td><td>…</td><td>Fair value × awards, net of expected forfeitures</td></tr>' +
        '</tbody></table>',
    },
    {
      key: 'limiting_conditions',
      heading: 'Assumptions & Limiting Conditions',
      html: P(
        'This report is valid only for the stated purpose and date, and relies on information provided by management, which we have not audited.',
      ),
    },
    {
      key: 'use_and_distribution',
      heading: 'Use, Distribution & Subsequent Events',
      html:
        '<ul>' +
        '<li><strong>Use of this report.</strong> This report is prepared for the intended user and intended use stated at the front of it. Any other use is unauthorized, and no third party acquires any right or claim against us by obtaining a copy.</li>' +
        '<li><strong>Distribution.</strong> Neither this report nor any part of it — including the conclusion of value, the identity of the analysts, or any reference to the professional bodies to which they belong — may be published, quoted or referred to publicly without our prior written consent.</li>' +
        '<li><strong>Subsequent events.</strong> This valuation reflects facts and conditions existing at the valuation date. Events occurring afterwards — a financing, an offer, a loss of a key customer, a change in market conditions — may materially affect the conclusion, and we have no obligation to update this report for them. Under Treasury Regulation §1.409A-1(b)(5)(iv)(B)(1) the presumption of reasonableness does not survive a material event occurring after the valuation date.</li>' +
        '<li><strong>Legal matters.</strong> We express no opinion on questions of law: title, the enforceability of the charter and stock-plan provisions relied on, the tax treatment of any grant, or compliance with securities law. We have relied on the governing documents as provided without legal review.</li>' +
        '<li><strong>Testimony.</strong> We are not required to give testimony or to appear in court or before any administrative body by reason of having prepared this report, unless arrangements to do so have been made in advance and in writing.</li>' +
        '</ul>',
    },
    {
      key: 'safe_harbor',
      heading: 'Section 409A Safe Harbor',
      html:
        P(
          'Treasury Regulation §1.409A-1(b)(5)(iv)(B)(1) presumes a valuation to be reasonable where it is determined by the application of a reasonable valuation method by a qualified independent appraiser, as of a date no more than 12 months before the relevant option grant, and where no material event has occurred since that date.',
        ) +
        P(
          'This valuation is intended to satisfy that independent-appraisal presumption. The presumption may be rebutted by the Internal Revenue Service only on a showing that the valuation was grossly unreasonable.',
        ),
    },
    {
      key: 'certification',
      heading: 'Appraiser Certification',
      html:
        P('We certify that, to the best of our knowledge and belief:') +
        '<ul>' +
        '<li>The statements of fact in this report are true and correct.</li>' +
        '<li>The analyses, opinions and conclusions are limited only by the assumptions and limiting conditions stated, and are our personal, impartial and unbiased professional analyses.</li>' +
        '<li>We have no present or prospective interest in {{company_name}} and no personal interest with respect to the parties involved.</li>' +
        '<li>Our compensation is not contingent on the reporting of a predetermined value, on the amount of the value opinion, or on the occurrence of any subsequent event.</li>' +
        '<li>No one provided significant professional assistance to the persons signing this report except as disclosed herein.</li>' +
        '</ul>',
    },
    {
      key: 'qualifications',
      heading: 'Qualifications of the Valuation Analyst',
      html:
        P(
          'Set out the professional qualifications of the analyst or analysts responsible for this valuation, as required by SSVS-1 and by the independent-appraiser condition of Treasury Regulation §1.409A-1(b)(5)(iv)(B)(1):',
        ) +
        '<ul>' +
        '<li>Name, role and firm</li>' +
        '<li>Professional credentials held (ABV, ASA, CFA, CVA or equivalent)</li>' +
        '<li>Relevant experience in the valuation of privately held equity securities</li>' +
        '<li>Extent of the analyst’s participation in the analyses and conclusions reported</li>' +
        '</ul>',
    },
    {
      key: 'exhibit_index',
      heading: 'Index of Exhibits',
      html:
        P('The exhibits that follow are generated from the valuation model supporting this report.') +
        '<ul>' +
        '<li>Exhibit A — Capitalization Table</li>' +
        '<li>Exhibit B — Reconciliation of Valuation Approaches</li>' +
        '<li>Exhibit C — Income Approach (Discounted Cash Flow)</li>' +
        '<li>Exhibit D — Market Approach (Guideline Multiples)</li>' +
        '<li>Exhibit E — Asset Approach</li>' +
        '<li>Exhibit F — Allocation of Equity Value</li>' +
        '<li>Exhibit G — Probability-Weighted Expected Return Scenarios</li>' +
        '<li>Exhibit H — Discounts and Concluded Value</li>' +
        '<li>Exhibit H-1 — Marketability Discount: Derivation</li>' +
        '</ul>' +
        P(
          'An exhibit is included only where the corresponding analysis was applied in this valuation; exhibits for approaches and methods not used are omitted.',
        ),
    },
  ],
};

/** Fallback skeleton for the kinds without a dedicated skeleton below. */
const TEMPLATE_GENERIC: ReportTemplate = {
  version: 'generic.v2',
  name: 'Valuation Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html: P(
        'This report presents our valuation analysis of <strong>{{company_name}}</strong> ({{kind}}) as of {{date}}. Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.',
      ),
    },
    {
      key: 'company_overview',
      heading: 'Company Overview',
      html: P('Describe the business of {{company_name}}.'),
    },
    {
      key: 'analysis',
      heading: 'Valuation Analysis',
      html: P('Describe the methodology, inputs and analysis supporting the conclusion.'),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: P('State the concluded value and its basis.'),
    },
  ],
};

/**
 * Kind-specific skeletons for the specialty report types (remaining-gaps
 * §report-types). Each is the section list a reviewer of THAT deliverable
 * works through, in the order they expect to read it — not the 409A skeleton
 * with the title swapped. The analysis sections name the engine that computes
 * their figures (engine-wrapper: /engine/v1/qsbs, /ppa, /impairment, /esop,
 * /smb, /emi-csop, /intangible) so prose and calculation stay one document,
 * the same contract TEMPLATE_409A has with its exhibits.
 *
 * '718', '820', 'gifts' and 'ifrs2' have their own skeletons further down, as
 * do 'fund' and 'debt' — the two measurement kinds, whose schedules come from
 * their own tables rather than from a calculation (domain/navExhibits.ts).
 * Every kind now has a skeleton; nothing falls through to TEMPLATE_GENERIC.
 */
const TEMPLATE_QSBS: ReportTemplate = {
  version: 'qsbs.v2',
  name: 'QSBS Attestation Letter (IRC §1202)',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This letter documents our assessment of whether the stock of <strong>{{company_name}}</strong> qualifies as Qualified Small Business Stock under Section 1202 of the Internal Revenue Code, as of {{date}}.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'entity_test',
      heading: 'Eligible Corporation',
      html: P(
        'Describe the issuer’s form and domicile: qualification requires a domestic C corporation at issuance and through substantially all of the holding period (§1202(c)(1), (e)(4)).',
      ),
    },
    {
      key: 'gross_asset_test',
      heading: 'Gross Asset Test',
      html: P(
        'State the aggregate gross assets immediately before and immediately after the issuance against the $50 million ceiling of §1202(d)(1), and the basis for the measurement.',
      ),
    },
    {
      key: 'active_business_test',
      heading: 'Active Business Requirement',
      html: P(
        'Document that at least 80% of assets by value are used in the active conduct of a qualified trade or business (§1202(e)(1)), and that the issuer’s activity is not among the excluded businesses of §1202(e)(3).',
      ),
    },
    {
      key: 'issuance_and_holding',
      heading: 'Original Issuance & Holding Period',
      html: P(
        'Confirm the stock was acquired at original issue for money, property or services (§1202(c)(1)(B)), state the acquisition date, the five-year date, and the exclusion percentage the acquisition date fixes.',
      ),
    },
    {
      key: 'exclusion_cap',
      heading: 'Gain Exclusion Cap',
      html: P(
        'State the per-issuer limitation: the greater of $10 million (less previously excluded gain) or ten times the aggregate adjusted basis of stock disposed of in the taxable year (§1202(b)(1)).',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion',
      html: P(
        'State the conclusion reached on each requirement and the overall qualification, with the limiting conditions of this assessment.',
      ),
    },
  ],
};

const TEMPLATE_PPA: ReportTemplate = {
  version: 'ppa.v2',
  name: 'Purchase Price Allocation (ASC 805)',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our allocation of the consideration transferred in the acquisition of <strong>{{company_name}}</strong> among the identifiable assets acquired and liabilities assumed, measured at fair value as of {{date}} in accordance with ASC 805.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'transaction_overview',
      heading: 'Transaction Overview',
      html: P(
        'Describe the transaction: parties, structure, closing date, consideration transferred and its components (cash, equity, contingent consideration).',
      ),
    },
    {
      key: 'tangible_assets',
      heading: 'Tangible Assets & Assumed Liabilities',
      html: P(
        'Describe the working capital, fixed assets and assumed liabilities recognized, and any deferred-revenue haircut applied.',
      ),
    },
    {
      key: 'intangible_assets',
      heading: 'Identified Intangible Assets',
      html: P(
        'For each identified intangible (developed technology, customer relationships, trade names, non-competes): the valuation method applied (relief-from-royalty, multi-period excess earnings, with-and-without, cost), its key assumptions — royalty rate, attrition, contributory asset charges, discount rate — and the tax amortization benefit.',
      ),
    },
    {
      key: 'goodwill',
      heading: 'Goodwill',
      html: P(
        'State goodwill as the residual of consideration over identifiable net assets, and what it represents; a negative residual is recognized as a bargain-purchase gain under ASC 805-30-25-2.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Allocation',
      html: P('Present the allocation summary and confirm it ties to the consideration transferred.'),
    },
  ],
};

const TEMPLATE_IMPAIRMENT: ReportTemplate = {
  version: 'impairment.v2',
  name: 'Goodwill & Intangible Impairment Testing (ASC 350/360)',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our impairment testing of the goodwill and intangible assets of <strong>{{company_name}}</strong> as of {{date}}, performed in accordance with ASC 350 and ASC 360.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'reporting_units',
      heading: 'Reporting Units & Asset Groups',
      html: P(
        'Identify the reporting units and long-lived asset groups tested, the carrying amounts on their books, and the sequencing applied (ASC 360 asset groups first, then indefinite-lived intangibles, then goodwill).',
      ),
    },
    {
      key: 'qualitative_assessment',
      heading: 'Qualitative Assessment',
      html: P(
        'Where a step-zero assessment was performed, document the events and circumstances weighed and why they did or did not indicate that fair value more likely than not falls below carrying amount.',
      ),
    },
    {
      key: 'quantitative_tests',
      heading: 'Quantitative Tests',
      html: P(
        'For each unit or asset tested quantitatively: the fair-value determination and its method, the recoverability screen against undiscounted cash flows for long-lived asset groups (ASC 360-10), and the resulting comparison to carrying amount.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion',
      html: P(
        'State each impairment loss recognized (or that none was), the carrying amounts after measurement, and the remaining headroom by reporting unit.',
      ),
    },
  ],
};

const TEMPLATE_ESOP: ReportTemplate = {
  version: 'esop.v2',
  name: 'ESOP Valuation Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our determination of the fair market value of the common stock of <strong>{{company_name}}</strong> held by its employee stock ownership plan as of {{date}}, prepared for the plan trustee for purposes of ERISA §3(18) adequate consideration.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'company_overview',
      heading: 'Company Overview',
      html: P('Describe the business, its history, ownership and the ESOP’s position in it.'),
    },
    {
      key: 'valuation_approaches',
      heading: 'Valuation Approaches',
      html: P(
        'Describe the income and market approaches applied to conclude the enterprise and equity value, and the reconciliation between them.',
      ),
    },
    {
      key: 'level_of_value',
      heading: 'Level of Value & Discounts',
      html: P(
        'State the level of value at which the ESOP transacts (controlling or minority), the discount for lack of control or control premium applied, the discount for lack of marketability, and the support for each — the concluded per-share value follows this chain explicitly.',
      ),
    },
    {
      key: 'repurchase_obligation',
      heading: 'Repurchase Obligation',
      html: P(
        'Present the projected repurchase liability from expected participant redemptions — the schedule, its assumptions (redemption rate, share-value growth) and its present value — for the sponsor’s planning.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: P('State the concluded fair market value per share and of the ESOP’s holding.'),
    },
  ],
};

const TEMPLATE_SMB: ReportTemplate = {
  version: 'smb.v2',
  name: 'Business Valuation Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our estimate of the fair market value of <strong>{{company_name}}</strong> as of {{date}}.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'company_overview',
      heading: 'Company Overview',
      html: P('Describe the business, its market, customers, staffing and owner involvement.'),
    },
    {
      key: 'earnings_normalization',
      heading: 'Normalized Earnings (SDE)',
      html: P(
        'Present seller’s discretionary earnings: pre-tax income with owner compensation, interest, depreciation and one-time or discretionary items added back, and any replacement wage deducted.',
      ),
    },
    {
      key: 'valuation_methods',
      heading: 'Valuation Methods',
      html: P(
        'Describe the methods applied — capitalization of normalized earnings with a built-up rate, the SDE multiple, and any rule-of-thumb revenue multiple — with the support for the rates and multiples selected.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: P(
        'State the weighting of the method indications and the concluded fair market value, on a debt-free basis with the customary main-street transaction conventions.',
      ),
    },
  ],
};

const TEMPLATE_EMI: ReportTemplate = {
  version: 'emi.v2',
  name: 'EMI Valuation Report (HMRC)',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our valuation of the ordinary shares of <strong>{{company_name}}</strong> as of {{date}}, prepared to support an Enterprise Management Incentives share-option agreement with HMRC (form VAL231).',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'company_overview',
      heading: 'Company Overview',
      html: P('Describe the business, its capital structure and the class of shares under option.'),
    },
    {
      key: 'valuation_analysis',
      heading: 'Valuation Analysis',
      html: P(
        'Describe the approach to the company’s equity value and the per-share value derived from it, including any minority discount appropriate to the holding.',
      ),
    },
    {
      key: 'umv_amv',
      heading: 'UMV and AMV',
      html: P(
        'State the unrestricted market value and the actual market value per share, and the restrictions on the shares — leaver provisions, transfer restrictions — that separate the two.',
      ),
    },
    {
      key: 'scheme_limits',
      heading: 'Scheme Qualification',
      html: P(
        'Document the Schedule 5 conditions at grant: gross assets within £30 million, fewer than 250 full-time-equivalent employees, the £250,000 individual limit and £3 million company limit measured at UMV, and the working-time requirement.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion',
      html: P('State the concluded UMV and AMV per share proposed for agreement with HMRC.'),
    },
  ],
};

const TEMPLATE_CSOP: ReportTemplate = {
  version: 'csop.v2',
  name: 'CSOP Valuation Report (HMRC)',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our valuation of the ordinary shares of <strong>{{company_name}}</strong> as of {{date}}, prepared to support a Company Share Option Plan agreement with HMRC (form VAL230).',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'company_overview',
      heading: 'Company Overview',
      html: P('Describe the business, its capital structure and the class of shares under option.'),
    },
    {
      key: 'valuation_analysis',
      heading: 'Valuation Analysis',
      html: P(
        'Describe the approach to the company’s equity value and the unrestricted market value per share derived from it.',
      ),
    },
    {
      key: 'scheme_limits',
      heading: 'Scheme Qualification',
      html: P(
        'Document the Schedule 4 conditions at grant: the £60,000 individual limit measured at UMV, and that the exercise price is not less than the market value of the shares at grant.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion',
      html: P('State the concluded market value per share proposed for agreement with HMRC.'),
    },
  ],
};

const TEMPLATE_IP: ReportTemplate = {
  version: 'ip.v2',
  name: 'Intellectual Property Valuation Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our valuation of the identified intellectual property of <strong>{{company_name}}</strong> as of {{date}}.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'asset_description',
      heading: 'Subject Asset',
      html: P(
        'Describe the asset — patents, trademarks, software, trade secrets — its legal protection, remaining life and the rights valued.',
      ),
    },
    {
      key: 'valuation_methods',
      heading: 'Valuation Methods',
      html: P(
        'Describe the method applied — relief-from-royalty, multi-period excess earnings, with-and-without, or replacement cost less obsolescence — its key assumptions, and the tax amortization benefit where applicable.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: P('State the concluded fair value of the subject asset and the limiting conditions.'),
    },
  ],
};

const TEMPLATE_718: ReportTemplate = {
  version: '718.v2',
  name: 'ASC 718 Stock-Based Compensation Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our determination of the grant-date fair value of the share-based awards of <strong>{{company_name}}</strong> and the related compensation cost recognized under ASC 718, as of {{date}}.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'measurement_objective',
      heading: 'Measurement Objective',
      html:
        P(
          'ASC 718 requires share-based payment awards to employees and nonemployees to be measured at <strong>fair value on the grant date</strong> — the date the employer and employee reach a mutual understanding of the award’s key terms — and recognized as compensation cost over the requisite service period.',
        ) +
        P(
          'For an option award, fair value is estimated with an option-pricing model; for a share award, it is the fair value of the underlying share, adjusted for any post-vesting restrictions that a market participant would price.',
        ),
    },
    {
      key: 'awards',
      heading: 'Awards Measured',
      html: P(
        'Describe the awards covered by this measurement: instrument (options, RSUs, ESPP rights), grant dates, counts, exercise prices, vesting schedules, and any performance or market conditions attached.',
      ),
    },
    {
      key: 'underlying_value',
      heading: 'Fair Value of the Underlying Share',
      html: P(
        'State the fair value of the underlying share at the measurement date and its source. For a private company this is the concluded value of the concurrent 409A valuation; for a public company it is the observed market price. If the measurement relies on a separate valuation report, cite it and its valuation date.',
      ),
    },
    {
      key: 'model_and_assumptions',
      heading: 'Valuation Model & Assumptions',
      html:
        P(
          'State the model applied — Black-Scholes-Merton for plain awards, a lattice or Monte-Carlo simulation where exercise behaviour or market conditions require one — and the basis for each assumption:',
        ) +
        '<ul>' +
        '<li>Expected term — SAB Topic 14 simplified method, historical exercise data, or lattice-derived</li>' +
        '<li>Expected volatility — the issuer’s own history or a guideline peer group, and the period matched to the term</li>' +
        '<li>Risk-free rate — the zero-coupon Treasury (or equivalent) yield matched to the term</li>' +
        '<li>Dividend yield — the expected yield over the term</li>' +
        '</ul>',
    },
    {
      key: 'expense_recognition',
      heading: 'Expense Recognition',
      html: P(
        'Describe the attribution: straight-line or graded over the requisite service period, the forfeiture policy elected (estimated forfeitures or as-incurred), the treatment of performance conditions (recognize when probable) and of market conditions (never reversed for failure to meet the market condition), and any modification accounting in the period.',
      ),
    },
    {
      key: 'schedule',
      heading: 'Compensation Cost Schedule',
      html:
        P('Summarize the measurement per grant and the cost recognized:') +
        '<table><thead><tr><th>Grant</th><th>Awards</th><th>Fair value per award</th><th>Total fair value</th><th>Service period</th></tr></thead><tbody>' +
        '<tr><td>…</td><td>…</td><td>$ …</td><td>$ …</td><td>… years</td></tr>' +
        '</tbody></table>',
    },
    {
      key: 'limiting_conditions',
      heading: 'Assumptions & Limiting Conditions',
      html: P(
        'This report is valid only for the stated purpose and date, and relies on information provided by management, which we have not audited.',
      ),
    },
  ],
};

const TEMPLATE_820: ReportTemplate = {
  version: '820.v2',
  name: 'ASC 820 Fair Value Measurement Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our measurement of the fair value of the investment portfolio of <strong>{{company_name}}</strong> as of {{date}}, in accordance with ASC 820.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'standard_of_value',
      heading: 'Standard of Value',
      html: P(
        'Fair value under ASC 820 is an <strong>exit price</strong>: the price that would be received to sell an asset in an orderly transaction between market participants at the measurement date. The measurement assumes the principal (or most advantageous) market and the highest and best use for nonfinancial assets; it is a market-based measurement, not an entity-specific one.',
      ),
    },
    {
      key: 'hierarchy',
      heading: 'Fair Value Hierarchy',
      html:
        P('Each position is classified by the observability of its significant inputs:') +
        '<ul>' +
        '<li><strong>Level 1</strong> — quoted prices in active markets for identical assets</li>' +
        '<li><strong>Level 2</strong> — other observable inputs: quoted prices for similar assets, recent transactions, observable yields</li>' +
        '<li><strong>Level 3</strong> — significant unobservable inputs: model values calibrated to the entry transaction and adjusted for changes since</li>' +
        '</ul>' +
        P(
          'State the level assigned to each position and the reason for any transfers between levels in the period.',
        ),
    },
    {
      key: 'methodology',
      heading: 'Valuation Methodology',
      html:
        P(
          'Describe the technique applied to each position class — market quotation, recent-round calibration (the backsolve), guideline multiples, discounted cash flows, or NAV as a practical expedient — and why that technique is appropriate for the position.',
        ) +
        P(
          'Where a round-calibrated model is used, state the calibration: the implied assumptions at the entry round, what has changed since, and how the model was rolled forward to the measurement date.',
        ),
    },
    {
      key: 'portfolio_summary',
      heading: 'Portfolio Summary',
      html:
        P('Summarize the marks:') +
        '<table><thead><tr><th>Position</th><th>Method</th><th>Level</th><th>Cost basis</th><th>Fair value</th></tr></thead><tbody>' +
        '<tr><td>…</td><td>…</td><td>…</td><td>$ …</td><td>$ …</td></tr>' +
        '</tbody></table>',
    },
    {
      key: 'unobservable_inputs',
      heading: 'Significant Unobservable Inputs',
      html: P(
        'For Level 3 positions, disclose the significant unobservable inputs — volatility, time to liquidity, multiples, discount rates — the range applied, and the sensitivity of the measurement to reasonable alternative values.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion',
      html: P(
        'State the concluded fair value of the portfolio, the net asset value it implies, and any measurement uncertainty a reader should weigh.',
      ),
    },
    {
      key: 'limiting_conditions',
      heading: 'Assumptions & Limiting Conditions',
      html: P(
        'This report is valid only for the stated purpose and date, and relies on information provided by management, which we have not audited.',
      ),
    },
  ],
};

const TEMPLATE_GIFTS: ReportTemplate = {
  version: 'gifts.v2',
  name: 'Gift & Estate Tax Valuation Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our determination of the fair market value of the interest in <strong>{{company_name}}</strong> described below, as of {{date}}, for federal gift and estate tax purposes.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'standard_of_value',
      heading: 'Standard of Value',
      html:
        P(
          'The standard of value is <strong>fair market value</strong> as defined in Treasury Regulations §20.2031-1(b) and §25.2512-1: the price at which the property would change hands between a willing buyer and a willing seller, neither being under any compulsion to buy or to sell and both having reasonable knowledge of relevant facts.',
        ) +
        P(
          'The analysis follows the factors of Revenue Ruling 59-60 — the nature and history of the business, economic and industry outlook, book value and financial condition, earning and dividend-paying capacity, goodwill, prior sales, and comparable public companies.',
        ),
    },
    {
      key: 'interest_description',
      heading: 'Description of the Interest',
      html: P(
        'Describe the interest transferred: the class of equity, the percentage of the outstanding class and of the whole, the transfer (gift, bequest, generation-skipping transfer, or sale), the transferor and transferee, and the rights and restrictions attaching to the interest under the governing documents.',
      ),
    },
    {
      key: 'company_overview',
      heading: 'Company Overview',
      html: P(
        'Describe the business of {{company_name}}: history, operations, management, financial condition and distribution history.',
      ),
    },
    {
      key: 'valuation_analysis',
      heading: 'Valuation of the Underlying Entity',
      html: P(
        'Describe the approaches applied to value the entity — asset, income, and market — the indications each produced, and the weighting that reached the concluded entity value before interest-level adjustments.',
      ),
    },
    {
      key: 'discounts',
      heading: 'Interest-Level Discounts',
      html:
        P(
          'The interest transferred is a minority, non-marketable interest, and the willing buyer prices those facts:',
        ) +
        '<ul>' +
        '<li><strong>Discount for lack of control</strong> — the interest cannot compel distributions, a sale, or liquidation; state the basis in control-premium and closed-end fund studies and in the entity’s governing documents.</li>' +
        '<li><strong>Discount for lack of marketability</strong> — no ready market exists for the interest; state the basis in restricted-stock and pre-IPO studies or an option-based model, and weigh the Mandelbaum factors: distribution history, holding-period risk, transfer restrictions, and the pool of likely buyers.</li>' +
        '</ul>' +
        P('State each concluded discount and the order of application.'),
    },
    {
      key: 'chapter_14',
      heading: 'Chapter 14 Considerations',
      html: P(
        'Address the special valuation rules of IRC §§2701–2704 where applicable: rights valued at zero under §2701, lapsing rights and restrictions disregarded under §2704, and any buy-sell or option agreement tested under §2703.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: P(
        'State the concluded fair market value of the interest as of {{date}}, showing the bridge from the entity value through the interest’s pro-rata share and the discounts applied.',
      ),
    },
    {
      key: 'adequate_disclosure',
      heading: 'Adequate Disclosure Statement',
      html: P(
        'This report is intended to satisfy the adequate-disclosure requirements of Treasury Regulation §301.6501(c)-1(f)(3): it describes the transferred property, the parties and their relationship, and the method, factors and assumptions used in determining the reported value, and it is prepared by an appraiser holding the qualifications described herein.',
      ),
    },
    {
      key: 'certification',
      heading: 'Appraiser Certification',
      html:
        P('We certify that, to the best of our knowledge and belief:') +
        '<ul>' +
        '<li>The statements of fact in this report are true and correct.</li>' +
        '<li>The analyses, opinions and conclusions are our personal, impartial and unbiased professional analyses.</li>' +
        '<li>We have no present or prospective interest in the property valued and no bias with respect to the parties.</li>' +
        '<li>Our compensation is not contingent on the reporting of a predetermined value or the amount of the value opinion.</li>' +
        '</ul>',
    },
    {
      key: 'limiting_conditions',
      heading: 'Assumptions & Limiting Conditions',
      html: P(
        'This report is valid only for the stated purpose and date, and relies on information provided by management and the transferor, which we have not audited.',
      ),
    },
  ],
};

const TEMPLATE_IFRS2: ReportTemplate = {
  version: 'ifrs2.v2',
  name: 'IFRS 2 Share-Based Payment Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our measurement of the share-based payment arrangements of <strong>{{company_name}}</strong> under IFRS 2, as of {{date}}.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'measurement_principles',
      heading: 'Measurement Principles',
      html:
        P(
          'IFRS 2 measures <strong>equity-settled</strong> awards to employees at the fair value of the equity instruments at <strong>grant date</strong>, not remeasured; <strong>cash-settled</strong> awards are measured at the fair value of the liability and remeasured at each reporting date until settlement.',
        ) +
        P(
          'Vesting conditions other than market conditions are reflected by adjusting the number of awards expected to vest; <strong>market conditions and non-vesting conditions are reflected in the grant-date fair value itself</strong> and never trued up. This is the principal difference a reader coming from ASC 718 should note, together with graded-vesting attribution: IFRS 2 treats each tranche as a separate award.',
        ),
    },
    {
      key: 'awards',
      heading: 'Awards Measured',
      html: P(
        'Describe the arrangements: instruments granted, grant dates, counterparties, exercise prices, vesting conditions (service, performance, market), and settlement (equity or cash).',
      ),
    },
    {
      key: 'model_and_assumptions',
      heading: 'Valuation Model & Assumptions',
      html:
        P(
          'State the model applied — Black-Scholes-Merton, a binomial lattice, or Monte-Carlo simulation where a market condition requires one — and the basis for each input:',
        ) +
        '<ul>' +
        '<li>Share price at grant date and its source</li>' +
        '<li>Expected life, reflecting exercise behaviour and post-vesting restrictions</li>' +
        '<li>Expected volatility and the period it was measured over</li>' +
        '<li>Risk-free rate matched to the expected life</li>' +
        '<li>Expected dividends</li>' +
        '</ul>',
    },
    {
      key: 'expense_recognition',
      heading: 'Expense Recognition',
      html: P(
        'Describe the recognition: the vesting period of each tranche, the estimate of awards expected to vest and how it is revised, the treatment of modifications and cancellations (incremental fair value; acceleration on cancellation), and the liability remeasurement for cash-settled awards.',
      ),
    },
    {
      key: 'schedule',
      heading: 'Measurement Schedule',
      html:
        P('Summarize the measurement per grant:') +
        '<table><thead><tr><th>Grant</th><th>Awards</th><th>Fair value per award</th><th>Total fair value</th><th>Vesting period</th></tr></thead><tbody>' +
        '<tr><td>…</td><td>…</td><td>…</td><td>…</td><td>… years</td></tr>' +
        '</tbody></table>',
    },
    {
      key: 'limiting_conditions',
      heading: 'Assumptions & Limiting Conditions',
      html: P(
        'This report is valid only for the stated purpose and date, and relies on information provided by management, which we have not audited.',
      ),
    },
  ],
};

/**
 * The two measurement kinds. Both had a complete engine, CRUD and ops UI and
 * no deliverable at all — `templateForKind` fell through to the generic
 * skeleton, so a fund NAV engagement produced a report headed "Valuation
 * Report" whose methodology section described nothing in particular and whose
 * body could not name a single holding.
 *
 * Their schedules come from domain/navExhibits.ts rather than from a
 * `calculations` row, so these skeletons refer the reader to the exhibits by
 * what they contain rather than by letter, exactly as the specialty skeletons
 * do.
 */
const TEMPLATE_FUND: ReportTemplate = {
  version: 'fund.v1',
  name: 'Fund Net Asset Value Report (ASC 820)',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our measurement of the fair value of the investment holdings of <strong>{{company_name}}</strong>, and the net asset value they support, as of {{date}}.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'standard_of_value',
      heading: 'Standard of Value',
      html: P(
        'Fair value under ASC 820 is the price that would be received to sell an asset in an orderly transaction between market participants at the measurement date — an <strong>exit price</strong> in the principal or most advantageous market, and not an entry price, a cost basis, or the value of the holding to this fund in particular.',
      ),
    },
    {
      key: 'unit_of_account',
      heading: 'Unit of Account',
      html: P(
        'State what is being measured: each holding is measured as the security actually owned — a specific class, with its own liquidation preference and conversion rights — rather than as a pro-rata share of the portfolio company’s equity. Where the fund holds more than one class in the same company, say whether they are measured together or separately, and why.',
      ),
    },
    {
      key: 'measurement_techniques',
      heading: 'Valuation Techniques',
      html:
        P(
          'Describe the technique applied to each holding and why it is appropriate to that position. The techniques recorded against this portfolio are:',
        ) +
        '<ul>' +
        '<li><strong>Quoted market price</strong> — an unadjusted quoted price in an active market for the identical security.</li>' +
        '<li><strong>Last round price</strong> — the price of the most recent orderly financing in the same security, considered for its recency, its size and whether the investors were market participants.</li>' +
        '<li><strong>Calibrated OPM</strong> — an option-pricing allocation calibrated to a transaction price at the investment date and rolled forward, so that the model reproduces the observed price before it is used to measure a later one.</li>' +
        '<li><strong>Cost</strong> — carried at cost where cost remains the best estimate of fair value, which requires that no calibrating event has occurred since acquisition.</li>' +
        '</ul>' +
        P(
          'The Portfolio Schedule exhibit records which technique was applied to each holding at this measurement date.',
        ),
    },
    {
      key: 'hierarchy',
      heading: 'Fair Value Hierarchy',
      html: P(
        'Explain the level assigned to each measurement and the inputs that drive it. Discuss any transfers between levels since the prior measurement date and what caused them — a holding moving from Level 3 to Level 1 on an IPO, or into Level 3 when the market for its class ceased to be active. The Fair Value Hierarchy exhibit summarizes the portfolio by level.',
      ),
    },
    {
      key: 'significant_inputs',
      heading: 'Significant Unobservable Inputs',
      html: P(
        'For the Level 3 holdings, describe the significant unobservable inputs — volatility, time to exit, discount for lack of marketability, and the calibrated equity value — including the range applied across the portfolio and the sensitivity of the measurement to each. This is the disclosure a reader of the financial statements will look for first.',
      ),
    },
    {
      key: 'nav_conclusion',
      heading: 'Net Asset Value',
      html: P(
        'State the concluded gross asset value, any fund-level liabilities, and the resulting net asset value, together with the unrealized gain or loss against cost. The Net Asset Value exhibit sets out the roll-up.',
      ),
    },
    {
      key: 'lp_economics',
      heading: 'Partnership Economics',
      html: P(
        'Describe how the net asset value above would be distributed under the partnership agreement — return of capital, the preferred return, any general partner catch-up, and the carried interest split — and state whether a clawback would be owed on a hypothetical liquidation at this net asset value. The Limited Partnership Economics exhibit records the terms applied.',
      ),
    },
  ],
};

const TEMPLATE_DEBT: ReportTemplate = {
  version: 'debt.v1',
  name: 'Debt Instrument Valuation Report',
  sections: [
    {
      key: 'introduction',
      heading: 'Introduction',
      html:
        P(
          'This report presents our measurement of the fair value of the debt instrument issued by <strong>{{company_name}}</strong>, as of {{date}}.',
        ) + P('Engagement reference: {{valuation_ref}}. Reporting currency: {{currency}}.'),
    },
    {
      key: 'instrument_terms',
      heading: 'Instrument & Terms',
      html: P(
        'Describe the instrument: its form, principal, coupon and payment frequency, maturity, amortization, seniority and security, and any embedded conversion or prepayment rights. The Instrument Terms exhibit records the terms the instrument was priced on.',
      ),
    },
    {
      key: 'standard_of_value',
      heading: 'Standard of Value',
      html: P(
        'Fair value under ASC 820 is an exit price between market participants at the measurement date. For a debt instrument this is the price a market participant would pay for the issuer’s contractual obligation given its credit quality and the yields available on comparable credits — not the carrying amount, and not the amount recoverable on enforcement.',
      ),
    },
    {
      key: 'credit_assessment',
      heading: 'Credit Assessment',
      html: P(
        'Set out the assessment of the issuer’s credit: the rating or rating equivalent applied, the basis for it, the instrument’s position in the capital structure, and any security or covenants that alter expected recovery. Explain how this maps to the credit spread applied below.',
      ),
    },
    {
      key: 'discount_rate',
      heading: 'Discount Rate',
      html: P(
        'Build up the yield at which the contractual cash flows are discounted: the benchmark yield at the matching tenor, the credit spread for the assessed rating and seniority, and any adjustment for illiquidity or instrument-specific features. The Credit Terms & Discount Rate exhibit records the components applied.',
      ),
    },
    {
      key: 'methodology',
      heading: 'Valuation Methodology',
      html:
        P('Describe the measurement applied, which depends on what the instrument is:') +
        '<ul>' +
        '<li><strong>Straight debt</strong> — the contractual interest and principal payments discounted at the all-in yield, stated as a dirty price with accrued interest identified separately.</li>' +
        '<li><strong>Convertible instruments</strong> — the straight-debt value together with the value of the conversion right, so that the measurement is never below conversion parity.</li>' +
        '<li><strong>SAFEs and similar</strong> — measured on the conversion terms that would apply at the next priced round, stating whether the valuation cap or the discount governs.</li>' +
        '</ul>' +
        P(
          'The Contractual Cash Flows exhibit sets out the payments discounted, and the Valuation Result exhibit the measures produced.',
        ),
    },
    {
      key: 'sensitivity',
      heading: 'Interest-Rate Sensitivity',
      html: P(
        'For an instrument measured by discounting, state its duration and convexity and what they imply for the measurement under a parallel shift in yields. Where the instrument carries an embedded option, note that duration alone does not describe its behaviour.',
      ),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: P(
        'State the concluded fair value of the instrument at the measurement date, identifying accrued interest separately where the price is quoted clean, and note any premium or discount to par.',
      ),
    },
  ],
};

/**
 * The sections every valuation report closes with, whatever it values.
 *
 * TEMPLATE_409A has carried assumptions, a certification, an analyst
 * qualifications block and an exhibit index since v54. None of the other
 * twelve skeletons did — a QSBS opinion, an ESOP report and both HMRC packs
 * went out with a conclusion and nothing after it. That is not a stylistic
 * gap. A signed valuation opinion with no certification is a document nobody
 * has put their name to: SSVS-1 requires the appraiser to state the report's
 * independence and the non-contingency of the fee, and an auditor or a
 * revenue authority reading a report that omits it has to ask for it, which
 * is the same delay as not having issued the report.
 *
 * Defined once and appended rather than pasted into each skeleton, so a new
 * report type cannot be added without them. `withClosingSections` skips any
 * key the template already declares, which is how 409A keeps its §409A-
 * specific certification and GIFTS keeps its Chapter 14 wording — the shared
 * block is a floor, not an override.
 */
const CLOSING_SECTIONS: TemplateSectionDef[] = [
  {
    key: 'limiting_conditions',
    heading: 'Assumptions & Limiting Conditions',
    html:
      P(
        'This report is valid only for the purpose and as of the date stated, and may not be used for any other purpose or by any party other than those named in the engagement.',
      ) +
      '<ul>' +
      '<li>We have relied on financial and operating information supplied by management, which we have not audited, reviewed or compiled, and we express no opinion on it.</li>' +
      '<li>We assume no responsibility for the legal description of, or title to, any asset, and have assumed valid title and no undisclosed encumbrance.</li>' +
      '<li>Events occurring after the valuation date may materially affect the conclusion; we have no obligation to update this report for them.</li>' +
      '<li>Neither this report nor any part of it may be published or referred to publicly without our prior written consent.</li>' +
      '</ul>',
  },
  {
    key: 'certification',
    heading: 'Appraiser Certification',
    html:
      P('We certify that, to the best of our knowledge and belief:') +
      '<ul>' +
      '<li>The statements of fact in this report are true and correct.</li>' +
      '<li>The analyses, opinions and conclusions are limited only by the assumptions and limiting conditions stated, and are our personal, impartial and unbiased professional analyses.</li>' +
      '<li>We have no present or prospective interest in {{company_name}} and no personal interest with respect to the parties involved.</li>' +
      '<li>Our compensation is not contingent on the reporting of a predetermined value, on the amount of the value opinion, or on the occurrence of any subsequent event.</li>' +
      '<li>No one provided significant professional assistance to the persons signing this report except as disclosed herein.</li>' +
      '</ul>',
  },
  {
    key: 'qualifications',
    heading: 'Qualifications of the Valuation Analyst',
    html:
      P(
        'Set out the professional qualifications of the analyst or analysts responsible for this valuation, as required by SSVS-1:',
      ) +
      '<ul>' +
      '<li>Name, role and firm</li>' +
      '<li>Professional credentials held (ABV, ASA, CFA, CVA or equivalent)</li>' +
      '<li>Relevant experience in valuations of this type</li>' +
      '</ul>',
  },
  {
    key: 'exhibit_index',
    heading: 'Index of Exhibits',
    html: P(
      // Deliberately not enumerated: unlike the 409A skeleton, which knows it
      // gets Exhibits A–H, the specialty exhibits vary by engine and by what
      // the run produced (domain/specialtyExhibits.ts). A hardcoded list that
      // named a schedule the report does not contain would be worse than none.
      'The exhibits that follow are generated from the valuation model supporting this report. Each is produced from the same calculation as the conclusion above and cannot be edited apart from it.',
    ),
  },
];

/**
 * A template plus whichever closing sections it does not already declare.
 *
 * Order is the block's own, appended after the authored body — a certification
 * belongs at the end of a report by convention, and any template wanting a
 * different position simply declares that section itself.
 */
function withClosingSections(template: ReportTemplate): ReportTemplate {
  const declared = new Set(template.sections.map((s) => s.key));
  const missing = CLOSING_SECTIONS.filter((s) => !declared.has(s.key));
  if (missing.length === 0) return template;
  return { ...template, sections: [...template.sections, ...missing] };
}

/**
 * Every skeleton, closed. Nothing else in the module may reference the raw
 * TEMPLATE_* constants — going through this map is what guarantees a report
 * type cannot ship without a certification page.
 */
const TEMPLATE_BY_KIND: Partial<Record<ValuationKind, ReportTemplate>> = Object.fromEntries(
  Object.entries({
    '409a': TEMPLATE_409A,
    qsbs: TEMPLATE_QSBS,
    ppa: TEMPLATE_PPA,
    goodwill: TEMPLATE_IMPAIRMENT,
    esop: TEMPLATE_ESOP,
    fmv: TEMPLATE_SMB,
    emi: TEMPLATE_EMI,
    csop: TEMPLATE_CSOP,
    ip: TEMPLATE_IP,
    '718': TEMPLATE_718,
    '820': TEMPLATE_820,
    gifts: TEMPLATE_GIFTS,
    ifrs2: TEMPLATE_IFRS2,
    fund: TEMPLATE_FUND,
    debt: TEMPLATE_DEBT,
  }).map(([kind, template]) => [kind, withClosingSections(template)]),
) as Partial<Record<ValuationKind, ReportTemplate>>;

const CLOSED_GENERIC = withClosingSections(TEMPLATE_GENERIC);

export const REPORT_TEMPLATES: ReadonlyMap<string, ReportTemplate> = new Map([
  [CLOSED_GENERIC.version, CLOSED_GENERIC],
  ...Object.values(TEMPLATE_BY_KIND).map((t): [string, ReportTemplate] => [t.version, t]),
]);

export function templateForKind(kind: ValuationKind): ReportTemplate {
  return TEMPLATE_BY_KIND[kind] ?? CLOSED_GENERIC;
}

/**
 * {{placeholder}} substitution; unknown placeholders survive verbatim.
 *
 * `Object.hasOwn` rather than a plain lookup — see `renderTemplate` in
 * `domain/communications.ts`, which carries this function and this note. `\w+`
 * matches the names on `Object.prototype`, so `{{constructor}}` in a report
 * template rendered as `function Object() { [native code] }`.
 */
export function fillTemplateVars(text: string, vars: object): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
    if (!Object.hasOwn(vars, key)) return m;
    const v = (vars as unknown as Record<string, unknown>)[key];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * Instantiates a template into editable content with placeholders resolved.
 *
 * The filled body is sanitized, exactly as `contentFromManagedTemplate` does
 * with a DB template. The skeletons here are code-authored and need nothing,
 * but the *variables* substituted into them are not: `company_name` is a
 * free-text field the client types (`z.string().min(1).max(300)`), and it
 * lands inside `<strong>{{company_name}}</strong>` in five sections of the
 * 409A skeleton. Filling it raw stored whatever was typed as report HTML on
 * first ops access, and the auditor portal renders stored section HTML
 * directly — so a company named `<img src=x onerror=…>` was script execution
 * in the browser of the external auditor reviewing the engagement.
 *
 * Only the body is sanitized. Headings render as text everywhere they are
 * shown (React escapes them, and the PDF writer draws them as a string), so
 * passing them through the HTML whitelist would only mangle an ampersand.
 */
export function instantiateTemplate(template: ReportTemplate, vars: ReportTemplateVars): ReportContent {
  const fill = (text: string) => fillTemplateVars(text, vars);
  return {
    title: `${template.name} — ${vars.company_name}`,
    sections: template.sections.map((s) => ({
      key: s.key,
      heading: fill(s.heading),
      html: sanitizeHtml(fill(s.html)),
    })),
  };
}

const H1_OPEN = /<h1[^>]*>/gi;
const H1_CLOSE = /<\/h1\s*>/gi;

/**
 * `split(/<h1[^>]*>([\s\S]*?)<\/h1\s*>/gi)` — the alternating
 * `[before, heading, body, heading, body, …]` that shape produces, scanned
 * forward so an unclosed `<h1>` costs one pass rather than one per candidate.
 *
 * A template body is ops-authored and capped at a megabyte, so this is not the
 * open door `sanitizeHtml` was. It is the same collapse though, and worse
 * placed: the cost is paid on every report generated from the template, by
 * whoever generates it, not once by whoever saved it.
 */
function splitOnH1(html: string): string[] {
  const parts: string[] = [];
  let at = 0;
  H1_OPEN.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = H1_OPEN.exec(html)) !== null) {
    H1_CLOSE.lastIndex = open.index + open[0].length;
    const close = H1_CLOSE.exec(html);
    if (close === null) break; // no `</h1>` remains for this one or for any after it
    parts.push(html.slice(at, open.index), html.slice(open.index + open[0].length, close.index));
    at = close.index + close[0].length;
    H1_OPEN.lastIndex = at;
  }
  parts.push(html.slice(at));
  return parts;
}

/**
 * Managed-template merge (gap 6): a DB template's body becomes the report
 * content. Top-level <h1>Heading</h1> markers split the body into sections;
 * a body without any <h1> becomes a single "Report" section. Placeholders
 * resolve with the same vars as the built-in skeletons; everything is
 * sanitized to the editor whitelist.
 */
export function contentFromManagedTemplate(
  template: { name: string; body: string },
  vars: ReportTemplateVars,
): ReportContent {
  const filled = fillTemplateVars(template.body, vars);
  const parts = splitOnH1(filled);
  const sections: ReportSection[] = [];
  // parts = [before-first-h1, heading1, body1, heading2, body2, …]
  const preamble = parts.length > 1 ? parts[0]?.trim() : '';
  if (preamble) sections.push({ key: 'section-0', heading: 'Introduction', html: sanitizeHtml(preamble) });
  for (let i = 1; i < parts.length; i += 2) {
    const heading =
      sanitizeHtml(parts[i] ?? '')
        .replace(/<[^>]+>/g, '')
        .trim() || `Section ${sections.length + 1}`;
    sections.push({
      key: `section-${sections.length}`,
      heading,
      html: sanitizeHtml((parts[i + 1] ?? '').trim()),
    });
  }
  if (sections.length === 0) sections.push({ key: 'body', heading: 'Report', html: sanitizeHtml(filled) });
  return { title: `${template.name} — ${vars.company_name}`, sections };
}
