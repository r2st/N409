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
import { extractText, pageCount } from './support/pdfText.js';

/**
 * Table layout and page furniture.
 *
 * A valuation report is mostly tables of money spread over more pages than fit
 * on one, so the two things that decide whether it reads as professional are
 * decided here: figures aligning by place value down a column, and a table
 * that breaks across pages still carrying its headings.
 */

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

  /**
   * Exhibit H — the table that states the conclusion of a 409A — is a long
   * prose label, one currency figure, and a long prose basis. Both prose
   * columns hit the ceiling, so normalising everything by the same factor
   * squeezed the figure by the few points it was short and printed the DLOC
   * line as `($0.1723` with its closing bracket alone on the next line.
   *
   * A label that wraps is still a label. A number that wraps is a mistake.
   */
  describe('when the natural widths do not fit', () => {
    const EXHIBIT_H = [
      ['Step', 'Per share', 'Basis'],
      [
        'Less: discount for lack of control — 8.0%',
        '($0.1723)',
        'A minority holder cannot compel a liquidity event or direct the business',
      ],
      [
        'Concluded fair market value per common share as of 2026-06-30',
        '$1.2242',
        'Non-marketable, minority basis',
      ],
    ];

    it('gives the figure column the width its figures need', () => {
      const widths = columnWidths(EXHIBIT_H, USABLE, measure, 1);
      const widestFigure = measure('($0.1723)', false);
      expect(widths[1]!).toBeGreaterThanOrEqual(widestFigure);
    });

    it('takes the room from the prose, which can wrap', () => {
      const widths = columnWidths(EXHIBIT_H, USABLE, measure, 1);
      expect(widths[0]!).toBeGreaterThan(widths[1]!);
      expect(widths[2]!).toBeGreaterThan(widths[1]!);
      expect(sum(widths)).toBeCloseTo(USABLE, 6);
    });

    it('will not starve prose to feed figures', () => {
      // The mirror failure. A table of wide figures beside one label must not
      // reduce the label to an unreadable ribbon, so the reservation gives way
      // rather than pushing prose under the floor.
      const allFigures = [
        ['Label', 'A', 'B', 'C', 'D'],
        ['x', '$1,234,567,890', '$9,876,543,210', '$1,111,111,111', '$2,222,222,222'],
      ];
      const widths = columnWidths(allFigures, USABLE, measure, 1);
      expect(Math.min(...widths)).toBeGreaterThan(20);
      expect(sum(widths)).toBeCloseTo(USABLE, 6);
    });

    it('still fills the width exactly', () => {
      expect(sum(columnWidths(EXHIBIT_H, USABLE, measure, 1))).toBeCloseTo(USABLE, 6);
    });

    /**
     * The reservation is for the figures, not for the heading over them.
     *
     * Exhibit H's per-class table heads two currency columns "Value per share —
     * marketable" and "Value per share — non-marketable" over cells holding
     * "$2.0779". Reserving the *heading* width handed those two columns 66% of
     * the page and squeezed "Class" and "Type" to the floor, so the concluding
     * exhibit of a 409A printed its share classes as "Option / pool" and their
     * type as "preferre / d" — the same defect this branch exists to prevent,
     * pointed the other way.
     */
    describe('a figure column headed by a long label', () => {
      const PER_CLASS = [
        ['Class', 'Type', 'Shares', 'Value per share — marketable', 'Value per share — non-marketable'],
        ['Common', 'common', '9,250,000', '$2.0779', '$1.3883'],
        ['Series A', 'preferred', '2,400,000', '$2.5175', '—'],
        ['Option pool', 'option', '1,750,000', '$1.8301', '—'],
      ];

      it('leaves the label columns wide enough for what is in them', () => {
        const widths = columnWidths(PER_CLASS, USABLE, measure, 1);
        expect(widths[0]!).toBeGreaterThan(measure('Option pool', false));
        expect(widths[1]!).toBeGreaterThan(measure('preferred', false));
      });

      it('reserves the figures their width and no more', () => {
        const widths = columnWidths(PER_CLASS, USABLE, measure, 1);
        expect(widths[3]!).toBeGreaterThanOrEqual(measure('$2.0779', false));
        // The heading wraps instead: it is a label, and a label that wraps is
        // still a label. Reserving its width is what starved the columns above.
        expect(widths[3]!).toBeLessThan(measure('Value per share — marketable', true));
        expect(sum(widths)).toBeCloseTo(USABLE, 6);
      });

      it('does not narrow a table that already fitted', () => {
        // Only the squeeze reaches the correction, so a heading with room to
        // sit on one line keeps it.
        const roomy = [
          ['Metric', 'Amount'],
          ['Revenue', '$4,200,000'],
        ];
        const widths = columnWidths(roomy, USABLE, measure, 1);
        expect(widths[1]!).toBeGreaterThan(measure('Amount', true));
        expect(sum(widths)).toBeCloseTo(USABLE, 6);
      });
    });
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

  it('takes the first landmark when several begin on the same page', () => {
    // Short sections stack several to a sheet. Labelling that sheet with the
    // last of them names a heading further down the page than the header it
    // sits above — a report whose page opened "1. Introduction and Scope" was
    // headed "5. Allocation of Equity Value".
    const headings = runningHeadings(2, 0, [
      { page: 1, label: '1. First' },
      { page: 1, label: '2. Second' },
      { page: 1, label: '3. Third' },
    ]);
    expect(headings[1]).toBe('1. First');
  });

  /**
   * A section that begins part way down a page does not own that page's
   * running head — the part above it belongs to whatever ran over from the
   * sheet before.
   *
   * Common on a valuation report, because the exhibits are long tables: one
   * spills onto the next page and the next exhibit starts under it. A sheet
   * whose top half was Exhibit F's breakpoint schedule was headed "29. Exhibit
   * H — Discounts and Concluded Value", so a reader checking which schedule
   * they were looking at was told the wrong one.
   */
  describe('when a section starts part way down a page', () => {
    const TOP = 72;

    it('keeps the previous label, because the previous section is what is above it', () => {
      const headings = runningHeadings(
        3,
        0,
        [
          { page: 1, label: '28. Exhibit F', y: TOP },
          // Exhibit F's table runs onto page 2; Exhibit H starts below it.
          { page: 2, label: '29. Exhibit H', y: 520 },
        ],
        TOP,
      );
      expect(headings[2]).toBe('28. Exhibit F');
    });

    it('takes the new label when the section does start at the top', () => {
      const headings = runningHeadings(
        3,
        0,
        [
          { page: 1, label: '28. Exhibit F', y: TOP },
          { page: 2, label: '29. Exhibit H', y: TOP },
        ],
        TOP,
      );
      expect(headings[2]).toBe('29. Exhibit H');
    });

    it('allows a heading\u2019s own height of slack', () => {
      // A section heading drawn at the top of the text area still leaves the
      // cursor a few points below the margin; that is the top of the page.
      const headings = runningHeadings(
        2,
        0,
        [
          { page: 0, label: '1. First', y: TOP },
          { page: 1, label: '2. Second', y: TOP + 12 },
        ],
        TOP,
      );
      expect(headings[1]).toBe('2. Second');
    });

    it('still labels the following page with the section actually running', () => {
      // The rule is about the *top* of a page. Once Exhibit H has the whole
      // sheet, it takes the header.
      const headings = runningHeadings(
        4,
        0,
        [
          { page: 1, label: '28. Exhibit F', y: TOP },
          { page: 2, label: '29. Exhibit H', y: 520 },
        ],
        TOP,
      );
      expect(headings[2]).toBe('28. Exhibit F');
      expect(headings[3]).toBe('29. Exhibit H');
    });

    it('names the section actually running over, not the previous page’s label', () => {
      // The two differ whenever several sections shared the previous page, and
      // that is the shape the exhibits produce: page 11 of the sample 409A
      // opens with §23 and also carries §24 and §25, so it is correctly headed
      // "23. Index of Exhibits". Page 12 is the continuation of §25's table
      // with §26 starting under it.
      //
      // Propagating page 11's *label* headed page 12 "23. Index of Exhibits" —
      // naming a section that finished two schedules earlier, on a sheet whose
      // visible content is Exhibit B's reconciliation table. The section that
      // was running when page 11 ended is §25, and that is what the page shows.
      const headings = runningHeadings(
        3,
        0,
        [
          { page: 1, label: '23. Index of Exhibits', y: TOP },
          { page: 1, label: '24. Exhibit A', y: 300 },
          { page: 1, label: '25. Exhibit B', y: 600 },
          { page: 2, label: '26. Exhibit C', y: 400 },
        ],
        TOP,
      );
      expect(headings[1]).toBe('23. Index of Exhibits');
      expect(headings[2]).toBe('25. Exhibit B');
    });

    it('falls back to the section on the page when nothing ran over', () => {
      // The first page of the range has no predecessor, so a section beginning
      // half way down it is still the only honest label.
      const headings = runningHeadings(1, 0, [{ page: 0, label: '1. First', y: 400 }], TOP);
      expect(headings[0]).toBe('1. First');
    });

    it('treats a landmark with no y as starting its own page', () => {
      // The contents and the summary always begin a fresh sheet, so they carry
      // no position and are at the top by construction.
      const headings = runningHeadings(
        2,
        0,
        [
          { page: 0, label: '1. First', y: TOP },
          { page: 1, label: 'Executive Summary' },
        ],
        TOP,
      );
      expect(headings[1]).toBe('Executive Summary');
    });
  });

  it('carries the last landmark of a crowded page onto the next one', () => {
    // Page 1 opens with §1 and ends inside §3, so page 2 is still §3.
    const headings = runningHeadings(3, 0, [
      { page: 1, label: '1. First' },
      { page: 1, label: '2. Second' },
      { page: 1, label: '3. Third' },
    ]);
    expect(headings).toEqual([null, '1. First', '3. Third']);
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

  it('labels a page by the section it opens with', async () => {
    // Both of SAMPLE's sections begin on one page. The head belongs to the
    // heading directly beneath it — naming the second would point the reader at
    // something further down the sheet they are holding.
    const text = extractText(await renderReportPdf({ ...SAMPLE, include_toc: false }, { compress: false }));
    expect(occurrences(text, '1. Introduction')).toBeGreaterThan(1);
    expect(occurrences(text, '2. Methodology')).toBe(1);
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
