/**
 * The specialty schedules, through the real PDF renderer.
 *
 * `specialtyExhibits.test.ts` and its siblings assert on the HTML these
 * functions return. Nothing had ever put that HTML through `renderReportPdf`,
 * which is where an exhibit stops being a string and acquires a width: the
 * renderer sizes columns in proportion to their widest cell and shrinks them
 * all by a common factor when they exceed the page. A table with too many
 * columns does not throw and does not drop — it renders, narrower, until the
 * figures wrap into unreadable stacks or the cells collide.
 *
 * The multi-period excess earnings chain is nine columns, the widest any
 * exhibit produces, and it is the reason this file exists. Rendered as one
 * table it did not overflow — it squeezed, and at ordinary magnitudes ($10m of
 * revenue) the amounts wrapped inside their cells: "$1,007," on one line and
 * "543" on the next, down the present-value column. Nothing in the HTML
 * assertions can see that. It is now two tables split at the figure they share.
 *
 * Letter portrait with 72pt margins, so the usable width is 612 − 144 = 468pt.
 */

import { describe, expect, it } from 'vitest';
import { renderReportPdf } from '@n409/report/pdf';
import { buildSpecialtyExhibits } from '../../src/domain/specialtyExhibits.js';
import { SAMPLE_820_RESULT, SAMPLE_IP_RESULT } from '../../src/domain/specialtySamples.js';
import { extractText, pageLines } from '../../../report/test/support/pdfText.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

const PAGE_WIDTH = 612;
const MARGIN = 72;

const ctx = { currency: 'USD', companyName: 'Northwind Robotics, Inc.', valuationDate: '2026-03-31' };

function calc(kind: string, specialty: Record<string, unknown>): CalculationRow {
  return {
    id: '01J',
    valuation_id: '01K',
    engine_version: 'test',
    status: 'succeeded',
    inputs: {},
    results: { kind, specialty },
    equity_value: null,
    fmv_per_share: null,
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date(),
  };
}

async function render(kind: string, specialty: Record<string, unknown>) {
  const sections = buildSpecialtyExhibits(calc(kind, specialty), ctx);
  expect(sections.length).toBeGreaterThan(0);
  return renderReportPdf(
    {
      title: 'Specialty exhibit',
      company_name: ctx.companyName,
      meta: [{ label: 'Valuation date', value: ctx.valuationDate }],
      sections: sections.map((s) => ({ heading: s.heading, html: s.html })),
      generated_at: new Date('2026-07-01T00:00:00.000Z'),
      keywords: [ctx.companyName],
    },
    { compress: false },
  );
}

/** Every drawn line, flattened across pages. */
const linesOf = (pdf: Buffer) => pageLines(pdf).flat();

/**
 * An amount broken across two drawn lines — "$1,007," with its digits on the
 * next line. A cell too narrow for its figure produces exactly this, and it is
 * the difference between a table a reader can scan down and one where every
 * number has to be reassembled.
 */
const brokenAmounts = (pdf: Buffer) =>
  linesOf(pdf)
    .map((l) => l.text.trim())
    .filter((t) => /^\$[\d,]+,$/.test(t));

describe('specialty exhibits survive the renderer', () => {
  it('lays the MEEM chain out inside the page without breaking its figures', async () => {
    const pdf = await render('ip', {
      method: 'meem',
      schedule: [1, 2, 3, 4, 5].map((year) => ({
        year,
        // Nine-figure amounts, so the columns are as wide as this table ever
        // gets. A schedule that fits at four figures and not at nine is one
        // that fits until the client is large.
        revenue: 128_400_000 * year,
        survival: 1 - year * 0.1,
        attributable_revenue: 109_140_000 * year,
        ebit: 27_285_000 * year,
        after_tax_earnings: 21_555_150 * year,
        contributory_charge: 6_548_400 * year,
        excess_earnings: 15_006_750 * year,
        pv: 12_936_853 * year,
      })),
      value_before_tab: 184_562_400,
      tab_multiplier: 1.0846650327793148,
      fair_value: 200_186_902,
    });

    const text = extractText(pdf);
    // Every column reached the document. A header the renderer squeezed to
    // nothing is the failure that is invisible in "did it render".
    for (const head of [
      'Year',
      'Revenue',
      'Survival',
      'Attributable',
      'EBIT',
      'After-tax',
      'Contributory',
      'Excess',
      'Present value',
    ]) {
      expect(text, `column "${head}" is not in the PDF`).toContain(head);
    }
    // And the figures, not just the headings.
    expect(text).toContain('$128,400,000');
    expect(text).toContain('$200,186,902');

    // Nothing drawn outside the type area. `x` is the left edge of a line, so
    // a line starting past the right margin is text off the page.
    for (const line of linesOf(pdf)) {
      expect(line.x, `a line starts at x=${line.x}: "${line.text}"`).toBeLessThan(PAGE_WIDTH - MARGIN);
      expect(line.x).toBeGreaterThanOrEqual(0);
    }

    // And no figure split across two lines. This is what nine columns in one
    // table did, at every magnitude from $10m upward.
    expect(brokenAmounts(pdf)).toEqual([]);
  }, 120_000);

  /**
   * The wrap depended on the magnitude of the figures, not on the number of
   * rows, so the guard has to hold at the top of the range a real engagement
   * reaches rather than at the sample's.
   */
  it('keeps the MEEM figures whole at a billion in revenue', async () => {
    const pdf = await render('ip', {
      method: 'meem',
      schedule: [1, 2, 3].map((year) => ({
        year,
        revenue: 1_000_000_000 * year,
        survival: 1 - year * 0.1,
        attributable_revenue: 850_000_000 * year,
        ebit: 212_500_000 * year,
        after_tax_earnings: 167_875_000 * year,
        contributory_charge: 51_000_000 * year,
        excess_earnings: 116_875_000 * year,
        pv: 100_754_300 * year,
      })),
      value_before_tab: 214_077_400,
      tab_multiplier: 1.0846,
      fair_value: 232_202_200,
    });
    expect(brokenAmounts(pdf)).toEqual([]);
    for (const line of linesOf(pdf)) expect(line.x).toBeLessThan(PAGE_WIDTH - MARGIN);
  }, 120_000);

  it('renders the relief-from-royalty schedule and its bridge', async () => {
    const pdf = await render('ip', SAMPLE_IP_RESULT);
    const text = extractText(pdf);
    expect(text).toContain('Relief from royalty');
    expect(text).toContain('Royalty savings');
    expect(text).toContain('$2,810,029');
    // The TAB factor is drawn as a factor. A multiplier that reached the page
    // as "$1" would be indistinguishable from a rendering fault here.
    expect(text).toContain('1.0805');
  }, 120_000);

  it('renders the ASC 820 hierarchy, rollforward and sensitivity together', async () => {
    const pdf = await render('820', SAMPLE_820_RESULT);
    const text = extractText(pdf);
    expect(text).toContain('Level 3');
    expect(text).toContain('Beginning balance');
    // The disclosure added this round, on a page rather than in a string.
    expect(text).toContain('820-10-50-2(g)');
    expect(text).toContain('$8,305,000');
    for (const line of linesOf(pdf)) {
      expect(line.x).toBeLessThan(PAGE_WIDTH - MARGIN);
    }
  }, 120_000);
});
