import { describe, expect, it } from 'vitest';
import { renderReportPdf } from '@n409/report/pdf';
import {
  RENDER_RESOLVED_MARKERS,
  SIGNATURE_MARKER,
  instantiateTemplate,
  templateForKind,
  visibleSections,
  type ReportContent,
} from '../../src/domain/report.js';
import { resolveSignatures, type ReportSignatory } from '../../src/domain/reportSignatures.js';
import { reportReadiness } from '../../src/domain/reportReadiness.js';
import { reviewReport } from '../../src/domain/reportReview.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';
import { extractText as pdfText } from '../../../report/test/support/pdfText.js';

/**
 * The signature the platform collects and the deliverable never carried.
 *
 * `publishGate` refuses an engagement with no `main` row, so every published
 * report on this platform was signed by somebody; the PDF said so nowhere. The
 * checks below are about the two halves of closing that: the block reaches the
 * page, and it reaches it from the render rather than from the stored body — so
 * a signature that is replaced, or a second one that lands later, restates
 * itself instead of leaving the previous one in the file.
 */

const MAIN: ReportSignatory = {
  role: 'main',
  signer_name: 'Dana Whitfield',
  signer_title: 'Managing Director, ASA',
  signature_text: 'Dana Whitfield',
  signed_at: new Date('2026-07-02T14:05:00Z'),
};

const SECOND: ReportSignatory = {
  role: 'second',
  signer_name: 'Ravi Menon',
  signer_title: 'Director, CFA',
  signature_text: 'Ravi Menon',
  signed_at: new Date('2026-07-03T09:20:00Z'),
};

const VARS = {
  company_name: 'Northwind Robotics, Inc.',
  valuation_ref: '01J000000000000000000001',
  date: '2026-06-30',
  currency: 'USD',
} as const;

function body(kind: (typeof VALUATION_KINDS)[number] = '409a'): ReportContent {
  return instantiateTemplate(templateForKind(kind), { ...VARS, kind });
}

const certOf = (content: ReportContent) => content.sections.find((s) => s.key === 'certification')!;

describe('the certification carries the appraiser’s signature', () => {
  it('puts every skeleton’s certification behind the marker', () => {
    // The point of the shared `CERTIFICATION_SECTION`: fifteen deliverables,
    // one certification, and therefore one place a signature has to reach. A
    // kind added later without it would ship a report nobody signed.
    for (const kind of VALUATION_KINDS) {
      const cert = certOf(body(kind));
      expect(cert.html, kind).toContain(SIGNATURE_MARKER);
    }
  });

  it('replaces the marker with the signatories on file', () => {
    const resolved = resolveSignatures(body(), [MAIN, SECOND]);
    const html = certOf(resolved).html;

    expect(html).not.toContain(SIGNATURE_MARKER);
    expect(html).toContain('/s/ Dana Whitfield');
    expect(html).toContain('Dana Whitfield, Managing Director, ASA');
    expect(html).toContain('Valuation analyst');
    expect(html).toContain('/s/ Ravi Menon');
    expect(html).toContain('Concurring reviewer');
    // The UTC day of the `timestamptz`, matching the reading the cover's
    // "Rendered" line and `published_at` already use.
    expect(html).toContain('2026-07-02');
    expect(html).toContain('2026-07-03');
  });

  it('prints the analyst first however the rows arrive', () => {
    // `listSignatures` orders by role, which happens to put 'main' first
    // alphabetically — an accident this must not depend on, because the order
    // the signatures print in is the order of authority on the page.
    const html = certOf(resolveSignatures(body(), [SECOND, MAIN])).html;
    expect(html.indexOf('Dana Whitfield')).toBeLessThan(html.indexOf('Ravi Menon'));
  });

  it('prints an empty, ruled block on an unsigned draft', () => {
    /*
     * Not an omission. A draft and a final that differ by the *absence* of a
     * page element differ in the way a reader is least likely to notice, and the
     * whole hazard here is a document that looks like a signed appraisal and is
     * not one.
     */
    const html = certOf(resolveSignatures(body(), [])).html;
    expect(html).not.toContain(SIGNATURE_MARKER);
    expect(html).toContain('Valuation analyst');
    expect(html).toContain('not yet signed');
    expect(html).not.toContain('/s/');
  });

  it('appends the block to a legacy body that has no marker', () => {
    // Every report already in flight was drafted from a skeleton older than
    // this module. None may have to be re-drafted to gain a signature page.
    const legacy: ReportContent = {
      title: 'Report',
      sections: [{ key: 'certification', heading: 'Appraiser Certification', html: '<p>We certify…</p>' }],
    };
    const html = certOf(resolveSignatures(legacy, [MAIN])).html;
    expect(html).toContain('<p>We certify…</p>');
    expect(html).toContain('/s/ Dana Whitfield');
    // Appended, not substituted for: a render must never delete authored prose.
    expect(html.indexOf('We certify')).toBeLessThan(html.indexOf('Dana Whitfield'));
  });

  it('leaves a hidden certification alone', () => {
    // A hidden chapter is not in the deliverable, so there is nothing for a
    // signature to close — and building the block anyway would put the signer's
    // name into a section no reader ever sees.
    const hidden: ReportContent = {
      title: 'Report',
      sections: [
        {
          key: 'certification',
          heading: 'Appraiser Certification',
          html: `<p>We certify…</p>${SIGNATURE_MARKER}`,
          hidden: true,
        },
      ],
    };
    expect(certOf(resolveSignatures(hidden, [MAIN])).html).toContain(SIGNATURE_MARKER);
  });

  it('touches no section but the certification', () => {
    const before = body();
    const after = resolveSignatures(before, [MAIN]);
    for (const [i, section] of after.sections.entries()) {
      if (section.key === 'certification') continue;
      expect(section, section.key).toBe(before.sections[i]);
    }
  });

  it('never writes back to the stored content', () => {
    /*
     * The property the whole design rests on. `upsertSignature` is
     * insert-or-replace, so re-signing after a change supersedes the previous
     * row — and a signature written into the stored body at draft time would be
     * one that could not then be corrected without editing prose.
     */
    const stored = body();
    const storedCert = certOf(stored).html;
    resolveSignatures(stored, [MAIN, SECOND]);
    expect(certOf(stored).html).toBe(storedCert);
    expect(storedCert).toContain(SIGNATURE_MARKER);
  });

  it('escapes what the signer typed', () => {
    // `signature_text`, `signer_name` and `signer_title` all arrive from a
    // request body. The certification page is the last place in the product
    // that should be trusting one.
    const hostile: ReportSignatory = {
      ...MAIN,
      signer_name: '<script>alert(1)</script>',
      signer_title: 'A & B "Valuations"',
      signature_text: '<img src=x onerror=1>',
    };
    const html = certOf(resolveSignatures(body(), [hostile])).html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B');
  });

  it('omits the comma when the signer has no title', () => {
    const html = certOf(resolveSignatures(body(), [{ ...MAIN, signer_title: null }])).html;
    expect(html).toContain('<td>Dana Whitfield</td>');
  });
});

