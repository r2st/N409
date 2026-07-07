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
 * Reduces arbitrary editor HTML to the whitelist: script/style bodies are
 * removed outright, allowed tags are kept with all attributes stripped —
 * except <a>, which keeps a validated http(s)/mailto href (gap 9) —
 * anything else is dropped (its text content survives).
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
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

/** The 409A deliverable skeleton, modelled on the production 409a.v53 layout. */
const TEMPLATE_409A: ReportTemplate = {
  version: '409a.v53',
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
        P('Describe the approaches considered — asset, income, market, and OPM backsolve — and their weights.') +
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
      key: 'limiting_conditions',
      heading: 'Assumptions & Limiting Conditions',
      html: P(
        'This report is valid only for the stated purpose and date, and relies on information provided by management, which we have not audited.',
      ),
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
    { key: 'company_overview', heading: 'Company Overview', html: P('Describe the business of {{company_name}}.') },
    {
      key: 'analysis',
      heading: 'Valuation Analysis',
      html: P('Describe the methodology, inputs and analysis supporting the conclusion.'),
    },
    { key: 'conclusion', heading: 'Conclusion of Value', html: P('State the concluded value and its basis.') },
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

/** Instantiates a template into editable content with placeholders resolved. */
export function instantiateTemplate(template: ReportTemplate, vars: ReportTemplateVars): ReportContent {
  const fill = (text: string) => fillTemplateVars(text, vars);
  return {
    title: `${template.name} — ${vars.company_name}`,
    sections: template.sections.map((s) => ({ key: s.key, heading: fill(s.heading), html: fill(s.html) })),
  };
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
  const parts = filled.split(/<h1[^>]*>([\s\S]*?)<\/h1\s*>/gi);
  const sections: ReportSection[] = [];
  // parts = [before-first-h1, heading1, body1, heading2, body2, …]
  const preamble = parts.length > 1 ? parts[0]?.trim() : '';
  if (preamble) sections.push({ key: 'section-0', heading: 'Introduction', html: sanitizeHtml(preamble) });
  for (let i = 1; i < parts.length; i += 2) {
    const heading = sanitizeHtml(parts[i] ?? '').replace(/<[^>]+>/g, '').trim() || `Section ${sections.length + 1}`;
    sections.push({
      key: `section-${sections.length}`,
      heading,
      html: sanitizeHtml((parts[i + 1] ?? '').trim()),
    });
  }
  if (sections.length === 0) sections.push({ key: 'body', heading: 'Report', html: sanitizeHtml(filled) });
  return { title: `${template.name} — ${vars.company_name}`, sections };
}
