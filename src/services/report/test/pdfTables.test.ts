import { describe, expect, it } from 'vitest';
import {
  TABLE_CONTINUED,
  columnAlignments,
  columnWidths,
  isNumericCell,
  renderReportPdf,
  runningHeadings,
  type ReportPdfInput,
} from '../src/pdf.js';

/**
 * Table layout and page furniture.
 *
 * A valuation report is mostly tables of money spread over more pages than fit
 * on one, so the two things that decide whether it reads as professional are
 * decided here: figures aligning by place value down a column, and a table
 * that breaks across pages still carrying its headings.
 */

function extractText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  return Array.from(raw.matchAll(/<([0-9a-fA-F]+)>/g))
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
}

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('isNumericCell', () => {
  it('recognises the shapes money takes in a valuation table', () => {
    for (const cell of ['1234', '1,234', '4,200,000', '$4,200,000', '1,234.56', '0.1234', '-0.5942']) {
      expect(isNumericCell(cell), cell).toBe(true);
    }
  });

  it('recognises accounting negatives, percentages and multiples', () => {
    // A DLOM is a percentage and an EV/Revenue is a multiple; both belong in
    // the same right-aligned column as the figures they sit beside.
    for (const cell of ['(1,200)', '$(4,200.50)', '12.5%', '3.2x', '€980', '£1,000']) {
      expect(isNumericCell(cell), cell).toBe(true);
    }
  });

  it('treats prose, dates and identifiers as text', () => {
    for (const cell of ['Revenue', 'FY-1', '2024-01-01', 'Series B', 'Q3 2025 close', '']) {
      expect(isNumericCell(cell), cell).toBe(false);
    }
  });

  it('treats placeholders as absent rather than numeric', () => {
    for (const cell of ['—', '-', 'n/a', 'N/A', 'N/M']) {
      expect(isNumericCell(cell), cell).toBe(false);
    }
  });
});

describe('columnAlignments', () => {
  const rows = [
    ['Metric', 'FY-1', 'FY-2'],
    ['Revenue', '4,200,000', '6,900,000'],
    ['EBITDA', '(320,000)', '410,000'],
  ];

  it('right-aligns figure columns and leaves labels left', () => {
    expect(columnAlignments(rows, 1)).toEqual(['left', 'right', 'right']);
  });

  it('ignores the header row, which is always prose', () => {
    // Without excluding it, "FY-1" would out-vote two figures in a short table
    // and unalign the column.
    expect(columnAlignments(rows, 1)[1]).toBe('right');
  });

  it('counts a placeholder for neither side', () => {
    const withGaps = [
      ['Metric', 'Value'],
      ['Revenue', '4,200,000'],
      ['Backlog', '—'],
      ['Churn', 'n/a'],
    ];
    expect(columnAlignments(withGaps, 1)[1]).toBe('right');
  });

  it('leaves a column of prose alone', () => {
    const notes = [
      ['Assumption', 'Basis'],
      ['DLOM', 'Finnerty'],
      ['Volatility', 'Guideline company median'],
    ];
    expect(columnAlignments(notes, 1)).toEqual(['left', 'left']);
  });

  it('gives a tie to the figures', () => {
    const mixed = [
      ['Metric', 'Value'],
      ['Revenue', '4,200,000'],
      ['Basis', 'Management forecast'],
    ];
    expect(columnAlignments(mixed, 1)[1]).toBe('right');
  });

  it('handles a table with no header rows and ragged rows', () => {
    expect(columnAlignments([['a', '1'], ['b']], 0)).toEqual(['left', 'right']);
  });

  it('returns one alignment for an empty table rather than throwing', () => {
    expect(columnAlignments([], 0)).toEqual(['left']);
  });
});

