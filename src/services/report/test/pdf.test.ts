import { describe, expect, it } from 'vitest';
import {
  TOC_MIN_SECTIONS,
  decodeEntities,
  htmlToBlocks,
  renderReportPdf,
  type ReportPdfInput,
} from '../src/pdf.js';

const SAMPLE: ReportPdfInput = {
  title: 'IRC 409A Valuation Report',
  company_name: 'Acme Robotics, Inc.',
  meta: [
    { label: 'Engagement', value: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
    { label: 'Template', value: '409a.v53' },
  ],
  sections: [
    {
      heading: 'Introduction',
      html: '<p>This report presents the <strong>fair market value</strong> of <em>common stock</em>.</p>',
    },
    {
      heading: 'Methodology',
      html: '<h2>Approaches</h2><ul><li>Income approach</li><li>Market approach</li></ul><ol><li>First</li><li>Second</li></ol>',
    },
    {
      heading: 'Financials',
      html: '<table><thead><tr><th>Metric</th><th>FY-1</th></tr></thead><tbody><tr><td>Revenue</td><td>4,200,000</td></tr></tbody></table>',
    },
  ],
};

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;&nbsp;f')).toBe(
      'a & b <c> "d" \'e\' A f',
    );
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('&unknown; &fake123;')).toBe('&unknown; &fake123;');
  });
});

describe('htmlToBlocks', () => {
  it('parses paragraphs with inline styling runs', () => {
    const blocks = htmlToBlocks('<p>plain <strong>bold</strong> and <em>italic</em> and <u>under</u></p>');
    expect(blocks).toHaveLength(1);
    const p = blocks[0]!;
    expect(p.type).toBe('paragraph');
    if (p.type !== 'paragraph') return;
    expect(p.runs.map((r) => [r.text, r.bold, r.italic, r.underline])).toEqual([
      ['plain ', false, false, false],
      ['bold', true, false, false],
      [' and ', false, false, false],
      ['italic', false, true, false],
      [' and ', false, false, false],
      ['under', false, false, true],
    ]);
  });

  it('parses headings with levels', () => {
    const blocks = htmlToBlocks('<h2>Section</h2><h3>Sub</h3>');
    expect(blocks).toEqual([
      { type: 'heading', level: 2, runs: [{ text: 'Section', bold: false, italic: false, underline: false }] },
      { type: 'heading', level: 3, runs: [{ text: 'Sub', bold: false, italic: false, underline: false }] },
    ]);
  });

  it('parses ordered and unordered lists', () => {
    const blocks = htmlToBlocks('<ul><li>a</li><li>b</li></ul><ol><li>one</li></ol>');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: false });
    expect(blocks[1]).toMatchObject({ type: 'list', ordered: true });
    const ul = blocks[0]!;
    if (ul.type === 'list') {
      expect(ul.items.map((runs) => runs.map((r) => r.text).join(''))).toEqual(['a', 'b']);
    }
  });

  it('parses tables with header detection', () => {
    const blocks = htmlToBlocks(
      '<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    expect(blocks).toEqual([
      { type: 'table', rows: [['H1', 'H2'], ['a', 'b']], headerRows: 1 },
    ]);
  });

  it('treats bare text as a paragraph and survives mis-nesting', () => {
    expect(htmlToBlocks('loose text')).toEqual([
      { type: 'paragraph', runs: [{ text: 'loose text', bold: false, italic: false, underline: false }] },
    ]);
    // unclosed tags never throw
    expect(() => htmlToBlocks('<ul><li>x<table><tr><td>y')).not.toThrow();
  });

  it('returns no blocks for empty html', () => {
    expect(htmlToBlocks('')).toEqual([]);
    expect(htmlToBlocks('   ')).toEqual([]);
  });
});

/** pdfkit writes text runs as hex strings (WinAnsi bytes) — decode them all. */
function extractText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  // kerning may split one logical string across hex tokens — join bare
  return Array.from(raw.matchAll(/<([0-9a-fA-F]+)>/g))
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
}

