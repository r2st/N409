import { describe, expect, it } from 'vitest';
import {
  columnAlignments,
  isNumericCell,
  renderReportPdf,
  typographicMinus,
  type ReportPdfInput,
} from '../src/pdf.js';
import { extractText, pageLines } from './support/pdfText.js';

/**
 * One minus sign, and the column alignment that depends on which one it is.
 *
 * The report used to set two glyphs for one meaning, on one page. Figures that
 * reach the renderer from `Intl.NumberFormat` — the DCF forecast, the present
 * values struck off it — carry U+002D, because that is what `Intl` emits for a
 * negative; figures the report composes by hand carry U+2212, because whoever
 * wrote those lines typed what a typographer would. Exhibit C printed
 * `-$1,200,000` in its forecast table and `−$700,000` five rows below it.
 *
 * The two halves of the repair have to land together, and that is the reason
 * they are tested in one file. Normalising the glyph without teaching
 * `isNumericCell` about it would move every negative figure in the document
 * into the class of cells that vote *prose*, and a column of losses would
 * left-align — the outcome `columnAlignments` calls the single thing that makes
 * a report look amateur, reached by the one route it was not watching.
 */
describe('the minus sign', () => {
  describe('typographicMinus', () => {
    it('sets a hyphen that opens a figure as a minus', () => {
      expect(typographicMinus('-$1,200,000')).toBe('−$1,200,000');
      expect(typographicMinus('reaching -$1,012,658 in 2027')).toBe('reaching −$1,012,658 in 2027');
      expect(typographicMinus('(-5%)')).toBe('(−5%)');
      expect(typographicMinus('-27.5%')).toBe('−27.5%');
    });

    /**
     * The half that matters more, because a valuation report is full of
     * hyphens doing their actual job and a greedy rule would corrupt the ones
     * a reader checks against their own records. The dates are the case that
     * would be most visible if this got it wrong.
     */
    it.each([
      ['a date', '2026-03-31'],
      ['a year range', '2027-2031'],
      ['a compound word', 'discounted free cash-flow'],
      ['a hyphenated method', 'Finnerty put-option model'],
      ['an exhibit reference', 'set out in Exhibit B-1'],
      ['a prefix', 'pre-2020 vintage'],
      ['a phone number', '555-1234'],
      ['a list marker', '- a bullet'],
      ['a spaced range', 'FY 2026 - 2027'],
    ])('leaves the hyphen in %s alone', (_what, text) => {
      expect(typographicMinus(text)).toBe(text);
    });

    it('leaves a minus that is already a minus', () => {
      expect(typographicMinus('−$700,000')).toBe('−$700,000');
    });

    /** Applied at both the draw and the measure, so it has to survive re-application. */
    it('is idempotent', () => {
      const once = typographicMinus('-$1,200,000 over 2026-03-31');
      expect(typographicMinus(once)).toBe(once);
    });
  });

  describe('a negative figure still reads as a figure', () => {
    it.each(['−$700,000', '−27.5%', '−1,200,000', '-$700,000'])('%s is numeric', (cell) => {
      expect(isNumericCell(cell)).toBe(true);
    });

    it('right-aligns a column whose figures are all negative', () => {
      const rows = [
        ['Step', 'Amount'],
        ['Liquidation preference', '−$12,400,000'],
        ['Option pool', '−$5,500,000'],
        ['Discount for lack of marketability', '−27.5%'],
      ];
      expect(columnAlignments(rows, 1)).toEqual(['left', 'right']);
    });
  });

  const report = (amount: string): ReportPdfInput => ({
    title: 'Discounts',
    company_name: 'Acme Robotics, Inc.',
    meta: [],
    include_toc: false,
    sections: [
      {
        heading: 'Exhibit C — Income Approach',
        html:
          `<p>Free cash flow is ${amount} in the first forecast year.</p>` +
          '<table><tr><th>Step</th><th>Amount</th></tr>' +
          `<tr><td>Free cash flow</td><td>${amount}</td></tr>` +
          '<tr><td>Less interest-bearing debt</td><td>−$700,000</td></tr>' +
          '<tr><td>Indicated equity value</td><td>$26,005,186</td></tr></table>',
      },
    ],
  });

  /**
   * The end-to-end statement, made against the delivered bytes rather than
   * against the normaliser: whatever an upstream hands the renderer, one glyph
   * comes out. Read back through the `/ToUnicode` CMap, so this is what a
   * reader copying the figure out of the document actually gets.
   */
  it('sets every negative figure in a rendered report with the same glyph', async () => {
    const text = extractText(await renderReportPdf(report('-$1,200,000')));

    expect(text).toContain('−$1,200,000');
    expect(text).toContain('−$700,000');
    // A hyphen opening a figure, anywhere in the document.
    expect(text).not.toMatch(/(^|[\s([{])-[\d$€£¥]/mu);
    // …and the hyphens that were never signs are all still there.
    expect(text).toContain('interest-bearing');
  });

  /**
   * Measurement and drawing are the same string, asserted through the one
   * consequence a test can see from outside.
   *
   * `fontSafe` changes a string's width. In the embedded face a minus is
   * 7.96pt against a hyphen's 3.43pt — 2.3× — and it can change a string's
   * length too, since a character the face cannot draw becomes `?` or a
   * transliteration. `.text()` was wrapped in `fontSafe` and the twelve
   * `widthOfString`/`heightOfString` calls were not, so the layout was computed
   * for a document other than the one produced: a column sized to fit text it
   * would not be given, a heading whose keep-with-next budget was a line short.
   * One instance of that reached the summary page and overprinted the two
   * figures a board reads off it, and was repaired at that call site alone.
   *
   * Two inputs differing only in which minus they were written with are the
   * same document after normalisation, so every glyph must land in exactly the
   * same place. Measure the raw string instead and the column holding the
   * figure is built from a hyphen in one render and a minus in the other.
   *
   * The fixture is shaped to let that be *seen*, which took two attempts. The
   * figure has to be the widest cell in its column, since `columnWidths` sizes
   * a column from its widest cell — and there have to be three columns. A
   * right-aligned cell is set from the table's right edge, and the widths are
   * normalised to fill the usable width, so the right edge of the last column
   * is the same however the columns divide: put the figure in the last column
   * of a two-column table, as the first draft did, and it lands on the same x
   * either way and the test passes with the wrapping removed. A third column
   * after it has an offset that moves.
   */
  it('lays a document out from the text it is going to draw', async () => {
    const widest = (amount: string): ReportPdfInput => ({
      title: 'Bridge',
      company_name: 'Acme Robotics, Inc.',
      meta: [],
      include_toc: false,
      sections: [
        {
          heading: 'Bridge',
          html:
            '<table><tr><th>Step</th><th>Amount</th><th>Basis</th></tr>' +
            `<tr><td>x</td><td>${amount}</td><td>note</td></tr>` +
            '<tr><td>y</td><td>$1</td><td>note</td></tr></table>',
        },
      ],
    });

    const geometry = (pdf: Buffer) =>
      pageLines(pdf).map((page) => page.map((l) => `${l.x},${l.baseline}:${l.text}`));

    const [fromHyphen, fromMinus] = await Promise.all([
      renderReportPdf(widest('-$1,234,567,890')),
      renderReportPdf(widest('−$1,234,567,890')),
    ]);

    expect(geometry(fromHyphen)).toEqual(geometry(fromMinus));
  });
});