describe('columnWidths', () => {
  // Stands in for pdfkit's metrics: bold is a shade wider, as it really is.
  const measure = (text: string, bold: boolean) => text.length * (bold ? 6 : 5.5);
  const USABLE = 468;
  const sum = (widths: number[]) => widths.reduce((a, b) => a + b, 0);

  it('fills the usable width exactly', () => {
    const widths = columnWidths(
      [
        ['Metric', 'FY-1'],
        ['Revenue', '4,200,000'],
      ],
      USABLE,
      measure,
      1,
    );
    expect(sum(widths)).toBeCloseTo(USABLE, 6);
  });

  it('gives a wordy column more room than a narrow one', () => {
    // The old equal split wrapped "Guideline public company method" onto three
    // lines while a two-character year column kept a third of the page.
    const widths = columnWidths(
      [
        ['Approach', 'Wt'],
        ['Guideline public company method', '40%'],
        ['Discounted cash flow method', '60%'],
      ],
      USABLE,
      measure,
      1,
    );
    expect(widths[0]!).toBeGreaterThan(widths[1]!);
  });

  it('caps one long cell so it cannot starve the other columns', () => {
    const widths = columnWidths(
      [
        ['Note', 'A', 'B'],
        ['x'.repeat(400), '1', '2'],
      ],
      USABLE,
      measure,
      1,
    );
    expect(widths[0]!).toBeLessThan(USABLE * 0.75);
    expect(Math.min(widths[1]!, widths[2]!)).toBeGreaterThan(20);
    expect(sum(widths)).toBeCloseTo(USABLE, 6);
  });

  it('gives a single column the whole width', () => {
    expect(columnWidths([['only']], USABLE, measure, 0)).toEqual([USABLE]);
  });

  it('splits evenly when every cell is empty', () => {
    const widths = columnWidths([['', '']], USABLE, measure, 0);
    expect(widths[0]).toBeCloseTo(widths[1]!, 6);
    expect(sum(widths)).toBeCloseTo(USABLE, 6);
  });
});

describe('runningHeadings', () => {
  it('carries a heading forward until the next landmark', () => {
    const headings = runningHeadings(6, 0, [
      { page: 1, label: 'Table of Contents' },
      { page: 2, label: 'Executive Summary' },
      { page: 3, label: '1. Introduction' },
      { page: 5, label: '2. Methodology' },
    ]);
    // A section running over three pages has to label all three; a header that
    // appeared only where the section began would be worse than none.
    expect(headings).toEqual([
      null,
      'Table of Contents',
      'Executive Summary',
      '1. Introduction',
      '1. Introduction',
      '2. Methodology',
    ]);
  });

  it('leaves the pages before the first landmark unlabelled', () => {
    expect(runningHeadings(3, 0, [{ page: 2, label: '1. Only' }])).toEqual([null, null, '1. Only']);
  });

  it('takes the last landmark when two begin on the same page', () => {
    const headings = runningHeadings(2, 0, [
      { page: 1, label: '1. First' },
      { page: 1, label: '2. Second' },
    ]);
    expect(headings[1]).toBe('2. Second');
  });

  it('does not depend on the landmarks arriving in order', () => {
    const headings = runningHeadings(3, 0, [
      { page: 2, label: '2. Second' },
      { page: 1, label: '1. First' },
    ]);
    expect(headings).toEqual([null, '1. First', '2. Second']);
  });

  it('respects a non-zero first page index', () => {
    expect(runningHeadings(2, 10, [{ page: 11, label: '1. Intro' }])).toEqual([null, '1. Intro']);
  });

  it('returns nothing for a report with no landmarks', () => {
    expect(runningHeadings(2, 0, [])).toEqual([null, null]);
  });
});

const CAP_TABLE_ROWS = Array.from(
  { length: 70 },
  (_, i) => `<tr><td>Holder ${i + 1}</td><td>Common</td><td>${(i + 1) * 1000}</td><td>${i + 1}.5%</td></tr>`,
).join('');

const LONG_TABLE: ReportPdfInput = {
  title: 'IRC 409A Valuation Report',
  company_name: 'Acme Robotics, Inc.',
  meta: [{ label: 'Engagement', value: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }],
  include_toc: false,
  sections: [
    {
      heading: 'Capitalization',
      html:
        '<table><thead><tr><th>Holder</th><th>Class</th><th>Shares</th><th>Fully diluted</th></tr></thead>' +
        `<tbody>${CAP_TABLE_ROWS}</tbody></table>`,
    },
  ],
};

