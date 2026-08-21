import { describe, expect, it } from 'vitest';
import { renderReportPdf, type ReportPdfInput, type ReportPdfSummary } from '../src/pdf.js';
import { pageLines, type Line } from './support/pdfText.js';

/**
 * Where the executive summary's supporting figures actually land on the page.
 *
 * The summary page is the one page of a valuation report that is certain to be
 * read, and its three supporting figures are drawn as positioned runs rather
 * than as flowed text — so nothing about them is checked by asserting that the
 * text is present in the file. It was present. It was also drawn on top of
 * itself: the label was set with wrapping enabled at the row's top, and the
 * value at a fixed 11 points below that, which is the height of exactly one
 * line of label. A label needing two lines — "DISCOUNT FOR LACK OF
 * MARKETABILITY" sets well past the 144pt this column gives it — put its second
 * line through the value beneath it, and the two numbers a board reads off this
 * page overprinted each other.
 *
 * These tests read the laid-out geometry back out of the content stream, so
 * they fail on a collision rather than on a change of wording.
 */

/**
 * The embedded face's vertical metrics, as fractions of the point size.
 *
 * DejaVu Sans: 2048 units to the em, ascender 1901, descender -483, no line
 * gap. A line's ink sits between `baseline - DESCENDER * size` and
 * `baseline + ASCENDER * size`, and consecutive lines are LINE apart.
 */
const ASCENDER = 1901 / 2048;
const DESCENDER = 483 / 2048;
const LINE = (1901 + 483) / 2048;

/** Top and bottom of a line's ink, in PDF coordinates (top > bottom). */
const top = (line: Line): number => line.baseline + ASCENDER * line.size;
const bottom = (line: Line): number => line.baseline - DESCENDER * line.size;

/** The page carrying the summary. */
function summaryLines(pdf: Buffer): Line[] {
  const page = pageLines(pdf).find((p) => p.some((l) => l.text.includes('Executive Summary')));
  if (!page) throw new Error('no summary page in the rendered document');
  return page;
}

const find = (page: Line[], text: string): Line => {
  const hits = page.filter((l) => l.text.includes(text));
  if (hits.length !== 1) throw new Error(`expected exactly one line containing ${text}, got ${hits.length}`);
  return hits[0]!;
};

const BASE: ReportPdfInput = {
  title: 'IRC 409A Valuation Report',
  company_name: 'Acme Robotics, Inc.',
  meta: [{ label: 'Template', value: '409a.v53' }],
  sections: [{ heading: 'Introduction', html: '<p>Body.</p>' }],
};

const headline = { label: 'Fair market value per common share', value: '$1.2345' };

const render = (figures: ReportPdfSummary['figures']): Promise<Buffer> =>
  renderReportPdf({ ...BASE, summary: { headline, figures } }, { compress: false });

describe('executive summary supporting figures', () => {
  it('sets a long label over two lines', async () => {
    // The premise of every test below. If this label ever stops wrapping — a
    // wider column, a smaller face — the collision tests would pass without
    // exercising anything, so the wrap is asserted rather than assumed.
    const page = summaryLines(
      await render([{ label: 'Discount for lack of marketability', value: '25.0%' }]),
    );
    expect(find(page, 'DISCOUNT FOR LACK OF').text).not.toContain('MARKETABILITY');
    expect(find(page, 'MARKETABILITY')).toBeDefined();
  });

  it('keeps a wrapped label clear of the value beneath it', async () => {
    const page = summaryLines(
      await render([{ label: 'Discount for lack of marketability', value: '25.0%' }]),
    );
    const second = find(page, 'MARKETABILITY');
    const value = find(page, '25.0%');
    // The whole defect in one line: the value's ink began above where the
    // label's last line ended.
    expect(top(value)).toBeLessThan(bottom(second));
  });

  it('keeps a wrapped label clear of the note beneath the value', async () => {
    const page = summaryLines(
      await render([
        { label: 'Discount for lack of marketability', value: '25.0%', note: 'Finnerty average-strike put' },
      ]),
    );
    const value = find(page, '25.0%');
    const note = find(page, 'Finnerty');
    expect(top(note)).toBeLessThan(bottom(value));
  });

  it('pushes the value down by exactly the extra label line', async () => {
    // What "stacked dynamically" means, stated as an equality: a second line of
    // label moves the value one label line-height further down and no further.
    const one = summaryLines(await render([{ label: 'DLOM', value: '25.0%' }]));
    const two = summaryLines(await render([{ label: 'Discount for lack of marketability', value: '25.0%' }]));
    const drop = find(one, '25.0%').baseline - find(two, '25.0%').baseline;
    expect(drop).toBeCloseTo(LINE * 8, 3);
  });

  it('leaves a single-line figure within a point of where it was drawn', async () => {
    // The fixed offsets this replaces put the value 11pt below the row top and
    // the note 27pt below it. A summary whose labels all fit on one line — which
    // is every report issued before the fix — has to keep setting the same way,
    // and it does, to within a third of a point: the label measures 9.31pt and
    // the value 13.97pt, so the round 2pt gaps put the value 11.31 below the row
    // top and the note 27.28. Neither is a visible move, and magic constants
    // chosen to land on the old numbers exactly would be worse than the drift
    // they remove.
    const page = summaryLines(await render([{ label: 'DLOM', value: '25.0%', note: 'Finnerty' }]));
    const label = find(page, 'DLOM');
    // Baseline separations implied by the old constants: the runs started 11 and
    // 27 points below the row top, and each baseline sits an ascender below its
    // own run's top.
    const valueDrop = label.baseline - find(page, '25.0%').baseline;
    const noteDrop = label.baseline - find(page, 'Finnerty').baseline;
    expect(Math.abs(valueDrop - (11 + ASCENDER * (12 - 8)))).toBeLessThan(0.5);
    expect(Math.abs(noteDrop - 27)).toBeLessThan(0.5);
  });

  it('does not let a wrapped label in one column disturb its neighbours', async () => {
    // The three figures share a row top. Only the column that wrapped moves.
    const page = summaryLines(
      await render([
        { label: 'Concluded equity value', value: '$24,000,000' },
        { label: 'Discount for lack of marketability', value: '25.0%' },
        { label: 'Method', value: 'OPM' },
      ]),
    );
    expect(find(page, 'CONCLUDED EQUITY').baseline).toBeCloseTo(find(page, 'METHOD').baseline, 5);
    expect(find(page, '$24,000,000').baseline).toBeCloseTo(find(page, 'OPM').baseline, 5);
    // ...and the wrapped column's value is the one that sits lower.
    expect(find(page, '25.0%').baseline).toBeLessThan(find(page, 'OPM').baseline);
  });

  it('gives the row enough height that the next row clears it', async () => {
    // Row height is the tallest column's, so a wrapped label must not let the
    // following row's labels ride up into this row's note.
    const page = summaryLines(
      await render([
        { label: 'A', value: '1' },
        { label: 'B', value: '2' },
        { label: 'Discount for lack of marketability', value: '25.0%', note: 'Finnerty' },
        { label: 'Second row figure', value: '3' },
      ]),
    );
    expect(top(find(page, 'SECOND ROW FIGURE'))).toBeLessThan(bottom(find(page, 'Finnerty')));
  });
});