describe('renderReportPdf', () => {
  it('produces a valid PDF document', async () => {
    const pdf = await renderReportPdf(SAMPLE);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(pdf.length - 32).toString()).toContain('%%EOF');
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it('embeds section text (verified with compression off)', async () => {
    const pdf = await renderReportPdf(SAMPLE, { compress: false });
    const text = extractText(pdf);
    for (const expected of [
      'IRC 409A Valuation Report',
      'Acme Robotics, Inc.',
      '1. Introduction',
      'fair market value',
      'Income approach',
      'Revenue',
      '409a.v53',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('paginates long reports and stamps page numbers', async () => {
    const long: ReportPdfInput = {
      ...SAMPLE,
      sections: Array.from({ length: 12 }, (_, i) => ({
        heading: `Section ${i + 1}`,
        html: `<p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(60)}</p>`,
      })),
    };
    const pdf = await renderReportPdf(long, { compress: false });
    expect(extractText(pdf)).toContain('Page 1 of');
    // more than one page object
    expect((pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length).toBeGreaterThan(2);
  });
});

describe('table of contents', () => {
  const withSections = (count: number): ReportPdfInput => ({
    ...SAMPLE,
    sections: Array.from({ length: count }, (_, i) => ({
      heading: `Chapter ${i + 1}`,
      html: `<p>${'Body text. '.repeat(40)}</p>`,
    })),
  });

  it('is omitted for a report too short to need one', async () => {
    const short = withSections(TOC_MIN_SECTIONS - 1);
    const text = extractText(await renderReportPdf(short, { compress: false }));
    expect(text).not.toContain('Table of Contents');
  });

  it('is included once the report is long enough', async () => {
    const text = extractText(
      await renderReportPdf(withSections(TOC_MIN_SECTIONS), { compress: false }),
    );
    expect(text).toContain('Table of Contents');
    expect(text).toContain('1. Chapter 1');
    expect(text).toContain(`${TOC_MIN_SECTIONS}. Chapter ${TOC_MIN_SECTIONS}`);
  });

  it('can be forced on for a short report', async () => {
    const text = extractText(
      await renderReportPdf({ ...withSections(2), include_toc: true }, { compress: false }),
    );
    expect(text).toContain('Table of Contents');
  });

  it('can be forced off for a long report', async () => {
    const text = extractText(
      await renderReportPdf({ ...withSections(10), include_toc: false }, { compress: false }),
    );
    expect(text).not.toContain('Table of Contents');
  });

  it('shifts the body one page later to make room for it', async () => {
    const pageCount = (pdf: Buffer) =>
      (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
    const input = withSections(6);
    const without = await renderReportPdf({ ...input, include_toc: false }, { compress: false });
    const withToc = await renderReportPdf({ ...input, include_toc: true }, { compress: false });
    expect(pageCount(withToc)).toBe(pageCount(without) + 1);
  });

  it('is skipped entirely when there are no sections', async () => {
    const text = extractText(
      await renderReportPdf({ ...SAMPLE, sections: [], include_toc: true }, { compress: false }),
    );
    expect(text).not.toContain('Table of Contents');
    expect(text).toContain('Page 1 of 1');
  });

  it('numbers the last entry with a page that exists', async () => {
    const input = withSections(8);
    const pdf = await renderReportPdf(input, { compress: false });
    const text = extractText(pdf);
    const total = Number(/Page 1 of (\d+)/.exec(text)![1]);
    // Every section starts on a real page: cover + toc = 2, body fills the rest.
    expect(total).toBeGreaterThanOrEqual(3);
    // The last TOC entry cannot point past the end of the document.
    const entry = new RegExp(`8\\. Chapter 8[.\\s]*?(\\d+)`).exec(text);
    expect(entry).not.toBeNull();
    expect(Number(entry![1])).toBeLessThanOrEqual(total);
  });
});

describe('footer', () => {
  it('stamps a confidentiality marker by default', async () => {
    const text = extractText(await renderReportPdf(SAMPLE, { compress: false }));
    expect(text).toContain('Confidential');
    expect(text).toContain('Page 1 of');
  });

  it('accepts a custom marker', async () => {
    const text = extractText(
      await renderReportPdf(
        { ...SAMPLE, confidentiality: 'Privileged & Confidential' },
        { compress: false },
      ),
    );
    expect(text).toContain('Privileged & Confidential');
  });

  it('omits the marker when explicitly set to null', async () => {
    const text = extractText(
      await renderReportPdf({ ...SAMPLE, confidentiality: null }, { compress: false }),
    );
    expect(text).not.toContain('Confidential');
    expect(text).toContain('Page 1 of');
  });
});
