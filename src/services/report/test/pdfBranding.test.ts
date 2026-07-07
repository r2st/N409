import { describe, expect, it } from 'vitest';
import { renderReportPdf, type ReportPdfInput } from '../src/pdf.js';

/** Improvement 8 — white-label partner branding on the report cover. */

const BASE: ReportPdfInput = {
  title: 'IRC 409A Valuation Report',
  company_name: 'Acme Robotics, Inc.',
  meta: [{ label: 'Engagement', value: '01JZZZZZZZZZZZZZZZZZZZZZZZ' }],
  sections: [{ heading: 'Introduction', html: '<p>Body.</p>' }],
};

// Smallest valid PNG: 1×1 transparent pixel.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** pdfkit writes text runs as hex strings (WinAnsi bytes) — decode them all. */
function extractText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  return Array.from(raw.matchAll(/<([0-9a-fA-F]+)>/g))
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
}

describe('renderReportPdf branding', () => {
  it('renders the partnership line and stays a valid PDF', async () => {
    const pdf = await renderReportPdf(
      { ...BASE, branding: { partner_name: 'Bridge Advisors', brand_color: '#1f6f54' } },
      { compress: false },
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(extractText(pdf)).toContain('Prepared in partnership with Bridge Advisors');
  });

  it('embeds a PNG partner logo', async () => {
    const pdf = await renderReportPdf(
      { ...BASE, branding: { partner_name: 'Bridge Advisors', logo: ONE_PX_PNG } },
      { compress: false },
    );
    // PDFKit embeds raster logos as an Image XObject.
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
    expect(extractText(pdf)).toContain('Prepared in partnership with Bridge Advisors');
  });

  it('survives an undecodable logo and an invalid colour', async () => {
    const pdf = await renderReportPdf(
      {
        ...BASE,
        branding: {
          partner_name: 'Bridge Advisors',
          brand_color: 'teal-ish',
          logo: Buffer.from('definitely not an image'),
        },
      },
      { compress: false },
    );
    expect(pdf.toString('latin1').startsWith('%PDF')).toBe(true);
  });

  it('renders identically-shaped output without branding', async () => {
    const pdf = await renderReportPdf(BASE, { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(extractText(pdf)).not.toContain('Prepared in partnership');
  });
});
