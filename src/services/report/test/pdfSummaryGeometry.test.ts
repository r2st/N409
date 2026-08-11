import { describe, expect, it } from 'vitest';
import { renderReportPdf, type ReportPdfInput, type ReportPdfSummary } from '../src/pdf.js';

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
 * MARKETABILITY" is 161pt of Helvetica-8 in a 144pt column — put its second
 * line through the value beneath it, and the two numbers a board reads off this
 * page overprinted each other.
 *
 * These tests read the laid-out geometry back out of the content stream, so
 * they fail on a collision rather than on a change of wording.
 */

/** Content streams in page order (rendered uncompressed for inspection). */
function contentStreams(pdf: Buffer): string[] {
  const streams: string[] = [];
  let i = 0;
  for (;;) {
    const start = pdf.indexOf('stream', i);
    if (start < 0) break;
    let from = start + 'stream'.length;
    if (pdf[from] === 0x0d) from += 1;
    if (pdf[from] === 0x0a) from += 1;
    const end = pdf.indexOf('endstream', from);
    if (end < 0) break;
    const body = pdf.subarray(from, end).toString('latin1');
    if (body.includes('Tm')) streams.push(body);
    i = end + 'endstream'.length;
  }
  return streams;
}

const shown = (hexRun: string): string =>
  Array.from(hexRun.matchAll(/<([0-9a-fA-F]+)>/g))
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');

/**
 * One laid-out line: where pdfkit put it, how big it is, and what it says.
 *
 * PDF y grows upwards from the foot of the page and `Tm` positions the
 * *baseline*, so a line's ink sits between `y - descent` and `y + ascent`.
 * Helvetica's ascender is 718/1000 of the point size and its descender 207.
 */
interface Line {
  x: number;
  baseline: number;
  size: number;
  text: string;
}

function lines(pdf: Buffer): Line[][] {
  return contentStreams(pdf).map((stream) =>
    Array.from(
      stream.matchAll(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\s*\/F\d+ ([\d.]+) Tf\s*\[([^\]]*)\]/g),
      (m) => ({
        x: Number(m[1]),
        baseline: Number(m[2]),
        size: Number(m[3]),
        text: shown(m[4]!),
      }),
    ),
  );
}

/** Top and bottom of a line's ink, in PDF coordinates (top > bottom). */
const top = (line: Line): number => line.baseline + (718 / 1000) * line.size;
const bottom = (line: Line): number => line.baseline - (207 / 1000) * line.size;

/** The page carrying the summary. */
function summaryLines(pdf: Buffer): Line[] {
  const page = lines(pdf).find((p) => p.some((l) => l.text.includes('Executive Summary')));
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
    const page = summaryLines(await render([{ label: 'Discount for lack of marketability', value: '25.0%' }]));
    expect(find(page, 'DISCOUNT FOR LACK OF').text).not.toContain('MARKETABILITY');
    expect(find(page, 'MARKETABILITY')).toBeDefined();
  });

  it('keeps a wrapped label clear of the value beneath it', async () => {
    const page = summaryLines(await render([{ label: 'Discount for lack of marketability', value: '25.0%' }]));
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
    // Helvetica at 8pt sets on a 9.248pt line (ascender + line gap - descender).
    const one = summaryLines(await render([{ label: 'DLOM', value: '25.0%' }]));
    const two = summaryLines(await render([{ label: 'Discount for lack of marketability', value: '25.0%' }]));
    const drop = find(one, '25.0%').baseline - find(two, '25.0%').baseline;
    expect(drop).toBeCloseTo(9.248, 2);
  });

  it('leaves a single-line figure within a point of where it was drawn', async () => {
    // The fixed offsets this replaces put the value 11pt below the row top and
    // the note 27pt below it. A summary whose labels all fit on one line — which
    // is every report issued before the fix — has to keep setting the same way,
    // and it does, to within about half a point: the label measures 9.25pt and
    // the value 14.28pt (Helvetica-Bold carries a deeper line gap than the
    // regular face), so the round 2pt gaps put the value at 11.25 and the note
    // at 27.5. Neither is a visible move, and magic constants chosen to land on
    // the old numbers exactly would be worse than the drift they remove.
    const page = summaryLines(await render([{ label: 'DLOM', value: '25.0%', note: 'Finnerty' }]));
    const label = find(page, 'DLOM');
    // Baseline separations implied by the old constants: the runs started 11 and
    // 27 points below the row top, and each baseline sits an ascender below its
    // own run's top.
    const valueDrop = label.baseline - find(page, '25.0%').baseline;
    const noteDrop = label.baseline - find(page, 'Finnerty').baseline;
    expect(Math.abs(valueDrop - (11 + (718 / 1000) * (12 - 8)))).toBeLessThan(1);
    expect(Math.abs(noteDrop - 27)).toBeLessThan(1);
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
