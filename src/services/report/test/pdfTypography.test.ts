import { describe, expect, it } from 'vitest';
import { MIN_LINES_KEPT, renderReportPdf, type ReportPdfInput } from '../src/pdf.js';
import { pageLines, pageTexts } from './support/pdfText.js';

/**
 * Where the page breaks fall.
 *
 * A valuation report is read as a printed document — in a board pack, in a
 * data room, in an auditor's file — so the places it is allowed to break are
 * part of whether it reads as professional. Three breaks are never acceptable:
 * a heading stranded at the foot of a page with what it introduces overleaf,
 * a paragraph's opening line left behind alone, and its closing line carried
 * over alone. All three used to happen, because the renderer reserved a fixed
 * number of points before each block instead of measuring what it was about
 * to set.
 *
 * These tests sweep the amount of filler above the block under test, which
 * walks it across a page boundary a fraction at a time. A single fixed filler
 * would sit in one arbitrary position and pass whatever the logic did.
 */

/**
 * For each page, how many laid-out lines contain `marker`.
 *
 * PDFKit emits one `Tm` per line it sets, so counting the distinct baselines
 * whose text carries the marker counts the marker's lines on that page.
 */
function markerLinesPerPage(pdf: Buffer, marker: string): number[] {
  return pageLines(pdf).map(
    (page) => new Set(page.filter((l) => l.text.includes(marker)).map((l) => l.baseline)).size,
  );
}

const filler = (n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `<p>Filler ${i} concerning the subject company and its capital structure.</p>`,
  ).join('');

const base = (html: string): ReportPdfInput => ({
  title: 'Typography',
  company_name: 'Acme Robotics, Inc.',
  meta: [],
  include_toc: false,
  sections: [{ heading: 'Section', html }],
});

/**
 * The sweep range. Each extra filler paragraph moves the block under test down
 * by about three lines, so this walks it across roughly two page boundaries —
 * enough that any position in the cycle is hit.
 */
const SWEEP = Array.from({ length: 28 }, (_, i) => 18 + i);

describe('page breaks — headings', () => {
  it('never leaves a sub-heading alone at the foot of a page', async () => {
    const stranded: number[] = [];
    for (const n of SWEEP) {
      const pdf = await renderReportPdf(
        base(`${filler(n)}<h2>SUBHEADING</h2><p>MARKERPARA opening the subsection, at some length.</p>`),
        { compress: false },
      );
      const pages = pageTexts(pdf);
      const heading = pages.findIndex((p) => p.includes('SUBHEADING'));
      const body = pages.findIndex((p) => p.includes('MARKERPARA'));
      expect(heading, `filler=${n}: heading not rendered`).toBeGreaterThanOrEqual(0);
      if (heading !== body) stranded.push(n);
    }
    expect(stranded, 'heading left on a page without its opening paragraph').toEqual([]);
  });

  it('keeps a heading with a table that follows it', async () => {
    const table = `<table><tr><th>Holder</th><th>Shares</th></tr>${Array.from(
      { length: 4 },
      (_, i) => `<tr><td>Holder ${i}</td><td>1,000</td></tr>`,
    ).join('')}</table>`;
    const orphaned: number[] = [];
    for (const n of SWEEP) {
      const pdf = await renderReportPdf(base(`${filler(n)}<h2>TABLEHEAD</h2>${table}`), {
        compress: false,
      });
      const pages = pageTexts(pdf);
      const heading = pages.findIndex((p) => p.includes('TABLEHEAD'));
      const firstRow = pages.findIndex((p) => p.includes('Holder 0'));
      if (heading !== firstRow) orphaned.push(n);
    }
    expect(orphaned, 'heading separated from the table it introduces').toEqual([]);
  });
});

describe('page breaks — paragraphs', () => {
  /** ~8 lines: long enough to split, short enough to fit on one page. */
  const longParagraph = `<p>${Array.from({ length: 120 }, (_, i) => `ZQ${i}`).join(' ')}</p>`;

  it(`never splits leaving fewer than ${MIN_LINES_KEPT} lines on either side`, async () => {
    const bad: string[] = [];
    for (const n of SWEEP) {
      const pdf = await renderReportPdf(base(filler(n) + longParagraph), { compress: false });
      const counts = markerLinesPerPage(pdf, 'ZQ').filter((c) => c > 0);
      if (counts.length > 1 && counts.some((c) => c < MIN_LINES_KEPT)) {
        bad.push(`filler=${n}: ${counts.join(' + ')}`);
      }
    }
    expect(bad, 'paragraph broken into a widow or an orphan').toEqual([]);
  });

  it('still sets a paragraph taller than one page rather than looping', async () => {
    // The guard moves a badly-breaking block to the next page. A block that is
    // taller than a page can never break well, so it has to be exempt — or the
    // renderer would push it forward forever.
    const huge = `<p>${Array.from({ length: 900 }, (_, i) => `HG${i}`).join(' ')}</p>`;
    const pdf = await renderReportPdf(base(huge), { compress: false });
    const counts = markerLinesPerPage(pdf, 'HG').filter((c) => c > 0);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(40);
  });
});

describe('page breaks — lists', () => {
  it('keeps a list item’s marker on the same page as its text', async () => {
    const items = Array.from(
      { length: 6 },
      (_, i) =>
        `<li>LI${i} a list item long enough to wrap onto a second line when set at body width in this report.</li>`,
    ).join('');
    const split: string[] = [];
    for (const n of SWEEP) {
      const pdf = await renderReportPdf(base(`${filler(n)}<ul>${items}</ul>`), { compress: false });
      for (let item = 0; item < 6; item += 1) {
        const counts = markerLinesPerPage(pdf, `LI${item}`).filter((c) => c > 0);
        // The marker is drawn inline with the item's first line, so an item
        // whose lines land on two pages has left its bullet behind.
        if (counts.length > 1) split.push(`filler=${n} item=${item}`);
      }
    }
    expect(split, 'list item broken across a page').toEqual([]);
  });
});
