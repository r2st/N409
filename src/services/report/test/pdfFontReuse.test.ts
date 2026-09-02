import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { renderReportPdf, type ReportPdfInput } from '../src/pdf.js';

/**
 * R358, methodology M8 — pdfkit was re-reading and re-parsing the four faces
 * for every document.
 *
 * `registerFont` takes a path, a buffer or an already-open fontkit font. It was
 * handed the path, so every render did four synchronous `readFileSync` calls on
 * the event loop of a service whose entire job is rendering, and then parsed
 * four TrueType files this process had already parsed and was holding open in
 * `openFaces` for its own glyph-coverage question.
 *
 * Two assertions, because either alone is satisfiable by a wrong fix: what
 * `registerFont` is handed (the work that was removed — a path is the
 * instruction to read and parse, an open face is not), and that the bytes are
 * unchanged (the thing the removal must not cost). The second is the important
 * one — the shared face is read by `EmbeddedFont`, which takes a subset of its
 * own per document, and a font object that turned out to carry per-document
 * state would corrupt the second deliverable rendered by the process rather
 * than fail.
 *
 * Counting `readFileSync` calls would have been the obvious first assertion and
 * is not available: pdfkit is bundled and holds its own reference to `fs`, so a
 * spy on the module object never sees them and the test passes over the defect.
 */

const INPUT: ReportPdfInput = {
  title: '409A Valuation Report',
  company_name: 'Acme Robotics, Inc.',
  meta: [{ label: 'Valuation date', value: '2026-06-30' }],
  generated_at: new Date('2026-01-02T03:04:05Z'),
  sections: [
    { heading: 'Introduction', html: '<p>Scope of the engagement.</p>' },
    {
      heading: 'Conclusion of Value',
      html: '<p>The concluded fair market value is <strong>$1.2242</strong> per share.</p>',
    },
  ],
};

describe('the embedded faces are opened once, not once per document', () => {
  it('hands pdfkit an open face rather than a path to read and parse', async () => {
    const register = vi.spyOn(PDFDocument.prototype, 'registerFont');
    try {
      await renderReportPdf(INPUT, { compress: false });
      const sources = register.mock.calls.map(([, src]) => src);
      expect(sources).toHaveLength(4);
      for (const src of sources) {
        // A string is a path pdfkit will `readFileSync` and parse; a Uint8Array
        // is bytes it will still parse. Only an already-open font is neither.
        expect(typeof src).toBe('object');
        expect(typeof (src as { layout?: unknown }).layout).toBe('function');
      }
    } finally {
      register.mockRestore();
    }
  });

  it('hands the second document the same face objects as the first', async () => {
    const register = vi.spyOn(PDFDocument.prototype, 'registerFont');
    try {
      await renderReportPdf(INPUT, { compress: false });
      const first = register.mock.calls.map(([, src]) => src);
      register.mockClear();
      await renderReportPdf(INPUT, { compress: false });
      const second = register.mock.calls.map(([, src]) => src);
      expect(second).toHaveLength(first.length);
      second.forEach((src, i) => {
        // `toBe` on two equal paths would pass over the defect; the type is
        // what makes the identity mean "the same parsed face".
        expect(typeof src).toBe('object');
        expect(src).toBe(first[i]);
      });
    } finally {
      register.mockRestore();
    }
  });

  it('renders identical bytes for a document rendered twice', async () => {
    const first = await renderReportPdf(INPUT, { compress: false });
    const second = await renderReportPdf(INPUT, { compress: false });
    expect(second.equals(first)).toBe(true);
  });

  it('renders identical bytes when a second document is rendered alongside', async () => {
    const alone = await renderReportPdf(INPUT, { compress: false });
    const other: ReportPdfInput = {
      ...INPUT,
      // A different subset of the same faces, so a shared subset — which is
      // what a font object carrying per-document state would give — shows up as
      // a difference in the first document rather than the second.
      company_name: 'Zeta Ünïcode Ω, Inc.',
      sections: [{ heading: 'Ünïcode Ω', html: '<p>Ωμέγα · ﬁ · —</p>' }],
    };
    const [together] = await Promise.all([
      renderReportPdf(INPUT, { compress: false }),
      renderReportPdf(other, { compress: false }),
    ]);
    expect(together.equals(alone)).toBe(true);
  });

  it('still embeds a subset of the face rather than the whole file', async () => {
    const pdf = await renderReportPdf(INPUT, { compress: false });
    // The face is named in the document, and the document is far smaller than
    // the four faces it draws from.
    expect(pdf.toString('latin1')).toContain('DejaVuSans');
    const faceBytes = readFileSync(new URL('../assets/fonts/DejaVuSans.ttf', import.meta.url)).byteLength;
    expect(pdf.byteLength).toBeLessThan(faceBytes);
  });
});
