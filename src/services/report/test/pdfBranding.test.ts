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
    // Round 265 moved this refusal one step earlier: bytes with no header a
    // size can be read from are refused *before* the decoder is handed them,
    // because the thing that has to be stopped — an image whose declared
    // dimensions cost gigabytes to decode — is not something a `catch` around
    // `doc.image` can stop. `null` from the reader means unmeasured, not
    // small, so this file is refused by the same rule.
    expect(lines[0]!.obj).toMatchObject({
      reason: 'unreadable_image_header',
      partner: 'Bridge Advisors',
    });
  });

  it('refuses a small file that declares an enormous image, before decoding it', async () => {
    /*
     * The bound that could not be a `catch` (round 265, methodology M6).
     *
     * Every cap in front of a partner mark bounds its *compressed* size —
     * `MAX_LOGO_BYTES` on the fetch, `logo_base64` on this service's contract,
     * a sniff of the first eight bytes — and a PNG deflates its pixels. A
     * 995 KB file inside all of them can declare 16000 x 16000 RGBA and take
     * `doc.image` past 1.2 GB of resident memory in one call, allocated off the
     * JS heap where `--max-old-space-size` does not reach. On this estate's
     * host that is an OOM kill of whichever process is rendering, and a process
     * that is gone writes no issue line, no status code and no log.
     */
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    configureReportPdfLogging({ warn: (obj, msg) => lines.push({ obj, msg }) });

    const ihdr = Buffer.alloc(21);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'latin1');
    ihdr.writeUInt32BE(16_000, 8);
    ihdr.writeUInt32BE(16_000, 12);
    ihdr[16] = 8;
    ihdr[17] = 6;
    const bomb = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), ihdr]);

    const pdf = await renderReportPdf(
      { ...BASE, branding: { partner_name: 'Bridge Advisors', logo: bomb } },
      { compress: false },
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({
      reason: 'image_too_many_pixels',
      partner: 'Bridge Advisors',
      width: 16_000,
      height: 16_000,
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
