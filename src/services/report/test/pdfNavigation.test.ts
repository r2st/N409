import { describe, expect, it } from 'vitest';
import {
  SUMMARY_DESTINATION,
  TOC_HEADING,
  renderReportPdf,
  sectionDestination,
  tocPageCount,
  type ReportPdfInput,
  type TocCapacity,
} from '../src/pdf.js';

/**
 * Getting around the document.
 *
 * A valuation report is read twice: once on paper by a board, and many times
 * on a screen by an auditor looking for one section. The contents page serves
 * the first reader; bookmarks, links and the document dictionary serve the
 * second, and none of them are visible on any page — which is exactly why they
 * rot silently unless something asserts on them.
 */

function extractText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  return Array.from(raw.matchAll(/<([0-9a-fA-F]+)>/g))
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
}

/** Text of each content stream, in the order the pages were written. */
function pageTexts(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  return Array.from(raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)).map((m) =>
    Array.from(m[1]!.matchAll(/<([0-9a-fA-F]+)>/g))
      .map((h) => Buffer.from(h[1]!, 'hex').toString('latin1'))
      .join(''),
  );
}

const outlineTitles = (pdf: Buffer): string[] =>
  Array.from(pdf.toString('latin1').matchAll(/\/Title \(([^)]*)\)/g)).map((m) => m[1]!);

const goToLinkCount = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/S \/GoTo/g) ?? []).length;

const infoValue = (pdf: Buffer, key: string): string | undefined => {
  const raw = pdf.toString('latin1');
  const ref = new RegExp(`/${key} (\\d+) 0 R`).exec(raw);
  if (!ref) return undefined;
  const obj = new RegExp(`\\n${ref[1]!} 0 obj\\n\\(([\\s\\S]*?)\\)\\nendobj`).exec(raw);
  return obj?.[1];
};

const base: ReportPdfInput = {
  title: 'IRC 409A Valuation Report',
  company_name: 'Acme Robotics, Inc',
  meta: [{ label: 'Valuation date', value: '2026-06-30' }],
  sections: [],
};

const withSections = (count: number): ReportPdfInput => ({
  ...base,
  sections: Array.from({ length: count }, (_, i) => ({
    heading: `Chapter ${i + 1}`,
    html: `<p>Body of chapter ${i + 1}.</p>`,
  })),
});

describe('tocPageCount', () => {
  const cap: TocCapacity = { first: 30, rest: 34 };

  it('needs one page while the entries fit on it', () => {
    expect(tocPageCount(1, cap)).toBe(1);
    expect(tocPageCount(30, cap)).toBe(1);
  });

  it('adds a continuation page as soon as they do not', () => {
    expect(tocPageCount(31, cap)).toBe(2);
    expect(tocPageCount(64, cap)).toBe(2);
    expect(tocPageCount(65, cap)).toBe(3);
  });

  it('terminates on a degenerate capacity rather than dividing by zero', () => {
    expect(tocPageCount(10, { first: 1, rest: 0 })).toBe(10);
  });
});

