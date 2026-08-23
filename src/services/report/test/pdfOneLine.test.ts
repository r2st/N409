import { describe, expect, it } from 'vitest';
import { ellipsize, footerLine, renderReportPdf, type ReportPdfInput } from '../src/pdf.js';
import { pageLines, extractText, type Line } from './support/pdfText.js';

/**
 * The fields that are drawn into a box and must stay inside it.
 *
 * Page furniture, chart labels and contents entries are all one line by
 * design, and every one of them said so by passing `lineBreak: false`. None of
 * them meant it. pdfkit reads that flag once, in `_initOptions`, and only to
 * decide whether to *default* a missing width; with `options.width` set — and
 * all twenty of these call sites set one, because they are drawing into a box —
 * `_text` hands the string to the line wrapper anyway. The guarantee was never
 * in force at any of them.
 *
 * It was not a latent bug everywhere. The running footer overflowed its 468pt
 * band in the platform's own sample report and wrapped, putting `opinion ·
 * Page 1 of 20` on a second line below the bottom margin of all twenty pages —
 * the one line of a document that is identical on every sheet, wrong on every
 * sheet. The rest were a character away rather than safe: the longest running
 * head in that same report clears its half of the band by 3pt.
 *
 * What binds is `height`. These tests are written against the drawn geometry
 * rather than against the options, because the options were what lied.
 */

const base = (over: Partial<ReportPdfInput> = {}): ReportPdfInput => ({
  title: 'IRC 409A Valuation Report',
  company_name: 'Northwind Robotics, Inc.',
  meta: [],
  include_toc: false,
  sections: [{ heading: 'Introduction', html: '<p>The engagement is described here.</p>' }],
  ...over,
});

/** The distinct baselines any of `page`'s lines were set on, top-most first. */
const baselines = (lines: Line[]): number[] =>
  [...new Set(lines.map((l) => l.baseline))].sort((a, b) => b - a);

describe('ellipsize', () => {
  // A stand-in for `widthOfString`: proportional enough to be a real test and
  // simple enough that the expected cut can be counted by hand.
  const measure = (text: string) => [...text].length * 10;

  it('leaves a string that fits exactly as it was', () => {
    expect(ellipsize('Introduction', 200, measure)).toBe('Introduction');
    expect(ellipsize('Introduction', 120, measure)).toBe('Introduction');
  });

  it('cuts to the longest prefix whose ellipsized form fits', () => {
    // 5 characters plus the ellipsis is 60; 6 plus the ellipsis is 70.
    expect(ellipsize('Introduction', 60, measure)).toBe('Intro…');
    expect(ellipsize('Introduction', 69, measure)).toBe('Intro…');
    expect(ellipsize('Introduction', 70, measure)).toBe('Introd…');
  });

  it('does not leave a space hanging before the ellipsis', () => {
    expect(ellipsize('Capital Structure', 90, measure)).toBe('Capital…');
  });

  /**
   * Cutting by UTF-16 unit would split the surrogate pair and put half a
   * character into the content stream — a worse outcome than the overflow.
   */
  it('cuts by code point, so an astral character survives or is dropped whole', () => {
    const text = '𝕏𝕐ℤ';
    for (let width = 0; width <= 60; width += 5) {
      const cut = ellipsize(text, width, measure);
      expect([...cut].every((ch) => ch === '…' || text.includes(ch))).toBe(true);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false);
    }
  });

  /**
   * A bare ellipsis is a mark the reader cannot interpret. Yielding the field
   * is what lets `footerLine` drop it rather than print `… · … · Page 1 of 20`.
   */
  it('yields the field rather than printing an ellipsis alone', () => {
    // 10pt holds the ellipsis and nothing else; 20pt holds one character too.
    expect(ellipsize('Introduction', 10, measure)).toBe('');
    expect(ellipsize('Introduction', 20, measure)).toBe('I…');
    expect(ellipsize('Introduction', 0, measure)).toBe('');
    expect(ellipsize('Introduction', -5, measure)).toBe('');
  });

  it('never returns something wider than the budget', () => {
    for (let width = 0; width <= 200; width += 3) {
      expect(measure(ellipsize('Reconciliation of Value Indications', width, measure))).toBeLessThanOrEqual(
        Math.max(0, width),
      );
    }
  });
});

