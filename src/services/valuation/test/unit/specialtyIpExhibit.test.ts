/**
 * The intangible-asset exhibit, against the shapes `value_intangible` really
 * returns.
 *
 * `intangibleExhibit` read `pv_before_tab`, `pv`, `tab`, `discount_rate`,
 * `royalty_rate` and `tax_rate`. The engine returns none of them: the first
 * three under different names, the last three not at all, because they are
 * inputs the result does not echo. Every row the exhibit built was therefore
 * dropped and `rows.length > 0` was false for every IP valuation ever run, so
 * the deliverable for an asset priced by a discounted royalty stream was one
 * sentence stating a number — no method named, no schedule, nothing between
 * the cash flows and the conclusion.
 *
 * Nothing failed. The exhibit rendered, the section had a heading, and the
 * degradation tests that check it survives a hostile payload passed on a
 * payload that produced the same output as a correct one.
 *
 * Found by `specialtyResultCoverage.test.ts`, the census over result keys the
 * exhibits never read — the first finding it made that a person had not
 * already made by hand.
 */

import { describe, expect, it } from 'vitest';
import { buildSpecialtyExhibits } from '../../src/domain/specialtyExhibits.js';
import { SAMPLE_IP_RESULT } from '../../src/domain/specialtySamples.js';
import type { CalculationRow } from '../../src/repos/calculations.js';

const ctx = { currency: 'USD', companyName: 'Northwind Robotics, Inc.', valuationDate: '2026-03-31' };

function calc(specialty: Record<string, unknown>): CalculationRow {
  return {
    id: '01J',
    valuation_id: '01K',
    engine_version: 'test',
    status: 'succeeded',
    inputs: {},
    results: { kind: 'ip', specialty },
    equity_value: null,
    fmv_per_share: null,
    error: null,
    diagnostics: [],
    created_by: null,
    created_at: new Date(),
  };
}

const html = (specialty: Record<string, unknown>) => {
  const sections = buildSpecialtyExhibits(calc(specialty), ctx);
  expect(sections).toHaveLength(1);
  return sections[0]!.html;
};

describe('intangible asset exhibit', () => {
  it('names the method the run dispatched to', () => {
    expect(html(SAMPLE_IP_RESULT)).toContain('Relief from royalty');
  });

  it('prints the royalty schedule the conclusion is discounted from', () => {
    const out = html(SAMPLE_IP_RESULT);
    expect(out).toContain('Royalty savings');
    expect(out).toContain('$8,400,000'); // year 1 revenue
    expect(out).toContain('$420,000'); // year 1 royalty savings
    expect(out).toContain('$283,590'); // year 1 present value
    expect(out).toContain('$11,205,810'); // year 5 revenue
  });

  it('bridges the explicit and terminal present values to the conclusion', () => {
    const out = html(SAMPLE_IP_RESULT);
    expect(out).toContain('Present value of the explicit forecast');
    expect(out).toContain('$1,227,733');
    expect(out).toContain('Present value of the terminal period');
    expect(out).toContain('$1,372,840');
    expect(out).toContain('$2,600,573'); // value before TAB
    expect(out).toContain('$2,810,029'); // concluded fair value
  });

  /**
   * `tab_multiplier` is 1.0805 — a factor, not an amount. Running it through
   * the currency formatter would print "$1" against a seven-figure conclusion,
   * which is the shape of the mistake this exhibit already made once.
   */
  it('states the tax amortization benefit as a factor and as the amount it adds', () => {
    const out = html(SAMPLE_IP_RESULT);
    expect(out).toContain('×1.0805');
    // 2,810,028.83 − 2,600,573.16
    expect(out).toContain('$209,456');
    expect(out).not.toContain('$1.0805');
  });

  it('renders the MEEM chain in the order the method builds it', () => {
    const out = html({
      method: 'meem',
      schedule: [
        {
          year: 1,
          revenue: 10_000_000,
          survival: 0.85,
          attributable_revenue: 8_500_000,
          ebit: 2_125_000,
          after_tax_earnings: 1_678_750,
          contributory_charge: 510_000,
          excess_earnings: 1_168_750,
          pv: 1_007_543,
        },
      ],
      value_before_tab: 2_140_774,
      tab_multiplier: 1.0846650327793148,
      fair_value: 2_322_022,
    });
    expect(out).toContain('Multi-period excess earnings');
    expect(out).toContain('Contributory charge');
    expect(out).toContain('85.0%'); // survival is a rate, not an amount
    expect(out).not.toContain('$0.85');
    // The charge is taken against the earnings above it, so it must print after.
    expect(out.indexOf('After-tax earnings')).toBeLessThan(out.indexOf('Contributory charge'));
    expect(out.indexOf('Contributory charge')).toBeLessThan(out.indexOf('Excess earnings'));
  });

  it('renders the with-and-without differential', () => {
    const out = html({
      method: 'with_and_without',
      schedule: [
        { year: 1, with: 1_000_000, without: 800_000, after_tax_differential: 158_000, pv: 136_207 },
      ],
      value_before_tab: 282_982,
      tab_multiplier: 1.0846650327793148,
      fair_value: 306_940,
    });
    expect(out).toContain('With the asset');
    expect(out).toContain('Without the asset');
    expect(out).toContain('$158,000');
  });

  /**
   * The cost approach has no cash-flow schedule, no TAB and no present values.
   * Its layers compound — each is taken against what the last one left — so an
   * exhibit that lists three amounts without saying so invites a reader to read
   * them as three percentages of the top line.
   */
  it('renders the cost approach layers and says that they compound', () => {
    const out = html({
      method: 'cost_approach',
      replacement_cost_new: 5_600_000,
      obsolescence: { physical: 560_000, functional: 756_000, economic: 214_200 },
      fair_value: 4_069_800,
    });
    expect(out).toContain('Cost approach');
    expect(out).toContain('Replacement cost new');
    expect(out).toContain('Less physical obsolescence');
    expect(out).toContain('$756,000');
    expect(out).toContain('layers compound');
    expect(out).toContain('$4,069,800');
    // No income-method furniture on a cost-approach exhibit.
    expect(out).not.toContain('Present value');
    expect(out).not.toContain('amortization benefit (×');
  });

  it('omits the compounding note when only one layer was taken', () => {
    const out = html({
      method: 'cost_approach',
      replacement_cost_new: 5_000_000,
      obsolescence: { physical: 500_000 },
      fair_value: 4_500_000,
    });
    expect(out).toContain('Less physical obsolescence');
    expect(out).not.toContain('layers compound');
  });

  /**
   * The degradation contract the other exhibits hold: an unfamiliar or partial
   * shape drops what it cannot render rather than throwing inside a render.
   */
  it('falls back to the bare conclusion when nothing else is renderable', () => {
    const out = html({ fair_value: 1_000_000 });
    expect(out).toContain('Concluded fair value');
    expect(out).toContain('$1,000,000');
  });

  it('drops a schedule whose method it does not recognise, keeping the bridge', () => {
    const out = html({
      method: 'some_future_method',
      schedule: [{ year: 1, whatever: 5 }],
      value_before_tab: 900_000,
      fair_value: 1_000_000,
    });
    expect(out).toContain('Some future method');
    expect(out).toContain('$900,000');
    expect(out).not.toContain('whatever');
  });

  it('renders nothing at all without a concluded fair value', () => {
    expect(buildSpecialtyExhibits(calc({ method: 'meem', schedule: [] }), ctx)).toEqual([]);
  });
});
