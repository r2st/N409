import { describe, expect, it } from 'vitest';
import { renderReportPdf } from '@n409/report/pdf';
import {
  SAMPLE_COMPANY,
  SAMPLE_FIGURES,
  SAMPLE_NOTICE,
  SAMPLE_VALUATION_DATE,
  sampleReportPdfInput,
} from '../../src/domain/sampleReportPdf.js';
import { templateForKind } from '../../src/domain/report.js';
/*
 * Reading text back out of a rendered PDF is the report service's problem, and
 * it stopped being a one-liner when the renderer embedded a Unicode face: the
 * codes in a content stream are now glyph indices in a subset font, and getting
 * characters back means following the font's /ToUnicode CMap. That reader is
 * written once, in the service that writes the documents. This file used to
 * carry its own two-line version, which kept passing until the day the encoding
 * changed under it and then asserted on glyph numbers.
 */
import { extractText as pdfText, pageTexts } from '../../../report/test/support/pdfText.js';

/**
 * The publicly downloadable sample 409A.
 *
 * Two things are being protected here and they pull in opposite directions.
 * The document has to be *convincing* — it is the deliverable, rendered through
 * the deliverable's own path, or a prospect learns nothing from it. And it has
 * to be *impossible to mistake for an opinion*, because it is a realistic 409A
 * that anyone on the internet can download and hand to somebody.
 *
 * So: the structural assertions check it really is the template (not a
 * hand-written imitation that will drift), and the notice assertions check the
 * three independent marks that say it is not real. The arithmetic assertions
 * are there because a sample valuation whose summary contradicts its own
 * Exhibit H is a worse advertisement than no sample.
 */

const figure = (label: string) => SAMPLE_FIGURES.find((f) => f.label === label)!;

/** `$32,000,000` → 32000000. The strip is formatted; the identity is not. */
const amount = (label: string) => Number(figure(label).value.replace(/[^0-9.]/g, ''));

describe('sample report PDF — the worked example', () => {
  it('closes: equity − preferred − pool = common', () => {
    expect(amount('Equity value') - amount('Preferred') - amount('Option pool')).toBe(amount('Common'));
  });

  it('derives FMV per share from the common value, the share count and the DLOM', () => {
    const dlom = Number(figure('DLOM').value.replace(/[^0-9.]/g, '')) / 100;
    // The share count is stated only in the Common figure's note, which is the
    // point: a reader can reproduce the conclusion from what the strip shows.
    const shares = Number(figure('Common').note!.replace(/[^0-9]/g, ''));
    const marketable = amount('Common') / shares;
    expect(marketable * (1 - dlom)).toBeCloseTo(amount('FMV / share'), 2);
  });

  it('reconciles: the weighted approaches in Exhibit B reach the equity value', () => {
    const input = sampleReportPdfInput();
    const exhibitB = input.sections.find((s) => s.heading.startsWith('Exhibit B'))!.html;
    // The weighted column, as the exhibit prints it, summed against the total
    // the same exhibit concludes and the equity value the summary strip
    // states. This is the join between the schedule and the cover, and it is
    // the one a reader checks first.
    const rows = Array.from(exhibitB.matchAll(/<tr>(?!<th)([\s\S]*?)<\/tr>/g)).map((m) => m[1]!);
    const cellMoney = (row: string) =>
      Array.from(row.matchAll(/\$([\d,]+)/g)).map((m) => Number(m[1]!.replace(/,/g, '')));
    const weighted = rows.filter((r) => !r.includes('<strong>')).map((r) => cellMoney(r).at(-1)!);
    expect(weighted).toHaveLength(3);

    const foot = rows.find((r) => r.includes('Concluded total equity value'))!;
    const total = cellMoney(foot).at(-1)!;
    // Rounded, because the exhibit prints whole currency units and the
    // underlying weighted sum carries cents.
    expect(total).toBe(Math.round(amount('Equity value')));
    expect(weighted.reduce((a, b) => a + b, 0)).toBeCloseTo(total, -1);
  });

  it("Exhibit A's liquidation preferences total the preferred value the waterfall deducts", () => {
    const input = sampleReportPdfInput();
    const exhibitA = input.sections.find((s) => s.heading.startsWith('Exhibit A'))!.html;
    const foot = /<td><strong>Fully diluted<\/strong><\/td>[\s\S]*?<\/tr>/.exec(exhibitA)![0];
    const preference = Number(
      /\$([\d,]+)/.exec(foot.replace(/<td><strong>[\d,]+<\/strong><\/td>/, ''))![1]!.replace(/,/g, ''),
    );
    expect(preference).toBe(amount('Preferred'));
  });

  it('states every figure the marketing strip needs, and no unlabelled ones', () => {
    expect(SAMPLE_FIGURES.map((f) => f.label)).toEqual([
      'Equity value',
      'Preferred',
      'Option pool',
      'Common',
      'DLOM',
      'FMV / share',
    ]);
    for (const f of SAMPLE_FIGURES) expect(f.value).not.toBe('');
  });
});

