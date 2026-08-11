import { describe, expect, it } from 'vitest';
import { faceCovers, fontSafe, renderReportPdf, type ReportPdfInput } from '../src/pdf.js';
import { pageTexts } from './support/pdfText.js';

/**
 * Two defects found by rendering a real 409A and reading it, rather than by
 * reading the renderer. Both were on the pages a board actually looks at.
 *
 * 1. The renderer set type in the standard-14 Helvetica, whose encoding is
 *    WinAnsi — 224 characters. Everything else was transliterated, or replaced
 *    with `?`, or worse: pdfkit does not fail on a character the encoding
 *    cannot carry, it emits a byte regardless. The executive summary's key
 *    assumptions printed as `<2c"RrT 4.00y` where they meant `σ 62% · T 4.00y`,
 *    every negative figure in the value-bridge chart lost its minus sign, a
 *    rupee amount lost its currency, and a company named in any script but
 *    Latin lost its name. The renderer embeds DejaVu Sans now, and these tests
 *    are what says so.
 *
 * 2. The cover's fact block was anchored at a fixed `page.height - 250`, which
 *    fitted the five facts a cover carried when that line was written. A 409A
 *    now carries seven, the block ran past the bottom margin, and pdfkit did
 *    the only thing it can: it broke the page. Every 409A this platform
 *    produced had a cover ending in "CURRENCY" and a second page beginning
 *    with "USD".
 */

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

describe('fontSafe — what the embedded face can actually draw', () => {
  it('leaves the symbols this domain reaches for exactly as the author wrote them', () => {
    // These used to be transliterated — `σ` to the word `sigma` — because the
    // font could not draw them. It can, so a report that says sigma prints the
    // letter, and the model in the exhibit is the model as it is written down.
    expect(fontSafe('σ 62%')).toBe('σ 62%');
    expect(fontSafe('β 1.2')).toBe('β 1.2');
    expect(fontSafe('2Φ(v/2) − 1')).toBe('2Φ(v/2) − 1');
    expect(fontSafe('σ × (S/V) × ∂V/∂S')).toBe('σ × (S/V) × ∂V/∂S');
    expect(fontSafe('DLOM ≤ 35%')).toBe('DLOM ≤ 35%');
  });

  it('keeps the typographic minus that every value bridge is written with', () => {
    // U+2212. Indistinguishable from a hyphen on the page and unrepresentable
    // in WinAnsi, which is how every negative figure in the bridge came out
    // corrupt.
    expect(fontSafe('−$0.1410')).toBe('−$0.1410');
  });

  it('keeps every currency sign a valuation might be denominated in', () => {
    // The four that were `?` before this: rupee, won, shekel, dong. A 409A for
    // a company with an Indian subsidiary quotes INR in its financial analysis,
    // and `?1,20,00,000` is not a number anyone can act on.
    for (const sign of ['₹', '₩', '₪', '₫', '₽', '₺', '₴', '฿', '€', '£', '¥', '$']) {
      expect(fontSafe(`${sign}1,200`), `${sign} is not drawable`).toBe(`${sign}1,200`);
    }
  });

  it('keeps a company name that is not written in Latin script', () => {
    // A subject company's legal name is the one string in a valuation report
    // that may not be paraphrased, transliterated or approximated.
    expect(fontSafe('ООО «Ромашка»')).toBe('ООО «Ромашка»');
    expect(fontSafe('Ελληνική Τεχνολογία ΑΕ')).toBe('Ελληνική Τεχνολογία ΑΕ');
    expect(fontSafe('חברת טכנולוגיה בע״מ')).toBe('חברת טכנולוגיה בע״מ');
    expect(fontSafe('Šiaurės Technologijos UAB')).toBe('Šiaurės Technologijos UAB');
  });

  it('leaves the punctuation a word processor produces', () => {
    const carried = '— · × ± é £ € ’ “ ” … ² ½ ‑ ‚ „';
    expect(fontSafe(carried)).toBe(carried);
  });

  it('replaces a character the face has no glyph for, visibly', () => {
    // DejaVu Sans has no Han glyphs, so a CJK name is still lost — but it is
    // lost as a row of question marks rather than as the blank boxes pdfkit
    // would otherwise draw, which is the difference between a defect somebody
    // notices and one that ships. Closing this is a matter of registering a
    // face that covers CJK, not of changing a rule here.
    expect(fontSafe('株式会社')).toBe('????');
    expect(faceCovers('regular', '中'.codePointAt(0)!)).toBe(false);
  });

  it('counts an astral character once, not once per surrogate', () => {
    expect(fontSafe('a🙂b')).toBe('a?b');
  });

  it('answers for the face the run will actually be set in', () => {
    // Coverage is a property of a face, not of a family: DejaVu's oblique cuts
    // carry fewer scripts than its upright ones. Asking the wrong face is how a
    // string passes a check and then draws as boxes.
    const alef = 'ا'.codePointAt(0)!;
    expect(faceCovers('regular', alef)).toBe(true);
    expect(faceCovers('italic', alef)).toBe(false);
    expect(fontSafe('ا', 'regular')).toBe('ا');
    expect(fontSafe('ا', 'italic')).toBe('?');
  });

  it('drops zero-width characters whether or not the face can draw them', () => {
    // DejaVu does have glyphs for these — glyphs zero points wide. Drawing them
    // faithfully would carry an invisible character into a legal deliverable,
    // where it breaks search and copy-paste for a reader who cannot see why.
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
    // biggest source of unusual characters is the authored body — free text
    // pasted into a legal deliverable — and not this codebase at all.
    const pdf = await renderReportPdf(
      base({ sections: [{ heading: 'Volatility (σ)', html: '<p>Applied −$0.14 for DLOC.</p>' }] }),
      { compress: false },
    );
    const text = pageTexts(pdf).join('\n');
    expect(text).toContain('Volatility (σ)');
    expect(text).toContain('−$0.14');
  });

  it('sets an INR figure on the page as an INR figure', async () => {
    const pdf = await renderReportPdf(
      base({
        meta: [{ label: 'Currency', value: 'INR' }],
        sections: [{ heading: 'Financial analysis', html: '<p>FY-1 revenue of ₹1,20,00,000.</p>' }],
      }),
      { compress: false },
    );
    const text = pageTexts(pdf).join('\n');
    expect(text).toContain('₹1,20,00,000');
    expect(text).not.toContain('?1,20,00,000');
  });

  it('sets a non-Latin company name on the cover and in the running footer', async () => {
    // The name reaches the page three times — cover, footer, structure tree —
    // and used to be destroyed in all three.
    const pdf = await renderReportPdf(
      base({
        title: 'Отчёт об оценке — ООО «Ромашка»',
        company_name: 'ООО «Ромашка»',
        sections: [{ heading: 'Раздел', html: '<p>Текст раздела.</p>' }],
      }),
      { compress: false },
    );
    const pages = pageTexts(pdf);
    expect(pages[0]).toContain('ООО «Ромашка»');
    expect(pages[1]).toContain('Раздел');
    expect(pages.join('\n')).not.toContain('????');
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