describe('footerLine', () => {
  const measure = (text: string) => [...text].length * 10;

  it('joins the fields untouched when they fit', () => {
    const line = footerLine(['Report', 'Confidential', 'Page 1 of 20'], 1000, measure);
    expect(line).toBe('Report · Confidential · Page 1 of 20');
  });

  /**
   * The page number is the one field with no other source. The running head
   * repeats the company and the document; nothing else on the sheet says which
   * sheet it is. It is also the last field, so plain right-to-left elision
   * would have cut exactly it.
   */
  it('never cuts the page number', () => {
    for (let width = 130; width <= 600; width += 10) {
      expect(
        footerLine(['A very long report title indeed', 'Confidential', 'Page 1 of 20'], width, measure),
      ).toContain('Page 1 of 20');
    }
  });

  it('fits inside the band it was given', () => {
    const parts = [
      'IRC 409A Valuation Report — Northwind Robotics, Inc. (SAMPLE)',
      'Confidential',
      'Page 1 of 20',
    ];
    for (let width = 200; width <= 900; width += 7) {
      expect(measure(footerLine(parts, width, measure))).toBeLessThanOrEqual(width);
    }
  });

  it('takes more from the longer field than from the shorter one', () => {
    const long = 'x'.repeat(60);
    const short = 'y'.repeat(10);
    const [a, b] = footerLine([long, short, 'Page 1 of 20'], 500, measure).split(' · ');
    expect(a!.length).toBeLessThan(long.length);
    expect(b!.length).toBeLessThan(short.length);
    // Proportional, so the field that was six times wider gives up more points.
    expect(long.length - a!.length).toBeGreaterThan(short.length - b!.length);
  });

  it('drops a field elided to nothing rather than printing a bare ellipsis', () => {
    const line = footerLine(['A long title', 'Confidential', 'Page 1 of 20'], 150, measure);
    expect(line).not.toMatch(/(^|·\s)…(\s·|$)/);
  });

  it('returns the page number alone when nothing else can be afforded', () => {
    expect(footerLine(['A long title', 'Confidential', 'Page 1 of 20'], 120, measure)).toBe('Page 1 of 20');
  });

  it('passes a single field through, since there is nothing it may cut', () => {
    expect(footerLine(['Page 1 of 20'], 10, measure)).toBe('Page 1 of 20');
    expect(footerLine([], 10, measure)).toBe('');
  });
});

describe('the running footer', () => {
  /** The footer band: the 8pt lines in the bottom inch of the sheet. */
  const footerLines = (pdf: Buffer): Line[][] =>
    pageLines(pdf).map((page) => page.filter((l) => l.baseline < 60 && l.size < 9));

  it('is one line on every page, however long the fields are', async () => {
    const pdf = await renderReportPdf(
      base({
        title: 'IRC 409A Valuation Report — Northwind Robotics, Inc. (SAMPLE)',
        confidentiality:
          'SAMPLE — illustrative only, not a valuation opinion and not to be relied upon by any person',
        sections: Array.from({ length: 6 }, (_, i) => ({
          heading: `Section ${i + 1}`,
          html: '<p>Body.</p>'.repeat(40),
        })),
      }),
    );

    const pages = footerLines(pdf);
    expect(pages.length).toBeGreaterThan(3);
    for (const [i, lines] of pages.entries()) {
      expect(baselines(lines), `page ${i + 1} footer wrapped`).toHaveLength(1);
    }
  });

  it('keeps the page number whole on every page', async () => {
    const pdf = await renderReportPdf(
      base({
        title: 'IRC 409A Valuation Report — Northwind Robotics, Inc. (SAMPLE)',
        confidentiality: 'SAMPLE — illustrative only, not a valuation opinion',
        sections: Array.from({ length: 4 }, (_, i) => ({
          heading: `Section ${i + 1}`,
          html: '<p>Body.</p>'.repeat(40),
        })),
      }),
    );

    const pages = footerLines(pdf);
    for (const [i, lines] of pages.entries()) {
      expect(lines.map((l) => l.text).join(''), `page ${i + 1}`).toContain(
        `Page ${i + 1} of ${pages.length}`,
      );
    }
  });

  /** Nothing is cut when the fields fit, which is the ordinary report. */
  it('leaves an ordinary footer uncut', async () => {
    const pdf = await renderReportPdf(base({ confidentiality: 'Confidential' }));
    const text = footerLines(pdf)
      .flat()
      .map((l) => l.text)
      .join('');
    // `runningTitle` prefixes the company when the title does not carry it.
    expect(text).toContain('Northwind Robotics, Inc. — IRC 409A Valuation Report');
    expect(text).toContain('Confidential');
    expect(text).not.toContain('…');
  });
});

describe('the running head', () => {
  /** The head band: the 8pt lines in the top inch of the sheet. */
  const headLines = (pdf: Buffer): Line[][] =>
    pageLines(pdf).map((page) => page.filter((l) => l.baseline > 720 && l.size < 9));

  it('elides a section heading into its half of the band rather than wrapping it', async () => {
    const heading =
      'Reconciliation of the Income, Market and Asset Approaches and the Weights Assigned to Each Indication of Value';
    const pdf = await renderReportPdf(base({ sections: [{ heading, html: '<p>Body.</p>'.repeat(60) }] }));

    const pages = headLines(pdf).filter((lines) => lines.length > 0);
    expect(pages.length).toBeGreaterThan(0);
    for (const [i, lines] of pages.entries()) {
      expect(baselines(lines), `page ${i + 1} head wrapped`).toHaveLength(1);
      // Each field keeps to its own half.
      const company = lines.find((l) => l.text.includes('Northwind'));
      expect(company, 'the company name left the head').toBeDefined();
    }
    // Cut, not dropped: the reader is still told which section they are in.
    expect(
      headLines(pdf)
        .flat()
        .map((l) => l.text)
        .join(''),
    ).toContain('…');
  });
});

