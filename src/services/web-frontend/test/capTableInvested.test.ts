/**
 * The Invested column the Cap table tab shows, against the one the exports do.
 *
 * `invested_amount` is a column an administrator's sheet frequently leaves
 * blank beside a stated round price, so every server-side reader of a cap table
 * derives it — `price × shares` when the amount column is empty. The tab
 * rendered the raw column instead and showed "—", disagreeing with the auditor
 * workbook exported from the same table, with the cap-table graph, with the
 * engine's waterfall inputs, and with the Preference stack total printed a few
 * lines below it on the tab's own summary.
 *
 * FIXTURES below is the contract. The same list is asserted against the real
 * `domain/capTable.investedAmount` and `export/valuationWorkbook`'s Invested
 * column in the valuation service's `test/unit/capTableInvestedParity.test.ts`;
 * if you add a case here, add it there.
 */
import { describe, expect, it } from 'vitest';
import { investedAmount, investedForDisplay, type InvestedEntry } from '../src/lib/capTableFigures';

interface Fixture {
  name: string;
  entry: InvestedEntry;
  /** `investedAmount` — the shared base of the preference stack. */
  invested: number;
  /** What the tab's Invested cell holds; null renders as an em dash. */
  displayed: number | null;
}

export const FIXTURES: Fixture[] = [
  {
    name: 'a preferred class stating its amount',
    entry: { class_type: 'preferred', shares: 1_000_000, price_per_share: 1.25, invested_amount: 1_250_000 },
    invested: 1_250_000,
    displayed: 1_250_000,
  },
  {
    name: 'the Carta shape: a preferred class with a price and no amount',
    entry: { class_type: 'preferred', shares: 2_000_000, price_per_share: 1.5, invested_amount: null },
    invested: 3_000_000,
    displayed: 3_000_000,
  },
  {
    name: 'a fractional price, which must not be rounded on the way to the cell',
    entry: { class_type: 'preferred', shares: 1_234_567, price_per_share: 0.0001, invested_amount: null },
    invested: 123.4567,
    displayed: 123.4567,
  },
  {
    name: 'a preferred class with neither column',
    entry: { class_type: 'preferred', shares: 500_000, price_per_share: null, invested_amount: null },
    invested: 0,
    displayed: null,
  },
  {
    name: 'a stated amount of zero, which is stated rather than missing',
    entry: { class_type: 'preferred', shares: 500_000, price_per_share: 2, invested_amount: 0 },
    invested: 0,
    displayed: null,
  },
  {
    name: 'common at a founder price, which has not invested its issue value',
    entry: { class_type: 'common', shares: 8_000_000, price_per_share: 0.0001, invested_amount: null },
    invested: 800,
    displayed: null,
  },
  {
    name: 'common stating an amount, which the preview must keep showing',
    entry: { class_type: 'common', shares: 8_000_000, price_per_share: 0.0001, invested_amount: 800 },
    invested: 800,
    displayed: 800,
  },
  {
    name: 'an option pool, which never carries a preference',
    entry: { class_type: 'option', shares: 1_000_000, price_per_share: null, invested_amount: null },
    invested: 0,
    displayed: null,
  },
];

describe('cap table invested amount', () => {
  it.each(FIXTURES)('$name', ({ entry, invested, displayed }) => {
    expect(investedAmount(entry)).toBeCloseTo(invested, 6);
    if (displayed === null) expect(investedForDisplay(entry)).toBeNull();
    else expect(investedForDisplay(entry)!).toBeCloseTo(displayed, 6);
  });

  /**
   * The regression itself, stated as the thing a reader would notice: the rows
   * they can see have to add up to the preference-stack total shown beside
   * them. Before the fix the visible cells summed to nothing at all.
   */
  it('shows the figures the preference stack is totalled from', () => {
    const table: InvestedEntry[] = [
      { class_type: 'common', shares: 8_000_000, price_per_share: 0.0001, invested_amount: null },
      { class_type: 'preferred', shares: 2_000_000, price_per_share: 1.5, invested_amount: null },
      { class_type: 'preferred', shares: 1_000_000, price_per_share: 3, invested_amount: null },
    ];
    const stack = table
      .filter((e) => e.class_type === 'preferred')
      .reduce((sum, e) => sum + investedAmount(e), 0);
    const onScreen = table.reduce((sum, e) => sum + (investedForDisplay(e) ?? 0), 0);
    expect(stack).toBe(6_000_000);
    expect(onScreen).toBe(stack);
  });
});