describe('a contents list too long for one page', () => {
  /*
   * The regression this pins: the contents page was reserved before the
   * sections were laid out, but filled afterwards, and the fill used the same
   * `ensureRoom` helper as body text. Overflowing entries therefore appended a
   * page — which pdfkit puts at the *end* of the document. A forty-section
   * report ended with a stray sheet of contents entries after the last
   * section, and since the page count had been read off the buffer before that
   * page existed, every footer read "of 8" across nine pages.
   */
  const LONG = 40;

  it('keeps every entry in the front matter', async () => {
    const pdf = await renderReportPdf(withSections(LONG), { compress: false });
    const pages = pageTexts(pdf);
    const lastEntry = `${LONG}. Chapter ${LONG}`;

    // The contents run over pages 2–3; the first body page comes after them.
    const contentsPages = pages.filter((p) => p.includes('Chapter 1.') || p.includes(TOC_HEADING));
    expect(pages[1]).toContain(TOC_HEADING);
    expect(pages[2]).toContain(lastEntry);
    expect(contentsPages.length).toBeGreaterThan(0);

    const firstBodyPage = pages.findIndex((p) => p.includes('Body of chapter 1.'));
    const lastEntryPage = pages.findIndex((p) => p.includes(lastEntry));
    expect(lastEntryPage).toBeLessThan(firstBodyPage);
  });

  it('counts the continuation page in the footer total', async () => {
    const pdf = await renderReportPdf(withSections(LONG), { compress: false });
    const text = extractText(pdf);
    const total = Number(/Page 1 of (\d+)/.exec(text)![1]);
    const rendered = (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(total).toBe(rendered);
  });

  it('stamps a footer on every page, including the continuation', async () => {
    const pdf = await renderReportPdf(withSections(LONG), { compress: false });
    const pages = pageTexts(pdf);
    pages.forEach((page, i) => {
      expect(page, `page ${i + 1} has no footer`).toMatch(/Page \d+ of \d+/);
    });
  });

  it('numbers entries against the front matter it actually occupies', async () => {
    // Cover + two contents pages = 3, so chapter 1 starts on page 4. An entry
    // numbered from a one-page assumption would say 3.
    //
    // Entries abut on the extracted text — the right-aligned page number runs
    // straight into the next entry's prefix — so the match is bounded by the
    // entry that follows rather than by a lazy quantifier.
    const contents = pageTexts(await renderReportPdf(withSections(LONG), { compress: false }))[1]!;
    const entry = /1\. Chapter 1\.+(\d+)2\. Chapter 2/.exec(contents);
    expect(entry).not.toBeNull();
    expect(Number(entry![1])).toBe(4);
  });
});

describe('bookmarks', () => {
  it('lists the contents, the summary and every section', async () => {
    const input: ReportPdfInput = {
      ...withSections(5),
      summary: { headline: { label: 'Fair market value per share', value: '$1.23' } },
    };
    const titles = outlineTitles(await renderReportPdf(input, { compress: false }));
    expect(titles.slice(0, 3)).toEqual(['Table of Contents', 'Executive Summary', '1. Chapter 1']);
    expect(titles).toContain('5. Chapter 5');
    expect(titles).toHaveLength(7);
  });

  it('is still produced for a report with no contents page', async () => {
    const titles = outlineTitles(
      await renderReportPdf({ ...withSections(2), include_toc: false }, { compress: false }),
    );
    expect(titles).toEqual(['1. Chapter 1', '2. Chapter 2']);
  });
});

describe('contents entries are links', () => {
  it('registers a destination for every section and the summary', async () => {
    const input: ReportPdfInput = {
      ...withSections(4),
      summary: { headline: { label: 'FMV per share', value: '$1.23' } },
    };
    const raw = (await renderReportPdf(input, { compress: false })).toString('latin1');
    expect(raw).toContain(SUMMARY_DESTINATION);
    for (let i = 0; i < 4; i += 1) expect(raw).toContain(sectionDestination(i));
  });

  it('links both the heading and the page number of each entry', async () => {
    const input: ReportPdfInput = {
      ...withSections(4),
      summary: { headline: { label: 'FMV per share', value: '$1.23' } },
    };
    // Five entries (summary + four sections), each clickable in two places.
    expect(goToLinkCount(await renderReportPdf(input, { compress: false }))).toBe(10);
  });

  it('adds no link annotations when there is no contents page', async () => {
    const pdf = await renderReportPdf({ ...withSections(2), include_toc: false }, { compress: false });
    expect(goToLinkCount(pdf)).toBe(0);
  });
});

describe('document metadata', () => {
  it('carries the facts a document management system indexes on', async () => {
    const pdf = await renderReportPdf(withSections(2), { compress: false });
    expect(infoValue(pdf, 'Title')).toBe('IRC 409A Valuation Report');
    expect(infoValue(pdf, 'Author')).toBe('N409');
    expect(infoValue(pdf, 'Creator')).toBe('N409');
    expect(infoValue(pdf, 'Producer')).toBe('N409 report service');
    expect(infoValue(pdf, 'Keywords')).toBe('Acme Robotics, Inc, IRC 409A Valuation Report, valuation');
  });

  it('names the preparing firm as author on a white-label report', async () => {
    const pdf = await renderReportPdf(
      { ...withSections(2), branding: { partner_name: 'Meridian Advisory LLP' } },
      { compress: false },
    );
    expect(infoValue(pdf, 'Author')).toBe('Meridian Advisory LLP');
  });

  it('accepts explicit keywords', async () => {
    const pdf = await renderReportPdf(
      { ...withSections(2), keywords: ['409A', 'ASC 718', 'Acme'] },
      { compress: false },
    );
    expect(infoValue(pdf, 'Keywords')).toBe('409A, ASC 718, Acme');
  });

  it('records the report generation time rather than the render time', async () => {
    // A re-download months later must not restamp the document as new.
    const pdf = await renderReportPdf(
      { ...withSections(2), generated_at: new Date('2026-06-30T09:15:00Z') },
      { compress: false },
    );
    expect(infoValue(pdf, 'CreationDate')).toBe('D:20260630091500Z');
  });

  it('declares a document language and asks viewers to show the title', async () => {
    // Both are accessibility requirements a corporate PDF checker will flag:
    // without /Lang a screen reader guesses the language from the locale, and
    // without DisplayDocTitle the window bar shows the download filename.
    const raw = (await renderReportPdf(withSections(2), { compress: false })).toString('latin1');
    expect(raw).toContain('/Lang (en-US)');
    expect(raw).toContain('/DisplayDocTitle true');
  });
});