describe('tables that break across pages', () => {
  it('repeats the header row on every continuation page', async () => {
    const pdf = await renderReportPdf(LONG_TABLE, { compress: false });
    const text = extractText(pdf);

    expect(pageCount(pdf)).toBeGreaterThan(2);
    // One header per page the table occupies. Without this a reader turning the
    // page finds four unlabelled columns of numbers.
    expect(occurrences(text, 'Fully diluted')).toBeGreaterThan(1);
    expect(occurrences(text, 'Holder')).toBeGreaterThan(occurrences(text, 'Holder 1'));
  });

  it('marks a repeated header as a continuation, not a second table', async () => {
    const text = extractText(await renderReportPdf(LONG_TABLE, { compress: false }));
    expect(occurrences(text, TABLE_CONTINUED)).toBe(occurrences(text, 'Fully diluted') - 1);
  });

  it('keeps every body row — the header repeat adds rows, never replaces them', async () => {
    const text = extractText(await renderReportPdf(LONG_TABLE, { compress: false }));
    expect(text).toContain('Holder 1');
    expect(text).toContain('Holder 70');
    expect(occurrences(text, 'Holder 35')).toBe(1);
  });

  it('does not strand a header alone at the foot of a page', async () => {
    // A header plus one row is the smallest fragment worth leaving behind.
    const filler = `<p>${'Filler sentence for pagination. '.repeat(150)}</p>`;
    const pdf = await renderReportPdf(
      {
        ...LONG_TABLE,
        sections: [
          {
            heading: 'Mixed',
            html: `${filler}<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody><tr><td>Revenue</td><td>4,200,000</td></tr></tbody></table>`,
          },
        ],
      },
      { compress: false },
    );
    const text = extractText(pdf);
    expect(text).toContain('Metric');
    expect(text).toContain('4,200,000');
    // The single-row table is not split from its own header.
    expect(occurrences(text, 'Metric')).toBe(1);
  });
});

describe('page furniture', () => {
  const SAMPLE: ReportPdfInput = {
    title: 'IRC 409A Valuation Report',
    company_name: 'Acme Robotics, Inc.',
    meta: [{ label: 'Engagement', value: '01JZZZ' }],
    sections: [
      { heading: 'Introduction', html: '<p>Body.</p>' },
      { heading: 'Methodology', html: '<p>Body.</p>' },
    ],
  };

  it('runs the section heading across the top of its pages', async () => {
    const long = `<p>${'Filler sentence for pagination. '.repeat(400)}</p>`;
    const text = extractText(
      await renderReportPdf(
        { ...SAMPLE, include_toc: false, sections: [{ heading: 'Introduction', html: long }] },
        { compress: false },
      ),
    );
    // Once as the section heading, then again in the running head of each page
    // the section runs onto.
    expect(occurrences(text, '1. Introduction')).toBeGreaterThan(1);
  });

  it('labels a page by the section in effect at its foot', async () => {
    // Two sections beginning on one page: the reader finishes that page inside
    // the second, so that is what the head names.
    const text = extractText(await renderReportPdf({ ...SAMPLE, include_toc: false }, { compress: false }));
    expect(occurrences(text, '2. Methodology')).toBeGreaterThan(1);
    expect(occurrences(text, '1. Introduction')).toBe(1);
  });

  it('leaves the cover free of the running head', async () => {
    const pdf = await renderReportPdf(SAMPLE, { compress: false });
    // The cover carries its own title block; a running head would only repeat
    // the company name a second time on the same page.
    const firstPage = pdf.toString('latin1').split('/Type /Page')[1] ?? '';
    expect(firstPage).toBeTruthy();
    expect(extractText(pdf)).toContain('Acme Robotics, Inc.');
  });

  it('still stamps the footer on every page', async () => {
    const text = extractText(await renderReportPdf(SAMPLE, { compress: false }));
    expect(text).toContain('Confidential');
    expect(text).toContain('Page 1 of');
  });
});
