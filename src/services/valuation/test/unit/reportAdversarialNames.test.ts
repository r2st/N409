import { describe, expect, it } from 'vitest';
import { renderReportPdf } from '@n409/report/pdf';
import { contentDisposition } from '../../src/routes/documents.js';
import {
  contentFromManagedTemplate,
  escapeTemplateVars,
  fillTemplateVars,
  instantiateTemplate,
  sanitizeHtml,
  templateForKind,
  visibleSections,
} from '../../src/domain/report.js';
import { fillFigures, reportFigures } from '../../src/domain/reportFigures.js';
import type { CalculationRow } from '../../src/repos/calculations.js';
import { extractText as pdfText } from '../../../report/test/support/pdfText.js';

/**
 * A company name that is hostile to the pipe it travels down.
 *
 * `company_name` is `z.string().min(1).max(300)` and nothing else, and it is
 * the most travelled string in the platform: it is substituted into the report
 * body at draft time, drawn on the cover and in every running head, written
 * into the PDF's `/Info` dictionary, and used to name the file the client
 * downloads. Four different escapes on four different rules, and each one is a
 * place the name can be lost.
 *
 * One of them was losing it. `instantiateTemplate` filled the raw value into
 * `<strong>{{company_name}}</strong>` and sanitized afterwards, so the payload
 * in `<img src=x onerror=…>` never reached the auditor portal — it was deleted,
 * and so was everything else between a `<` and its `>`. `A & B <Holdings> Ltd`
 * was drafted, stored and delivered as `A & B  Ltd`, in five sections of the
 * 409A skeleton, in the document whose first job is to say which company it
 * values. Nothing failed and nothing logged; a name is one of the few fields in
 * a report that no reviewer re-derives.
 *
 * The rule is now one rule, stated in `escapeTemplateVars` and applied wherever
 * a value crosses into markup: escape, never sanitize, and never escape a value
 * bound for a field that is drawn as text. What follows walks the names that
 * break each spelling of it all the way to the rendered page.
 */

const HOSTILE_NAMES = [
  'A & B <Holdings> Ltd',
  "O'Brien & Sons",
  '"Quoted" Corp',
  'Q < R Capital',
  'Ünïcödé GmbH & Co. KG',
  '<script>alert(1)</script> Corp',
  '<img src=x onerror="alert(1)">Acme',
] as const;

const vars = (company_name: string) => ({
  company_name,
  kind: '409a' as const,
  valuation_ref: 'VAL-2026-0001',
  date: '2026-07-06',
  currency: 'USD',
});

/** What the PDF renderer's `decodeEntities` will turn a stored body back into. */
const decodeEntities = (html: string): string =>
  html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

describe('a company name on its way into the stored report body', () => {
  it.each(HOSTILE_NAMES)('keeps %j whole', (name) => {
    const content = instantiateTemplate(templateForKind('409a'), vars(name));
    const carrying = content.sections.filter((s) => decodeEntities(s.html).includes(name));
    expect(carrying.length, 'sections naming the company').toBeGreaterThan(0);
  });

  it('escapes rather than executes, in every section that names the company', () => {
    const content = instantiateTemplate(templateForKind('409a'), vars('<img src=x onerror="alert(1)">Acme'));
    for (const section of content.sections) {
      // No live tag the whitelist would not have written…
      expect(section.html).not.toMatch(/<img|<script/i);
      // …and the body is still at the sanitizer's fixed point, so saving it
      // back does not change it a second time.
      expect(sanitizeHtml(section.html)).toBe(section.html);
    }
  });

  it('does not spell the name out as entities in a heading', () => {
    // A heading is drawn as a string by the PDF writer and repeated in the
    // table of contents, so it takes the raw value while the body takes the
    // escaped one.
    const content = instantiateTemplate(templateForKind('409a'), vars('A & B <Holdings> Ltd'));
    for (const section of content.sections) expect(section.heading).not.toContain('&amp;');
    expect(content.title).toBe('IRC 409A Valuation Report — A & B <Holdings> Ltd');
  });

  it('keeps a managed template whole too, and does not let a name open a chapter', () => {
    const body = '<h1>Overview of {{company_name}}</h1><p>Prepared for {{company_name}}.</p>';
    const content = contentFromManagedTemplate({ name: 'Managed', body }, vars('A & B <Holdings> Ltd'));
    expect(content.sections).toHaveLength(1);
    expect(content.sections[0]!.heading).toBe('Overview of A & B <Holdings> Ltd');
    expect(decodeEntities(content.sections[0]!.html)).toContain('Prepared for A & B <Holdings> Ltd.');

    // The split happens on the template, so a name is text wherever it lands
    // rather than a structural marker. Before, this was two chapters.
    const injected = contentFromManagedTemplate(
      { name: 'Managed', body: '<h1>Head</h1><p>For {{company_name}}.</p>' },
      vars('Acme</h1><h1>Chapter Two'),
    );
    expect(injected.sections).toHaveLength(1);
    expect(injected.sections[0]!.heading).toBe('Head');
  });

  it('leaves an unknown placeholder standing rather than resolving it to nothing', () => {
    expect(escapeTemplateVars({ a: null, b: undefined, c: 'x&y' })).toEqual({
      a: null,
      b: undefined,
      c: 'x&amp;y',
    });
    expect(
      fillTemplateVars('{{a}} {{b}} {{c}}', escapeTemplateVars({ a: null, b: undefined, c: 'x&y' })),
    ).toBe('{{a}} {{b}} x&amp;y');
  });
});

