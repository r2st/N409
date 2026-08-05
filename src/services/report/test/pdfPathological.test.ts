import { describe, expect, it } from 'vitest';
import { breakLongRuns, htmlToBlocks, renderReportPdf, type ReportPdfInput } from '../src/pdf.js';

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
 * and 52s of one pinned CPU. The valuation service renders in-process, so that
 * is every other request on the box waiting.
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
    const html = '<p'.repeat(SECTION_LIMIT / 2 - 1);
    const started = Date.now();
    const blocks = htmlToBlocks(html);
    expect(Date.now() - started).toBeLessThan(1_000);
    // A `<` that starts no tag is text, and the text has to survive.
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('scales linearly rather than quadratically as the input doubles', () => {
    const cost = (n: number) => {
      const html = '<p'.repeat(n);
      const started = Date.now();
      htmlToBlocks(html);
      return Date.now() - started;
    };
    cost(2_000); // warm up, so the first measurement is not paying for JIT
    // Quadratic would be ~16x across this 4x span; the budget catches a return
    // of the exponent without pinning the constant.
    expect(cost(60_000)).toBeLessThan(Math.max(cost(15_000), 5) * 8);
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
    expect(pdf.toString('latin1')).not.toContain('­');
  });
});
