import { describe, expect, it } from 'vitest';
import {
  TOC_MIN_SECTIONS,
  chartHeight,
  decodeEntities,
  formatChartValue,
  htmlToBlocks,
  renderReportPdf,
  waterfallColumns,
  type ReportPdfInput,
  type ReportPdfSummary,
} from '../src/pdf.js';
import { extractText, pageCount } from './support/pdfText.js';

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

  // `String.fromCodePoint` throws RangeError above U+10FFFF, and the only guard
  // was `Number.isNaN` — which `&#99999999;` passes, being a perfectly good
  // number. The throw escaped decodeEntities, htmlToBlocks and renderReportPdf
  // in turn, so eight digits anywhere in any section returned a 500 instead of
  // a PDF.
  it('leaves an out-of-range numeric reference as text instead of throwing', () => {
    expect(decodeEntities('Valued at &#99999999; per share')).toBe('Valued at &#99999999; per share');
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');
  });

  it('still decodes the highest reference that is a real code point', () => {
    // U+10FFFF is the last one; one past it is the first that must be left alone.
    expect(decodeEntities('&#x10FFFF;')).toBe(String.fromCodePoint(0x10ffff));
    expect(decodeEntities('&#1114111;')).toBe(String.fromCodePoint(0x10ffff));
  });

  it('survives a reference far too long to be a code point', () => {
    // parseInt returns Infinity-free but huge values here; some overflow to a
    // float, which fromCodePoint also refuses.
    const huge = `&#${'9'.repeat(400)};`;
    expect(() => decodeEntities(huge)).not.toThrow();
    expect(decodeEntities(huge)).toBe(huge);
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
      {
        type: 'heading',
        level: 2,
        runs: [{ text: 'Section', bold: false, italic: false, underline: false }],
      },
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
      {
        type: 'table',
        rows: [
          ['H1', 'H2'],
          ['a', 'b'],
        ],
        headerRows: 1,
      },
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
    const text = extractText(await renderReportPdf(withSections(TOC_MIN_SECTIONS), { compress: false }));
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
      await renderReportPdf({ ...SAMPLE, confidentiality: 'Privileged & Confidential' }, { compress: false }),
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

// ── executive summary & charts ────────────────────────────────────────────────

const SUMMARY: ReportPdfSummary = {
  headline: {
    label: 'Fair market value per common share',
    value: '$1.2345',
    note: 'Valuation date 2026-06-30',
  },
  figures: [
    { label: 'Concluded equity value', value: '$24,000,000' },
    { label: 'Allocation method', value: 'Option pricing model' },
    { label: 'DLOM', value: '25.0%', note: 'Finnerty average-strike put model' },
  ],
  statement: 'It is our opinion that the fair market value of one common share is $1.2345.',
  charts: [
    {
      type: 'bar',
      title: 'Equity value by approach',
      points: [
        { label: 'Income (DCF)', value: 26_000_000, display: '$26,000,000' },
        { label: 'Market (comparables)', value: 20_000_000, display: '$20,000,000' },
      ],
      note: 'Weighted concluded equity value: $24,000,000.',
    },
    {
      type: 'waterfall',
      title: 'From marketable value to fair market value',
      start: { label: 'Marketable common', value: 1.8286, display: '$1.8286' },
      steps: [
        { label: 'Less DLOC 10.0%', value: -0.1829, display: '-$0.1829' },
        { label: 'Less DLOM 25.0%', value: -0.4114, display: '-$0.4114' },
      ],
      end_label: 'Concluded FMV',
      end_value: 1.2345,
      end_display: '$1.2345',
    },
  ],
};

describe('waterfallColumns', () => {
  it('floats each step between the running values either side of it', () => {
    const columns = waterfallColumns(
      { label: 'Start', value: 100 },
      [
        { label: 'Less 10', value: -10 },
        { label: 'Plus 5', value: 5 },
      ],
      'End',
    );
    expect(columns.map((c) => [c.label, c.kind, c.bottom, c.top])).toEqual([
      ['Start', 'total', 0, 100],
      ['Less 10', 'decrease', 90, 100],
      ['Plus 5', 'increase', 90, 95],
      ['End', 'total', 0, 95],
    ]);
  });

  it('honours an explicit end value when engine rounding differs from the sum', () => {
    const columns = waterfallColumns(
      { label: 'Start', value: 1.8286 },
      [{ label: 'Less DLOM', value: -0.5942 }],
      'FMV',
      1.2345,
      '$1.2345',
    );
    expect(columns.at(-1)).toMatchObject({ top: 1.2345, display: '$1.2345', kind: 'total' });
  });

  it('falls back to formatted values when no display is supplied', () => {
    const columns = waterfallColumns({ label: 'Start', value: 4_200_000 }, [], 'End');
    expect(columns[0]!.display).toBe('4.20m');
  });
});

describe('formatChartValue', () => {
  it('scales by magnitude', () => {
    expect(formatChartValue(2_400_000_000)).toBe('2.40bn');
    expect(formatChartValue(24_000_000)).toBe('24.00m');
    expect(formatChartValue(24_000)).toBe('24k');
    expect(formatChartValue(24)).toBe('24.00');
    expect(formatChartValue(0.1234)).toBe('0.1234');
    expect(formatChartValue(-24_000_000)).toBe('-24.00m');
  });
});

describe('chartHeight', () => {
  it('grows with the number of bars', () => {
    const two = chartHeight({
      type: 'bar',
      title: 't',
      points: [
        { label: 'a', value: 1 },
        { label: 'b', value: 2 },
      ],
    });
    const five = chartHeight({
      type: 'bar',
      title: 't',
      points: Array.from({ length: 5 }, (_, i) => ({
        label: String(i),
        value: i,
      })),
    });
    expect(five).toBeGreaterThan(two);
  });

  it('reserves room for a caption', () => {
    const base = { type: 'bar', title: 't', points: [{ label: 'a', value: 1 }] } as const;
    expect(chartHeight({ ...base, note: 'a caption' })).toBeGreaterThan(chartHeight(base));
  });
});

describe('executive summary page', () => {
  it('renders the headline, figures and conclusion statement', async () => {
    const pdf = await renderReportPdf({ ...SAMPLE, summary: SUMMARY }, { compress: false });
    const text = extractText(pdf);
    expect(text).toContain('Executive Summary');
    expect(text).toContain('$1.2345');
    expect(text).toContain('FAIR MARKET VALUE PER COMMON SHARE');
    expect(text).toContain('Option pricing model');
    expect(text).toContain('It is our opinion');
  });

  it('draws the charts and labels them', async () => {
    const text = extractText(await renderReportPdf({ ...SAMPLE, summary: SUMMARY }, { compress: false }));
    expect(text).toContain('Equity value by approach');
    expect(text).toContain('Income (DCF)');
    expect(text).toContain('$26,000,000');
    expect(text).toContain('Marketable common');
    expect(text).toContain('Concluded FMV');
  });

  it('adds exactly one page', async () => {
    const without = await renderReportPdf(SAMPLE, { compress: false });
    const withSummary = await renderReportPdf({ ...SAMPLE, summary: SUMMARY }, { compress: false });
    expect(pageCount(withSummary)).toBe(pageCount(without) + 1);
  });

  it('appears in the contents as an unnumbered entry ahead of section 1', async () => {
    const text = extractText(
      await renderReportPdf({ ...SAMPLE, summary: SUMMARY, include_toc: true }, { compress: false }),
    );
    const toc = text.slice(text.indexOf('Table of Contents'));
    expect(toc.indexOf('Executive Summary')).toBeLessThan(toc.indexOf('1. Introduction'));
    // Not renumbered as "1. Executive Summary" — the sections keep their numbers.
    expect(toc).not.toContain('1. Executive Summary');
    expect(toc).toContain('2. Methodology');
  });

  it('is omitted entirely when no summary is supplied', async () => {
    const text = extractText(await renderReportPdf(SAMPLE, { compress: false }));
    expect(text).not.toContain('Executive Summary');
  });

  it('survives a summary with no figures, statement or charts', async () => {
    const pdf = await renderReportPdf(
      { ...SAMPLE, summary: { headline: { label: 'FMV', value: '$1.00' } } },
      { compress: false },
    );
    expect(extractText(pdf)).toContain('Executive Summary');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('does not divide by zero on an all-zero bar series', async () => {
    const pdf = await renderReportPdf(
      {
        ...SAMPLE,
        summary: {
          headline: { label: 'FMV', value: '$0.00' },
          charts: [{ type: 'bar', title: 'Nothing', points: [{ label: 'a', value: 0 }] }],
        },
      },
      { compress: false },
    );
    expect(extractText(pdf)).toContain('Nothing');
  });
});

describe('section charts', () => {
  it('renders charts attached to a section after its prose', async () => {
    const text = extractText(
      await renderReportPdf(
        {
          ...SAMPLE,
          sections: [
            {
              heading: 'Allocation',
              html: '<p>The equity value is allocated as follows.</p>',
              charts: [
                {
                  type: 'bar',
                  title: 'Allocation by class',
                  points: [{ label: 'Common', value: 6_000_000, display: '$6.0m' }],
                },
              ],
            },
          ],
        },
        { compress: false },
      ),
    );
    expect(text.indexOf('allocated as follows')).toBeLessThan(text.indexOf('Allocation by class'));
    expect(text).toContain('$6.0m');
  });

  it('pushes a chart that will not fit onto the next page', async () => {
    const chart = {
      type: 'waterfall' as const,
      title: 'Bridge',
      start: { label: 'Start', value: 10 },
      steps: [{ label: 'Less', value: -2 }],
      end_label: 'End',
    };
    // Swept rather than fixed. How much prose fills a page is a property of the
    // face, so one filler length exercises the push only by coincidence — this
    // test passed for a year and then stopped the day the renderer embedded a
    // wider one, with the logic untouched. Across the sweep the chart is
    // certain to meet a page with too little room left on it.
    let pushed = 0;
    for (const sentences of [100, 110, 120, 130, 140]) {
      const longProse = `<p>${'Filler sentence for pagination. '.repeat(sentences)}</p>`;
      const withChart = await renderReportPdf(
        { ...SAMPLE, include_toc: false, sections: [{ heading: 'Long', html: longProse, charts: [chart] }] },
        { compress: false },
      );
      const withoutChart = await renderReportPdf(
        { ...SAMPLE, include_toc: false, sections: [{ heading: 'Long', html: longProse }] },
        { compress: false },
      );
      // Wherever it lands, it lands whole and it lands in the file.
      expect(extractText(withChart)).toContain('Bridge');
      if (pageCount(withChart) > pageCount(withoutChart)) pushed += 1;
    }
    expect(pushed, 'no filler length left the chart short of room').toBeGreaterThan(0);
  });
});

/**
 * The document a client downloads is compressed, and until the reader below
 * learned to inflate, nothing in this repository could read one: `/FlateDecode`
 * covers the `/ToUnicode` CMaps as well as the page content, so a decoder
 * without zlib has no glyph table and hands back the subset's glyph indices as
 * if they were letters. Two suites asserted on that noise for weeks.
 *
 * These compare the delivered bytes against the same document rendered with
 * compression off, which is what the rest of this file reads — so the two
 * readings cannot drift apart without a failure here.
 */
describe('reading back the compressed document a client receives', () => {
  it('says the same words as the uncompressed render', async () => {
    const [compressed, plain] = await Promise.all([
      renderReportPdf(SAMPLE),
      renderReportPdf(SAMPLE, { compress: false }),
    ]);
    expect(compressed.length).toBeLessThan(plain.length);
    expect(extractText(compressed)).toBe(extractText(plain));
    expect(extractText(compressed)).toContain('fair market value');
  });

  it('counts the same pages', async () => {
    const [compressed, plain] = await Promise.all([
      renderReportPdf(SAMPLE),
      renderReportPdf(SAMPLE, { compress: false }),
    ]);
    expect(pageCount(compressed)).toBe(pageCount(plain));
  });

  it('reads a document long enough to hold a stream that spells a keyword', async () => {
    // A deflated stream is arbitrary bytes: over enough of them `endstream`,
    // `endobj` and `/Type /Page` all turn up by accident. A reader bounded by
    // those rather than by `/Length` truncates a page or invents one, and only
    // on documents big enough for the coincidence to happen.
    const long = {
      ...SAMPLE,
      sections: Array.from({ length: 40 }, (_, i) => ({
        heading: `Section ${i + 1}`,
        html: `<p>${'Body text that compresses well and repeats. '.repeat(40)}</p>`,
      })),
    };
    const [compressed, plain] = await Promise.all([
      renderReportPdf(long),
      renderReportPdf(long, { compress: false }),
    ]);
    expect(pageCount(compressed)).toBeGreaterThan(5);
    expect(pageCount(compressed)).toBe(pageCount(plain));
    expect(extractText(compressed)).toBe(extractText(plain));
  });
});
