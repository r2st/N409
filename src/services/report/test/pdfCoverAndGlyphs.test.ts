import { describe, expect, it } from 'vitest';
import { fontSafe, renderReportPdf, type ReportPdfInput } from '../src/pdf.js';

/**
 * Two defects found by rendering a real 409A and reading it, rather than by
 * reading the renderer. Both were on the pages a board actually looks at.
 *
 * 1. The renderer sets type in the standard-14 Helvetica, whose encoding is
 *    WinAnsi. pdfkit does not fail on a character that encoding cannot carry —
 *    it emits a byte regardless. The executive summary's key assumptions
 *    printed as `<2c"RrT 4.00y` where they meant `σ 62% · T 4.00y`, and every
 *    negative figure in the value-bridge chart lost its minus sign.
 *
 * 2. The cover's fact block was anchored at a fixed `page.height - 250`, which
 *    fitted the five facts a cover carried when that line was written. A 409A
 *    now carries seven, the block ran past the bottom margin, and pdfkit did
 *    the only thing it can: it broke the page. Every 409A this platform
 *    produced had a cover ending in "CURRENCY" and a second page beginning
 *    with "USD".
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

/**
 * The 0x80–0x9F range where CP1252 differs from Latin-1 — the em dash, the
 * curly quotes, the ellipsis. Node has no CP1252 decoder, and reading those
 * bytes as Latin-1 turns an em dash into an unprintable control character, so
 * an assertion written with the character an author typed would fail against a
 * PDF that is correct.
 */
const CP1252_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

const decodeCp1252 = (bytes: Buffer): string =>
  Array.from(bytes)
    .map((b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : String.fromCharCode(b)))
    .join('');

const shown = (hexRun: string): string =>
  Array.from(hexRun.matchAll(/<([0-9a-fA-F]+)>/g))
    .map((m) => decodeCp1252(Buffer.from(m[1]!, 'hex')))
    .join('');

const pageTexts = (pdf: Buffer): string[] => contentStreams(pdf).map(shown);

const COVER_META = [
  { label: 'Engagement', value: '01J8Z9WQ5T7K2M4N6P8R0S1V3X' },
  { label: 'Kind', value: '409a' },
  { label: 'Valuation date', value: '2026-06-30' },
  { label: 'Template', value: '409a.v55' },
  { label: 'Version', value: 'v1' },
  { label: 'Currency', value: 'USD' },
  { label: 'Rendered', value: '2026-08-09' },
];

const base = (over: Partial<ReportPdfInput> = {}): ReportPdfInput => ({
  title: 'IRC 409A Valuation Report — Northwind Robotics, Inc.',
  company_name: 'Northwind Robotics, Inc.',
  meta: COVER_META,
  include_toc: false,
  sections: [{ heading: 'Section', html: '<p>Body.</p>' }],
  ...over,
});

