import { afterEach, describe, expect, it } from 'vitest';
import { configureReportPdfLogging, renderReportPdf, type ReportPdfInput } from '../src/pdf.js';
import { extractText } from './support/pdfText.js';

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

describe('renderReportPdf branding', () => {
  // The sink is module-level (see `configureReportPdfLogging`), so a test that
  // installs one has to take it back out or the next file inherits it.
  afterEach(() => configureReportPdfLogging(null));

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

  it('says why the mark is missing, since the report itself cannot', async () => {
    /*
     * A white-labelled report with no mark on it is the same picture from
     * support's side however it happened: the URL is stored and looks fine,
     * the render succeeded, the PDF is simply missing the logo. R155 named the
     * nine ways the *fetch* produces no bytes (clients/partnerLogo.ts) for
     * that reason and left this one — bytes that arrived and would not decode
     * — as a bare `catch {}`. The fetch sniffs the format before storing, so
     * what is left is a truncated or malformed file behind a good header:
     * narrow, and not never, and the firm watches every report they ship go
     * out unbranded either way.
     */
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    configureReportPdfLogging({ warn: (obj, msg) => lines.push({ obj, msg }) });

    const pdf = await renderReportPdf(
      {
        ...BASE,
        branding: { partner_name: 'Bridge Advisors', logo: Buffer.from('definitely not an image') },
      },
      { compress: false },
    );

    // Still a report, and still delivered — which is why this is a warning.
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({
      reason: 'undecodable_image',
      partner: 'Bridge Advisors',
    });
  });

  it('says nothing when the logo draws', async () => {
    const lines: unknown[] = [];
    configureReportPdfLogging({ warn: (obj) => lines.push(obj) });
    await renderReportPdf(
      { ...BASE, branding: { partner_name: 'Bridge Advisors', logo: ONE_PX_PNG } },
      { compress: false },
    );
    expect(lines).toEqual([]);
  });

  it('renders identically-shaped output without branding', async () => {
    const pdf = await renderReportPdf(BASE, { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(extractText(pdf)).not.toContain('Prepared in partnership');
  });
});

describe('link rendering (gap 9)', () => {
  it('renders anchor text underlined in the PDF', async () => {
    const pdf = await renderReportPdf(
      {
        ...BASE,
        sections: [
          { heading: 'Refs', html: '<p>See <a href="https://ex.com/x">the data room</a> for detail.</p>' },
        ],
      },
      { compress: false },
    );
    const text = extractText(pdf);
    expect(text).toContain('the data room');
    expect(text).not.toContain('https://ex.com/x');
  });
});
