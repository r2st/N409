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

/**
 * Reduces arbitrary editor HTML to the whitelist: script/style bodies are
 * removed outright, allowed tags are kept with all attributes stripped —
 * except <a>, which keeps a validated http(s)/mailto href (gap 9) —
 * anything else is dropped (its text content survives).
 */
export function sanitizeHtml(html: string): string {
  return stripComments(stripRawText(html))
    .replace(
      /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
      (_m, close: string, name: string, attrs: string) => {
        const tag = name.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) return '';
        if (tag === 'br') return '<br>';
        if (tag === 'a' && !close) {
          const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
          const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
          if (/^(https?:\/\/|mailto:)/i.test(url)) {
            return `<a href="${url.replace(/"/g, '&quot;')}">`;
          }
          return '<a>';
        }
        return `<${close}${tag}>`;
      },
    )
    .replace(/<[^a-zA-Z/!][^>]*>/g, '');
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
 */
const TEMPLATE_409A: ReportTemplate = {
  version: '409a.v54',
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
      key: 'allocation',
      heading: 'Allocation of Equity Value',
      html: P(
        'Describe the option-pricing model allocation across share classes, including term, volatility and risk-free-rate inputs.',
      ),
    },
    {
      key: 'dlom',
      heading: 'Discount for Lack of Marketability',
      html: P('Describe the DLOM analysis (Chaffee / Finnerty / qualitative) and the concluded discount.'),
    },
    {
      key: 'conclusion',
      heading: 'Conclusion of Value',
      html: P(
        'Based on the analyses described herein, the fair market value of one share of common stock of {{company_name}} as of {{date}} is $ … per share.',
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
        '<table><thead><tr><th>Assumption</th><th>Input</th></tr></thead><tbody>' +
        '<tr><td>Underlying fair value (409A)</td><td>$ … per share</td></tr>' +
        '<tr><td>Exercise price</td><td>$ …</td></tr>' +
        '<tr><td>Expected term</td><td>… years</td></tr>' +
        '<tr><td>Expected volatility</td><td>… %</td></tr>' +
        '<tr><td>Risk-free rate</td><td>… %</td></tr>' +
        '<tr><td>Dividend yield</td><td>… %</td></tr>' +
        '<tr><td>Grant-date fair value per option</td><td>$ …</td></tr>' +
        '<tr><td>Total compensation cost</td><td>$ …</td></tr>' +
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
  ],
};

/** Fallback skeleton for the other 12 valuation kinds. */
const TEMPLATE_GENERIC: ReportTemplate = {
  version: 'generic.v1',
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

export const REPORT_TEMPLATES: ReadonlyMap<string, ReportTemplate> = new Map([
  [TEMPLATE_409A.version, TEMPLATE_409A],
  [TEMPLATE_GENERIC.version, TEMPLATE_GENERIC],
]);

export function templateForKind(kind: ValuationKind): ReportTemplate {
  return kind === '409a' ? TEMPLATE_409A : TEMPLATE_GENERIC;
}

/** {{placeholder}} substitution; unknown placeholders survive verbatim. */
export function fillTemplateVars(text: string, vars: ReportTemplateVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
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
