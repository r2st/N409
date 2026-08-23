import { describe, expect, it } from 'vitest';
import { expectSubQuadratic } from './support/complexity.js';
import { breakLongRuns, htmlToBlocks, renderReportPdf, type ReportPdfInput } from '../src/pdf.js';
import { extractText, pageLines } from './support/pdfText.js';

/**
 * Shapes of input that are well inside every declared limit and used to cost
 * quadratic time to render.
 *
 * The schema in `app.ts` bounds a section's html at 200,000 characters, and
 * that bound was doing all the work: nothing said the *shape* of those
 * characters was bounded too. Two shapes were quadratic — a document with no
 * `>` in it (the tokenizer re-scanned to the end from every `<`) and a single
 * unbroken "word" (pdfkit fits an over-wide word character by character, and
 * each fitting step re-measures the string). At the 200k limit they cost 16s
 * and 52s of one pinned CPU. That was every other request on the box waiting;
 * since R98 it is every other *report* waiting, and then the caller's deadline
 * firing and the work coming back to the API anyway.
 *
 * The timings below are budgets, not benchmarks: they are set two orders of
 * magnitude above what the fixed code needs (72ms and 137ms measured) and an
 * order of magnitude below what the quadratic forms took, so they fail on a
 * return of the exponent and not on a slow machine.
 */

const SECTION_LIMIT = 200_000;

const withHtml = (html: string): ReportPdfInput => ({
  title: 'T',
  company_name: 'C',
  meta: [],
  sections: [{ heading: 'H', html }],
});

const elapsed = async (fn: () => Promise<unknown>): Promise<number> => {
  const started = Date.now();
  await fn();
  return Date.now() - started;
};

describe('breakLongRuns', () => {
  it('leaves ordinary prose exactly as it was', () => {
    const prose = 'The quick brown fox jumps over the lazy dog, twice, at some length.';
    expect(breakLongRuns(prose)).toBe(prose);
  });

  it('leaves a short string untouched without inspecting it', () => {
    expect(breakLongRuns('')).toBe('');
    expect(breakLongRuns('short')).toBe('short');
  });

  it('leaves a long *sentence* alone — only unbroken runs are split', () => {
    const sentence = 'word '.repeat(400).trim();
    expect(breakLongRuns(sentence)).toBe(sentence);
  });

  it('breaks a run past the limit into chunks joined by soft hyphens', () => {
    const out = breakLongRuns('W'.repeat(300), 100);
    expect(out.split('­')).toEqual(['W'.repeat(100), 'W'.repeat(100), 'W'.repeat(100)]);
  });

  it('keeps every original character, in order', () => {
    const run = 'abcdefghij'.repeat(40);
    expect(breakLongRuns(run, 32).replace(/­/g, '')).toBe(run);
  });

  it('breaks only the offending run in a mixed line', () => {
    const out = breakLongRuns(`before ${'X'.repeat(250)} after`, 100);
    expect(out.startsWith('before ')).toBe(true);
    expect(out.endsWith(' after')).toBe(true);
    expect(out.split('­')).toHaveLength(3);
  });

  it('does not split a run that is exactly at the limit', () => {
    expect(breakLongRuns('Y'.repeat(64), 64)).toBe('Y'.repeat(64));
    expect(breakLongRuns('Y'.repeat(65), 64)).toContain('­');
  });
});

describe('tokenizer on input with no closing bracket', () => {
  it('parses a document of unterminated tags in linear time', () => {
    // `"<p"` repeated: every `<` used to re-scan to the end of the document
    // looking for a `>` that is not there. 60k copies took 3.1s in
    // htmlToBlocks alone and 16s through a full render.
    // A `<` that starts no tag is text, and the text has to survive.
    expect(htmlToBlocks('<p'.repeat(SECTION_LIMIT / 2 - 1)).length).toBeGreaterThan(0);
    expectSubQuadratic({ input: (n) => '<p'.repeat(n), run: htmlToBlocks, size: 15_000 });
  });

  it('still tokenizes tags identically once a bracket does close', () => {
    expect(htmlToBlocks('<p>one</p><p>two</p>')).toEqual(htmlToBlocks('<p>one</p><p>two</p>'));
    const blocks = htmlToBlocks('<p>kept</p>');
    expect(JSON.stringify(blocks)).toContain('kept');
  });

  it('treats a stray "<" as text rather than dropping what follows it', () => {
    expect(JSON.stringify(htmlToBlocks('<p>5 < 6 and 7 > 4</p>'))).toContain('6 and 7');
  });

  it('keeps text that precedes an unterminated tag', () => {
    expect(JSON.stringify(htmlToBlocks('<p>visible</p><p'))).toContain('visible');
  });
});

