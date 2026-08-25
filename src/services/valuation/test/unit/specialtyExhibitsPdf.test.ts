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
import {
  SAMPLE_820_RESULT,
  SAMPLE_EMI_RESULT,
  SAMPLE_ESOP_RESULT,
  SAMPLE_FMV_RESULT,
  SAMPLE_IP_RESULT,
  SAMPLE_PPA_RESULT,
} from '../../src/domain/specialtySamples.js';
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

  /**
   * Six columns — two added by the TAB work, one by the discount rate — with
   * the widest method name any intangible carries ("Multi-period excess
   * earnings") in the second. This is the table most likely to squeeze.
   */
  it('fits the PPA allocation with its TAB columns inside the page', async () => {
    const pdf = await render('ppa', SAMPLE_PPA_RESULT);
    const text = extractText(pdf);
    for (const head of ['Intangible asset', 'Method', 'Discount rate', 'Before TAB', 'TAB', 'Fair value']) {
      expect(text, `column "${head}" is not in the PDF`).toContain(head);
    }
    expect(text).toContain('Multi-period excess earnings');
    expect(text).toContain('16.5%');
    expect(text).toContain('$3,626,939');
    expect(text).toContain('1.0826');
    expect(text).toContain('$37,880,353');
    expect(brokenAmounts(pdf)).toEqual([]);
    for (const line of linesOf(pdf)) expect(line.x).toBeLessThan(PAGE_WIDTH - MARGIN);
  }, 120_000);

  /** The same, at a magnitude a large acquisition reaches. */
  it('keeps the PPA figures whole at a billion of consideration', async () => {
    const pdf = await render('ppa', {
      consideration_transferred: 2_400_000_000,
      tangible_net_assets: 310_000_000,
      total_intangible_value: 890_000_000,
      identifiable_net_assets: 1_200_000_000,
      goodwill: 1_200_000_000,
      bargain_purchase_gain: 0,
      intangibles: [
        {
          name: 'Customer relationships',
          method: 'meem',
          assumptions: { discount_rate: 0.165 },
          value_before_tab: 728_400_000,
          tab_multiplier: 1.0846,
          fair_value: 790_022_640,
        },
        {
          name: 'Developed technology',
          method: 'relief_from_royalty',
          assumptions: { discount_rate: 0.185 },
          value_before_tab: 92_200_000,
          tab_multiplier: 1.0805,
          fair_value: 99_622_100,
        },
      ],
    });
    expect(brokenAmounts(pdf)).toEqual([]);
    for (const line of linesOf(pdf)) expect(line.x).toBeLessThan(PAGE_WIDTH - MARGIN);
  }, 120_000);

  /**
   * The SMB Basis column carries a whole sentence of arithmetic per row, so it
   * is the widest cell content any exhibit puts beside three other columns. The
   * ÷ and × have to survive the font as well as the layout — a multiplier that
   * reached the page as a box would be worse than no Basis column at all.
   */
  it('renders the SMB basis column with its operators intact', async () => {
    const pdf = await render('fmv', SAMPLE_FMV_RESULT);
    const text = extractText(pdf);
    expect(text).toContain('SDE $1,032,000 \u00f7 16.9%');
    expect(text).toContain('SDE $1,032,000 \u00d7 3.10');
    expect(text).toContain('Revenue $4,150,000 \u00d7 0.85');
    expect(text).toContain('build-up discount rate of 19.9%');
    expect(brokenAmounts(pdf)).toEqual([]);
    for (const line of linesOf(pdf)) expect(line.x).toBeLessThan(PAGE_WIDTH - MARGIN);
  }, 120_000);

  /** Sterling in the engine's check details, dollars in the exhibit's own rows. */
  it('renders both currencies on the EMI exhibit with the note that explains them', async () => {
    const pdf = await render('emi', SAMPLE_EMI_RESULT);
    const text = extractText(pdf);
    expect(text).toContain('\u00a3250,000 limit');
    expect(text).toContain('$175,500');
    expect(text).toContain('statutory sterling amounts');
    for (const line of linesOf(pdf)) expect(line.x).toBeLessThan(PAGE_WIDTH - MARGIN);
  }, 120_000);

  /**
   * Six columns after the present-value one was added, ten rows deep, with a
   * per-share price at two decimals beside two share counts and three amounts.
   */
  it('fits the ESOP repurchase schedule with its present-value column', async () => {
    const pdf = await render('esop', SAMPLE_ESOP_RESULT);
    const text = extractText(pdf);
    for (const head of [
      'Year',
      'Share price',
      'Shares redeemed',
      'Repurchase cost',
      'Remaining shares',
      'Present value',
    ]) {
      expect(text, `column "${head}" is not in the PDF`).toContain(head);
    }
    expect(text).toContain('$761,471');
    expect(text).toContain('$4,748,503');
    expect(brokenAmounts(pdf)).toEqual([]);
    for (const line of linesOf(pdf)) expect(line.x).toBeLessThan(PAGE_WIDTH - MARGIN);
  }, 120_000);

  /** The same schedule for a company whose ESOP stake runs to nine figures. */
  it('keeps the ESOP schedule whole at a billion-dollar equity value', async () => {
    const pdf = await render('esop', {
      ...SAMPLE_ESOP_RESULT,
      levels: {
        control: 1_400_000_000,
        marketable_minority: 1_147_540_984,
        nonmarketable_minority: 1_009_836_066,
      },
      repurchase_obligation: {
        schedule: [1, 2, 3].map((year) => ({
          year,
          share_price: 252.4 * year,
          shares_redeemed: 720_000 / year,
          repurchase_cost: 181_728_000 / year,
          remaining_shares: 11_280_000 / year,
          pv: 163_755_000 / year,
        })),
        total_obligation: 333_168_000,
        pv_of_obligation: 300_218_000,
        ending_share_balance: 3_760_000,
      },
    });
    expect(brokenAmounts(pdf)).toEqual([]);
    for (const line of linesOf(pdf)) expect(line.x).toBeLessThan(PAGE_WIDTH - MARGIN);
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