describe('sample report PDF — it is the real template', () => {
  const input = sampleReportPdfInput();

  it('carries every chapter of the 409A skeleton, plus the four standing exhibits', () => {
    const template = templateForKind('409a');
    const headings = input.sections.map((s) => s.heading);
    // Not a subset check: a sample that quietly drops chapters is exactly the
    // drift this is built through the template to prevent.
    for (const s of template.sections) expect(headings).toContain(s.heading);
    expect(headings.filter((h) => h.startsWith('Exhibit '))).toEqual([
      'Exhibit A — Capitalization Table',
      'Exhibit B — Reconciliation of Valuation Approaches',
      'Exhibit C — Income Approach (Discounted Cash Flow)',
      'Exhibit D — Market Approach',
      'Exhibit F — Allocation',
      'Exhibit H — Discounts & Conclusion',
    ]);
  });

  it('names the template version it was rendered from', () => {
    const version = input.meta.find((m) => m.label === 'Template')!.value;
    expect(version).toBe(templateForKind('409a').version);
  });

  it('leaves no unresolved placeholders in any chapter', () => {
    // `{{fmv_per_share}}` printed literally is the failure mode the figures
    // layer exists to avoid, and it is invisible in a structural assertion.
    for (const s of input.sections) {
      expect(s.html, s.heading).not.toMatch(/\{\{[a-z_]+\}\}/);
      expect(s.html, s.heading).not.toMatch(/\{\{[#/]exhibit:/);
    }
  });

  it('promises no exhibit it does not print', () => {
    const printed = new Set(
      input.sections
        .map((s) => /^Exhibit ([A-Z]+(?:-\d+)?) /.exec(s.heading)?.[1])
        .filter((id): id is string => id !== undefined),
    );
    const body = input.sections
      .filter((s) => !s.heading.startsWith('Exhibit '))
      .map((s) => s.html)
      .join('');
    for (const m of body.matchAll(/Exhibit ([A-Z]+(?:-\d+)?)\b/g)) {
      expect(printed, `body points at Exhibit ${m[1]}`).toContain(m[1]!);
    }
  });

  it('is deterministic — the same request produces the same document', () => {
    expect(sampleReportPdfInput()).toEqual(sampleReportPdfInput('409a'));
    expect(input.generated_at?.toISOString()).toBe(`${SAMPLE_VALUATION_DATE}T00:00:00.000Z`);
  });
});

describe('sample report PDF — it cannot be passed off as an opinion', () => {
  it('marks the cover, the summary and the footer independently', () => {
    const input = sampleReportPdfInput();
    expect(input.meta[0]).toEqual({ label: 'Notice', value: SAMPLE_NOTICE });
    expect(input.summary!.statement).toContain(SAMPLE_NOTICE);
    expect(input.confidentiality).toBe(SAMPLE_NOTICE);
    expect(input.title).toContain('SAMPLE');
  });

  it('names a fictitious company and says so in the summary', () => {
    const input = sampleReportPdfInput();
    expect(input.company_name).toBe(SAMPLE_COMPANY);
    expect(input.summary!.statement).toMatch(/fictitious/i);
    expect(input.summary!.statement).toMatch(/nobody has signed/i);
  });

  it('prints the notice on every page of the rendered document', async () => {
    const pdf = await renderReportPdf(sampleReportPdfInput(), { compress: false });
    const pages = pageTexts(pdf);
    expect(pages.length).toBeGreaterThan(10);
    // The footer is what survives a reader who prints or crops one chapter, so
    // "on the cover" is not enough — it has to be on all of them.
    for (const [i, text] of pages.entries()) {
      expect(text, `page ${i + 1}`).toContain('SAMPLE');
    }
  }, 60_000);

  it('renders the concluded figure and the company into the document text', async () => {
    const pdf = await renderReportPdf(sampleReportPdfInput(), { compress: false });
    const text = pdfText(pdf);
    expect(text).toContain(SAMPLE_COMPANY);
    expect(text).toContain(SAMPLE_VALUATION_DATE);
    // The conclusion, as the summary page states it — four decimals, the same
    // convention Exhibit H uses. Derived from the strip rather than written
    // here, so a change to a DCF input moves both together or fails.
    const shares = Number(figure('Common').note!.replace(/[^0-9]/g, ''));
    const dlom = Number(figure('DLOM').value.replace(/[^0-9.]/g, '')) / 100;
    const fmv = ((amount('Common') / shares) * (1 - dlom)).toFixed(4);
    expect(text).toContain(`$${fmv}`);
  }, 60_000);
});