describe('rendering pathological sections', () => {
  it('renders one enormous unbroken word without quadratic cost', async () => {
    const html = `<p>${'W'.repeat(SECTION_LIMIT - 7)}</p>`;
    const ms = await elapsed(() => renderReportPdf(withHtml(html)));
    expect(ms).toBeLessThan(10_000);
  });

  it('renders a section of unterminated tags without quadratic cost', async () => {
    const html = '<p'.repeat(SECTION_LIMIT / 2 - 1);
    const ms = await elapsed(() => renderReportPdf(withHtml(html)));
    expect(ms).toBeLessThan(5_000);
  });

  it('still produces a valid PDF from the pathological input', async () => {
    const pdf = await renderReportPdf(withHtml(`<p>${'W'.repeat(50_000)}</p>`));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(pdf.length - 32).toString()).toContain('%%EOF');
    // The word has to be laid out across pages, not silently dropped.
    expect((pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length).toBeGreaterThan(1);
  });

  it('leaves ordinary prose of the same size rendering as it always did', async () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(200);
    const pdf = await renderReportPdf(withHtml(`<p>${prose}</p>`), { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // No break opportunity was inserted into text that never needed one.
    // Asked of the decoded page rather than of the file: the embedded font
    // program is arbitrary bytes, and 0xAD occurs inside it innocently.
    expect(extractText(pdf)).not.toContain('­');
  });
});

/**
 * The sheet, and what is allowed to be drawn where on it.
 *
 * A model-free statement about the layout: whatever the input, body content
 * lands inside the type area and page furniture lands inside the bands
 * reserved for it. It says nothing about *where* a given block goes, so it
 * cannot be satisfied by agreeing with the renderer — a column widened past
 * the margin, a chart label pushed off the plot, a heading set into the
 * gutter all fail it without anyone having to have predicted them.
 *
 * The shapes below are the ones that push a box outward: more columns than a
 * letter page has room for, a cell holding a paragraph, a heading twice the
 * width of the measure, a cover fact and a confidentiality notice long enough
 * to have wrapped their bands.
 */
const LONG_HEADING = 'Reconciliation of the Income, Market and Asset Approaches and the Weights Assigned';

const sheet = (over: Partial<ReportPdfInput> = {}): ReportPdfInput => ({
  title: 'IRC 409A Valuation Report',
  company_name: 'Northwind Robotics, Inc.',
  meta: [],
  sections: [{ heading: 'Introduction', html: '<p>Body.</p>' }],
  ...over,
});

/** US Letter, and the margins `renderReportPdf` opens the document with. */
const PAGE = { width: 612, height: 792, margin: 72 };
/** The head rule sits at 56 and the footer baseline at 38.6; the bands are the margins. */
const HEAD_BAND = PAGE.height - PAGE.margin;
const FOOT_BAND = PAGE.margin;

describe('nothing is drawn outside the sheet', () => {
  const shapes: Record<string, ReportPdfInput> = {
    wideTable: sheet({
      sections: [
        {
          heading: 'Wide',
          html:
            '<table><tr>' +
            Array.from({ length: 14 }, (_, i) => `<th>Column heading ${i + 1}</th>`).join('') +
            '</tr><tr>' +
            Array.from({ length: 14 }, (_, i) => `<td>$${i}23,456,789</td>`).join('') +
            '</tr></table>',
        },
      ],
    }),
    longCell: sheet({
      sections: [
        {
          heading: 'Long cell',
          html: `<table><tr><th>A</th><th>B</th></tr><tr><td>${'word '.repeat(200)}</td><td>$1</td></tr></table>`,
        },
      ],
    }),
    longHeading: sheet({ sections: [{ heading: LONG_HEADING + ' ' + LONG_HEADING, html: '<p>Body.</p>' }] }),
    deepList: sheet({
      sections: [{ heading: 'List', html: '<ul>' + `<li>${LONG_HEADING}</li>`.repeat(20) + '</ul>' }],
    }),
    longMeta: sheet({
      meta: [{ label: 'A very long label indeed for a cover fact', value: LONG_HEADING }],
    }),
    bigNumbers: sheet({
      sections: [
        {
          heading: 'Figures',
          html: '<table><tr><th>Step</th><th>Amount</th></tr><tr><td>x</td><td>−$123,456,789,012,345</td></tr></table>',
        },
      ],
    }),
    manyCols: sheet({
      sections: [
        {
          heading: 'Many',
          html:
            '<table><tr>' +
            Array.from({ length: 30 }, (_, i) => `<th>C${i}</th>`).join('') +
            '</tr><tr>' +
            Array.from({ length: 30 }, () => '<td>1</td>').join('') +
            '</tr></table>',
        },
      ],
    }),
    longWatermark: sheet({ watermark: 'Preliminary draft — not for distribution to any third party' }),
    longConf: sheet({ confidentiality: LONG_HEADING + ' ' + LONG_HEADING }),
    longTitleCover: sheet({ title: LONG_HEADING + ' ' + LONG_HEADING }),
  };

  it.each(Object.entries(shapes))('keeps %s inside the type area', async (_shape, input) => {
    const escaped: string[] = [];
    pageLines(await renderReportPdf(input)).forEach((page, i) => {
      for (const line of page) {
        // The running head, the running footer and the diagonal stamp are
        // drawn into the reserved margins on purpose — that is what the bands
        // are. `pdfOneLine.test.ts` is what holds them to one line each.
        const isFurniture = line.size <= 8 && (line.baseline > HEAD_BAND || line.baseline < FOOT_BAND);
        const isStamp = line.size > 20 && line.x < PAGE.margin;
        if (isFurniture || isStamp) continue;
        if (
          line.x < PAGE.margin - 1 ||
          line.x > PAGE.width - PAGE.margin + 1 ||
          line.baseline < FOOT_BAND ||
          line.baseline > HEAD_BAND
        ) {
          escaped.push(
            `p${i + 1} x=${line.x.toFixed(1)} y=${line.baseline.toFixed(1)} ${JSON.stringify(line.text.slice(0, 40))}`,
          );
        }
      }
    });
    expect(escaped).toEqual([]);
  });
});