describe('the markers the render resolves', () => {
  /*
   * Both of these resolve from something other than the calculation, so
   * `reportFigures` can never produce a value for either. Two checks read a body
   * and ask what is unresolved in it, and a marker missing from this set is one
   * they report as an unfilled hole that nobody can fill.
   */
  it('names both render-time markers', () => {
    expect([...RENDER_RESOLVED_MARKERS].sort()).toEqual(['exhibit_index', 'signatures']);
  });

  it('is not reported as an unfilled placeholder', () => {
    // The stored body, unresolved — which is what `narrativeApply` reads, and
    // what any future caller that forgets the resolve step would read.
    const cert = certOf(body());
    const readiness = reportReadiness({ title: 'Report', sections: [cert] }, { fmv_per_share: '$1.00' });
    expect(readiness.status).toBe('pass');
    expect(readiness.placeholders).toEqual([]);
  });

  it('does not make the certification look like a self-restating chapter', () => {
    /*
     * `checkFrozenFigures` warns when a chapter that *used* to restate itself
     * from the calculation no longer does. The certification never did — its one
     * marker resolves from the signatures table — so counting it would put a
     * permanent warning on every report whose analyst reworded the chapter.
     */
    const template = templateForKind('409a');
    const content = body();
    const cert = certOf(content);
    const reworded: ReportContent = {
      ...content,
      sections: content.sections.map((s) =>
        s.key === 'certification' ? { ...s, html: '<p>We hereby certify the above.</p>' } : s,
      ),
    };
    expect(cert.html).toContain(SIGNATURE_MARKER);
    const findings = reviewReport({
      content: reworded,
      template,
      exhibitHeadings: [],
      approaches: {},
    }).findings;
    expect(findings.filter((f) => f.section_key === 'certification')).toEqual([]);
  });
});

describe('the signature reaches the rendered PDF', () => {
  const render = async (content: ReportContent) =>
    pdfText(
      await renderReportPdf(
        {
          title: 'Valuation Report',
          company_name: VARS.company_name,
          meta: [{ label: 'Template', value: templateForKind('409a').version }],
          sections: visibleSections(content).map((s) => ({ heading: s.heading, html: s.html })),
        },
        // Uncompressed so the text is extractable from the page stream — the
        // convention every PDF assertion in this repo uses.
        { compress: false },
      ),
    );

  it('prints the signer, their title and the date they signed', async () => {
    const text = await render(resolveSignatures(body(), [MAIN, SECOND]));
    expect(text).toContain('Dana Whitfield');
    expect(text).toContain('Managing Director, ASA');
    expect(text).toContain('2026-07-02');
    expect(text).toContain('Ravi Menon');
  });

  it('prints the unsigned notice on a draft', async () => {
    const text = await render(resolveSignatures(body(), []));
    expect(text).toContain('not yet signed');
    expect(text).not.toContain('Dana Whitfield');
  });
});
