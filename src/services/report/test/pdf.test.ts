import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToBlocks, renderReportPdf, type ReportPdfInput } from '../src/pdf.js';

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