describe('the draft stamp', () => {
  const stampLines = (pdf: Buffer): Line[] =>
    pageLines(pdf)
      .flat()
      .filter((l) => l.size > 20 && l.text.includes('DISTRIBUTE'));

  it('is set smaller so a long stamp fits on one line instead of wrapping', async () => {
    const short = await renderReportPdf(base({ watermark: 'Draft' }));
    const long = await renderReportPdf(base({ watermark: 'Preliminary — do not distribute' }));

    const stamped = stampLines(long);
    expect(stamped.length).toBeGreaterThan(0);
    for (const line of stamped) expect(line.text).toBe('PRELIMINARY — DO NOT DISTRIBUTE');

    const size = (pdf: Buffer, word: string) =>
      pageLines(pdf)
        .flat()
        .find((l) => l.size > 20 && l.text.includes(word))!.size;
    // The short one is untouched at the maximum; the long one is stepped down.
    expect(size(short, 'DRAFT')).toBe(96);
    expect(size(long, 'DISTRIBUTE')).toBeLessThan(96);
    expect(size(long, 'DISTRIBUTE')).toBeGreaterThanOrEqual(28);
  });

  it('still says the word, so a stamped page is still recognisable as stamped', async () => {
    const pdf = await renderReportPdf(base({ watermark: 'Preliminary — do not distribute' }));
    expect(extractText(pdf)).toContain('PRELIMINARY');
  });
});

describe('a contents entry', () => {
  const LONG =
    'Reconciliation of the Income, Market and Asset Approaches and the Weights Assigned to Each Indication of Value';

  it('stays on one line and leaves its page number in place', async () => {
    const pdf = await renderReportPdf(
      base({ include_toc: true, sections: [{ heading: LONG, html: '<p>Body.</p>' }] }),
    );

    const page = pageLines(pdf).find((p) => p.some((l) => l.text.includes('Table of Contents')))!;
    const entry = page.filter((l) => l.size === 11 && !l.text.startsWith('.'));
    // The heading and its page number, on one baseline between them.
    expect(baselines(entry.filter((l) => l.text.includes('Reconciliation')))).toHaveLength(1);
    expect(entry.map((l) => l.text).join('')).toContain('…');
  });

  /**
   * The leader has to start where the label ends. Measuring the whole heading
   * and drawing a shortened one would open a gap; the dots are what carry the
   * eye across, and a gap is where it falls off.
   */
  it('starts its dot leader against the text that was actually drawn', async () => {
    const pdf = await renderReportPdf(
      base({ include_toc: true, sections: [{ heading: LONG, html: '<p>Body.</p>' }] }),
    );
    const page = pageLines(pdf).find((p) => p.some((l) => l.text.includes('Table of Contents')))!;
    const label = page.find((l) => l.text.includes('Reconciliation'));
    const dots = page.find((l) => l.text.startsWith('..') && l.baseline === label?.baseline);
    // Either the label filled the row and there are no dots at all, or they
    // begin within a few points of where it ended.
    if (dots) expect(dots.x).toBeLessThan(label!.x + 500);
  });

  /** The announced entry is the whole heading, not the heading as far as it fitted. */
  it('announces the heading in full even when the drawn label is cut', async () => {
    const pdf = await renderReportPdf(
      base({ include_toc: true, sections: [{ heading: LONG, html: '<p>Body.</p>' }] }),
    );
    expect(pdf.toString('latin1')).toContain('ActualText');
  });
});

describe('a chart label', () => {
  it('is cut to its slot rather than wrapped over the bars beneath it', async () => {
    const pdf = await renderReportPdf(
      base({
        sections: [
          {
            heading: 'Reconciliation',
            html: '<p>Body.</p>',
            charts: [
              {
                type: 'bar',
                title: 'Indications',
                points: [
                  {
                    label:
                      'Income approach — discounted cash flow, weighted at sixty per cent of the concluded value',
                    value: 26_005_186,
                    display: '$26,005,186',
                  },
                  { label: 'Market approach', value: 24_100_000, display: '$24,100,000' },
                ],
              },
            ],
          },
        ],
      } as Partial<ReportPdfInput>),
    );

    const label = pageLines(pdf)
      .flat()
      .filter((l) => l.text.includes('Income approach'));
    expect(label.length).toBeGreaterThan(0);
    expect(baselines(label)).toHaveLength(1);
    expect(label[0]!.text).toContain('…');
  });
});
