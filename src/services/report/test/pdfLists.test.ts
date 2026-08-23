import { describe, expect, it } from 'vitest';
import { renderReportPdf, type ReportPdfInput } from '../src/pdf.js';
import { pageLines, type Line } from './support/pdfText.js';

/**
 * Where a list item's second line starts.
 *
 * A list is a left edge. The marker hangs outside it and every line of the
 * item — first and runover alike — begins on it, which is what lets the eye
 * find where one item ends and the next begins. This renderer set the runover
 * lines *left* of the first line and level with the bullet itself, because
 * marker and text were one continued run and pdfkit wraps a run back to the x
 * the run began at. The result reads as prose with bullets loose in it.
 *
 * It shows up wherever items are longer than a line, which in a 409A is the
 * page a reader reaches second: Purpose of the Valuation & Intended Use sets
 * out intended user, intended use, subject interest, scope of work and
 * standards applied, and four of the five run past one line.
 */
describe('list indentation', () => {
  const listed = (html: string): ReportPdfInput => ({
    title: 'Lists',
    company_name: 'Acme Robotics, Inc.',
    meta: [],
    include_toc: false,
    sections: [{ heading: 'Purpose', html }],
  });

  const LONG =
    'the board of directors of Acme Robotics, Inc. and its officers, together ' +
    'with the accountants and auditors of the company in connection with the ' +
    'financial reporting of share-based payment under ASC 718.';

  /**
   * The lines of the first list item: the marker, and everything set to the
   * right of it on the baselines the item occupies.
   *
   * Picked out by geometry rather than by position in the page's line list,
   * because a page carries a running header above the item and a footer below
   * it. Both are excluded by the window: baselines run *up* the page, so the
   * item's own lines are the ones at or above the marker's baseline and within
   * a few line-heights of it, and the footer is two-thirds of a page below.
   */
  function itemLines(pdf: Buffer): { marker: Line; body: Line[] } {
    const pages = pageLines(pdf);
    const isMarker = (l: Line) => l.text.trim() === '•' || /^\d+\.$/.test(l.text.trim());
    const page = pages.find((p) => p.some(isMarker));
    expect(page, 'no page carries a list marker').toBeDefined();
    const marker = page!.find(isMarker)!;
    const body = page!.filter(
      (l) =>
        l !== marker &&
        // `>=`, not `>`. The defect this file guards puts runover lines *on*
        // the marker's own x, so a window that excluded them would drop the
        // very lines under test and report "the item did not wrap" instead of
        // where its second line started.
        l.x >= marker.x &&
        l.baseline <= marker.baseline &&
        l.baseline > marker.baseline - 80,
    );
    return { marker, body };
  }

  it.each([
    ['a bulleted item', `<ul><li>Intended user — ${LONG}</li></ul>`],
    ['a numbered item', `<ol><li>Intended user — ${LONG}</li></ol>`],
  ])('hangs the marker to the left of every line of %s', async (_what, html) => {
    const { marker, body } = itemLines(await renderReportPdf(listed(html)));

    // It wrapped, or the assertion below is about a list of one line.
    const baselines = new Set(body.map((l) => l.baseline));
    expect(baselines.size, 'the item did not wrap, so there is no runover to check').toBeGreaterThan(1);

    // Every line of the item starts on one left edge…
    const starts = [...baselines]
      .sort((a, b) => b - a)
      .map((baseline) => Math.min(...body.filter((l) => l.baseline === baseline).map((l) => l.x)));
    expect(new Set(starts.map((x) => x.toFixed(2))).size, `line starts were ${starts}`).toBe(1);

    // …and the marker hangs outside it.
    expect(marker.x).toBeLessThan(starts[0]!);
  });

  /**
   * The runover used to land on the marker's own x, so a test that only
   * required the item's lines to agree with each other would have passed on
   * the broken output too — they agreed, at the wrong place. This pins the
   * edge to the first line's text, which is the thing the marker hangs from.
   */
  it('starts the runover where the item’s text starts, not where its marker does', async () => {
    const { marker, body } = itemLines(await renderReportPdf(listed(`<ul><li>${LONG}</li></ul>`)));

    const top = Math.max(...body.map((l) => l.baseline));
    const firstLineX = Math.min(...body.filter((l) => l.baseline === top).map((l) => l.x));
    const runover = body.filter((l) => l.baseline < top);

    expect(runover.length).toBeGreaterThan(0);
    for (const line of runover) {
      expect(line.x).toBeCloseTo(firstLineX, 2);
      expect(line.x).not.toBeCloseTo(marker.x, 2);
    }
  });

  /** An item with no text still gets its marker, and nothing throws. */
  it('renders an empty item', async () => {
    const pdf = await renderReportPdf(listed('<ul><li></li><li>After.</li></ul>'));
    const text = pageLines(pdf)
      .flat()
      .map((l) => l.text)
      .join('');
    expect(text).toContain('After.');
  });
});