describe('a company name on its way onto the page', () => {
  const calculation = (): CalculationRow =>
    ({
      id: 'calc-1',
      status: 'succeeded',
      results: {
        fmv_per_share: 1.4947,
        equity_value: 42_000_000,
        discounts: { dloc: 0.1, dlom: 0.3 },
        market_movement: { factor: 0.899, index_name: 'S&P Software' },
      },
    }) as unknown as CalculationRow;

  it.each(HOSTILE_NAMES)('renders %j into a PDF that reads it back', async (name) => {
    const content = instantiateTemplate(templateForKind('409a'), vars(name));
    const filled = fillFigures(content, reportFigures(calculation(), 'USD'));
    const pdf = await renderReportPdf(
      {
        title: filled.title,
        company_name: name,
        meta: [{ label: 'Reference', value: 'VAL-2026-0001' }],
        sections: visibleSections(filled).map((s) => ({ heading: s.heading, html: s.html })),
      },
      { compress: false },
    );
    const text = pdfText(pdf).replace(/­/g, '');
    // On the cover, in the running head, and in the body — the same company.
    expect(text, name).toContain(name);
    expect(text, name).not.toContain('&amp;');
    expect(text, name).not.toContain('&lt;');
  });

  it('names the benchmark the same way in a heading and in a body', async () => {
    const filled = fillFigures(
      {
        title: 'T',
        sections: [
          {
            key: 'k',
            heading: 'Benchmark: {{market_movement_index}}',
            html: '<p>Adjusted against {{market_movement_index}}.</p>',
          },
        ],
      },
      reportFigures(calculation(), 'USD'),
    );
    const pdf = await renderReportPdf(
      {
        title: 'T',
        company_name: 'Acme',
        meta: [],
        sections: filled.sections.map((s) => ({ heading: s.heading, html: s.html })),
      },
      { compress: false },
    );
    const text = pdfText(pdf);
    expect(text).toContain('Benchmark: S&P Software');
    expect(text).toContain('Adjusted against S&P Software.');
    expect(text).not.toContain('S&amp;P');
  });
});

describe('a company name on its way into the download filename', () => {
  // `routes/reports.ts` builds `${company_name}_${kind}_v${n}.pdf` and hands it
  // to `contentDisposition`, which is the only thing between a typed name and a
  // response header.
  const filenameFor = (company: string) => contentDisposition(`${company}_409a_v3.pdf`, 'inline');

  it.each(HOSTILE_NAMES)('emits a header %j cannot break out of', (name) => {
    const header = filenameFor(name);
    const ascii = /filename="([^"]*)"/.exec(header);
    expect(ascii, header).not.toBeNull();
    // The quoted-string closes where it was opened: no bare quote and no
    // trailing backslash that would escape the closing one.
    expect(ascii![1]).not.toMatch(/["\\]/);
    expect(header).toMatch(/filename\*=UTF-8''/);
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('keeps enough of the name to recognise the file', () => {
    expect(filenameFor("O'Brien & Sons")).toContain("O'Brien & Sons_409a_v3.pdf");
  });
});
