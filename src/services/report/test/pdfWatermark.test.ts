import { describe, expect, it } from 'vitest';
import { renderReportPdf, type ReportPdfInput } from '../src/pdf.js';
import { extractText, pageCount, pageTexts } from './support/pdfText.js';

/**
 * The draft stamp.
 *
 * A report becomes readable by the client at `drafted` — before the QA review
 * closes, before the signature, before publication — and until this existed the
 * bytes that reader downloaded were indistinguishable from the signed
 * deliverable. Those bytes get forwarded: to an auditor, into a board pack,
 * into a data room. Each of those readers takes an unmarked valuation report as
 * final, which is why marking the draft is the ordinary practice of the
 * profession.
 *
 * Rendered with `compress: false` throughout so the assertions can read the
 * text back out of the content streams — see `support/pdfText.ts`.
 */

const base: ReportPdfInput = {
  title: 'IRC 409A Valuation Report',
  company_name: 'Acme Robotics, Inc',
  meta: [{ label: 'Valuation date', value: '2026-06-30' }],
  sections: [
    { heading: 'Introduction', html: '<p>The engagement is described here.</p>' },
    { heading: 'Conclusion of Value', html: '<p>The concluded fair market value is stated here.</p>' },
  ],
};

describe('draft watermark', () => {
  it('stamps every page, cover and body alike', async () => {
    const pdf = await renderReportPdf({ ...base, watermark: 'Draft' }, { compress: false });
    const pages = pageTexts(pdf);
    expect(pages.length).toBeGreaterThan(1);
    for (const [i, text] of pages.entries()) {
      expect(text, `page ${i + 1} carries no stamp`).toContain('DRAFT');
    }
  });

  it('says so once in words, so a reader who cannot see the stamp is still told', async () => {
    const pdf = await renderReportPdf({ ...base, watermark: 'Draft' }, { compress: false });
    // The stamp is an artifact on every page; the cover notice is real tagged
    // text, and it is the only place the sentence appears.
    const notices = extractText(pdf).match(/subject to revision, not for distribution/g) ?? [];
    expect(notices).toHaveLength(1);
  });

  it('leaves the deliverable unmarked', async () => {
    for (const input of [base, { ...base, watermark: null }]) {
      const pdf = await renderReportPdf(input, { compress: false });
      expect(extractText(pdf)).not.toContain('DRAFT');
      expect(extractText(pdf)).not.toContain('subject to revision');
    }
  });

  it('upper-cases whatever word it is given', async () => {
    const pdf = await renderReportPdf({ ...base, watermark: 'preliminary' }, { compress: false });
    expect(pageTexts(pdf)[1]).toContain('PRELIMINARY');
    expect(extractText(pdf)).toContain('PRELIMINARY — subject to revision');
  });

  it('does not leak its opacity into the furniture drawn after it', async () => {
    // The stamp is drawn at eleven percent and the footer immediately after it
    // at full strength. pdfkit tracks fill opacity outside the graphics state
    // it saves, so a missing reset would fade every page footer in the report —
    // legible in a viewer, invisible in a test that only reads the text back.
    const pdf = await renderReportPdf({ ...base, watermark: 'Draft' }, { compress: false });
    const raw = pdf.toString('latin1');
    // Each ExtGState pdfkit emits for an alpha value is named and referenced;
    // the reset back to 1 has to be among them.
    const alphas = new Set(Array.from(raw.matchAll(/\/ca ([\d.]+)/g), (m) => m[1]!));
    expect(alphas.has('1')).toBe(true);
    expect([...alphas].some((a) => Number(a) > 0 && Number(a) < 0.5)).toBe(true);
  });

  it('costs the report no pages', async () => {
    const plain = await renderReportPdf(base, { compress: false });
    const draft = await renderReportPdf({ ...base, watermark: 'Draft' }, { compress: false });
    expect(pageCount(draft)).toBe(pageCount(plain));
  });
});