describe('fontSafe — what the standard-14 fonts can actually draw', () => {
  it('transliterates the symbols this domain reaches for', () => {
    // Spelled out rather than dropped: a bare `s` next to a percentage reads as
    // a typo, where `sigma` reads as the symbol it stands in for.
    expect(fontSafe('σ 62%')).toBe('sigma 62%');
    expect(fontSafe('β 1.2')).toBe('beta 1.2');
  });

  it('turns the typographic minus into one the font has', () => {
    // U+2212, indistinguishable from a hyphen on the page, and the reason every
    // negative figure in the value bridge was corrupt.
    expect(fontSafe('−$0.1410')).toBe('-$0.1410');
  });

  it('leaves the punctuation the encoding already carries', () => {
    // WinAnsi is CP1252: the em dash, the middot, curly quotes, ×, ±, é and the
    // currency signs are all present, and rewriting them would make the
    // typography worse to fix a problem that does not exist.
    const carried = '— · × ± é £ € ’ “ ” … ² ½';
    expect(fontSafe(carried)).toBe(carried);
  });

  it('replaces a character no substitution names, visibly', () => {
    // A report body is analyst-authored free text and can hold anything a paste
    // produces. `?` is the honest outcome: wrong in a way somebody notices,
    // rather than a plausible glyph that is silently the wrong one.
    expect(fontSafe('株式会社')).toBe('????');
  });

  it('counts an astral character once, not once per surrogate', () => {
    expect(fontSafe('a🙂b')).toBe('a?b');
  });

  it('drops zero-width characters rather than emitting a byte for them', () => {
    // They draw nothing by definition, so a substitution would add a mark the
    // author did not ask for.
    expect(fontSafe('a​b﻿c')).toBe('abc');
  });

  it('keeps the layout whitespace pdfkit acts on', () => {
    expect(fontSafe('a\nb\tc')).toBe('a\nb\tc');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The fair market value of one share of common stock is $1.2242.';
    expect(fontSafe(prose)).toBe(prose);
  });

  it('reaches text the renderer draws, wherever it came from', async () => {
    // The interception is on the document, not on the call sites, because the
    // biggest source of unrepresentable characters is the authored body — free
    // text pasted into a legal deliverable — and not this codebase at all.
    const pdf = await renderReportPdf(
      base({ sections: [{ heading: 'Volatility (σ)', html: '<p>Applied −$0.14 for DLOC.</p>' }] }),
      { compress: false },
    );
    const text = pageTexts(pdf).join('\n');
    expect(text).toContain('Volatility (sigma)');
    expect(text).toContain('-$0.14');
    // And nothing raw survived: a σ that reached the content stream would be
    // there as the mangled byte, which is the bug.
    expect(text).not.toContain('σ');
  });
});

describe('the cover fits on the cover', () => {
  const coverText = async (meta: ReportPdfInput['meta']) => {
    const pdf = await renderReportPdf(base({ meta }), { compress: false });
    return pageTexts(pdf);
  };

  it('keeps all seven facts of a 409A on page one', async () => {
    const pages = await coverText(COVER_META);
    for (const item of COVER_META) {
      expect(pages[0], `"${item.label}" left the cover`).toContain(item.value);
    }
  });

  it('keeps a label and its value together', async () => {
    // The specific failure: page one ended with "CURRENCY" and page two began
    // with "USD", so the cover named a fact it did not state.
    const pages = await coverText(COVER_META);
    expect(pages[0]).toContain('CURRENCY');
    expect(pages[1] ?? '').not.toContain('USD');
  });

  it('still fits when a fact is added', async () => {
    // The fixed anchor was correct for the cover it was written against and
    // wrong one fact later. The block is measured now, so the guard is that
    // growth keeps working rather than that today's count happens to fit.
    const pages = await coverText([
      ...COVER_META,
      { label: 'Prepared by', value: 'Northwind Valuation Partners LLP' },
      { label: 'Report number', value: 'NR-2026-0184' },
    ]);
    expect(pages[0]).toContain('NR-2026-0184');
  });

  it('renders a cover with no facts at all', async () => {
    const pages = await coverText([]);
    expect(pages[0]).toContain('Northwind Robotics, Inc.');
  });
});

describe('the running footer names the document once', () => {
  const footers = async (input: ReportPdfInput) =>
    pageTexts(await renderReportPdf(input, { compress: false }));

  it('does not repeat a company name the title already carries', async () => {
    // `domain/report.ts` generates `${template.name} — ${company}` as the
    // default title, so the old `${company} — ${title}` footer read the company
    // name twice on every page of every report the platform produced.
    const pages = await footers(base());
    const footer = pages[1] ?? pages[0]!;
    expect(footer).toContain('IRC 409A Valuation Report — Northwind Robotics, Inc. · Confidential');
    expect(footer.match(/Northwind Robotics, Inc\./g)?.length ?? 0).toBeLessThan(3);
  });

  it('still prefixes the company when a retyped title omits it', async () => {
    // A loose page's only claim to an owner is this line, so losing it is the
    // worse of the two failures.
    const pages = await footers(base({ title: 'Annual Valuation' }));
    const footer = pages[1] ?? pages[0]!;
    expect(footer).toContain('Northwind Robotics, Inc. — Annual Valuation');
  });
});
