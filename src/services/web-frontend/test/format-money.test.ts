import { describe, expect, it } from 'vitest';
import { formatAmount, formatCents, formatNumber, moneyFormatter, ordinal } from '../src/lib/format';
import { formatMoney } from '../src/lib/pipeline';

describe('money & number formatting (M4)', () => {
  it('formats integer cents as currency', () => {
    expect(formatCents(250050, 'USD')).toBe('$2,500.50');
    expect(formatCents('500000000', 'USD')).toBe('$5,000,000.00');
  });

  it('falls back to USD when currency is missing', () => {
    expect(formatCents(100, null)).toBe('$1.00');
  });

  it('renders a dash for absent or invalid values', () => {
    expect(formatCents(null)).toBe('—');
    expect(formatCents(undefined)).toBe('—');
    expect(formatCents('')).toBe('—');
    expect(formatCents('not-a-number')).toBe('—');
  });

  it('formats major-unit amounts without the cents conversion', () => {
    // Cap-table figures come from the customer's spreadsheet as dollars, so
    // they must not be divided by 100 the way formatCents does.
    expect(formatAmount(2500.5, 'USD')).toBe('$2,500.50');
    expect(formatAmount(1_870_000, 'USD')).toBe('$1,870,000.00');
    expect(formatCents(1_870_000, 'USD')).toBe('$18,700.00'); // contrast: cents
  });

  it('keeps sub-cent share prices legible instead of rounding to zero', () => {
    expect(formatAmount(0.001, 'USD')).toBe('$0.001');
    expect(formatAmount(0.0001, 'USD')).toBe('$0.0001');
    expect(formatAmount(1.45, 'USD')).toBe('$1.45');
    expect(formatAmount(0, 'USD')).toBe('$0.00');
  });

  it('renders a dash for absent or invalid amounts', () => {
    expect(formatAmount(null)).toBe('—');
    expect(formatAmount('')).toBe('—');
    expect(formatAmount('not-a-number')).toBe('—');
  });

  it('formats large share counts with separators', () => {
    expect(formatNumber('10000000')).toBe('10,000,000');
    expect(formatNumber(null)).toBe('—');
  });
});

// Intl.NumberFormat throws a RangeError for a currency that is not three
// letters, and inside render that unmounts the tree to the nearest error
// boundary — the whole page, not the one cell. The API used to accept such
// codes, so rows carrying one outlive the validation that now rejects them.
describe('a currency code Intl will not accept', () => {
  it('renders the amount instead of throwing', () => {
    expect(() => formatCents(250050, '123')).not.toThrow();
    expect(formatCents(250050, '123')).toBe('123 2,500.50');
    expect(formatAmount(2500.5, '$$$')).toBe('$$$ 2,500.50');
    expect(moneyFormatter('us1', { maximumFractionDigits: 0 })(1234)).toBe('us1 1,234');
  });

  it('still uses Intl for a well-formed code', () => {
    expect(formatCents(250050, 'EUR')).toBe('€2,500.50');
    // Well-formed but unassigned: Intl prints the code itself, no throw.
    // (Intl separates it with a non-breaking space; the fallback uses a plain
    // one, which is how the two cases are told apart here.)
    expect(formatCents(250050, 'ABC')).toBe('ABC\u00a02,500.50');
  });

  it('falls back to USD for an empty code rather than printing a blank prefix', () => {
    expect(formatCents(100, '')).toBe('$1.00');
    expect(moneyFormatter(undefined)(1)).toBe('$1.00');
  });
});

/**
 * The three money formatters, and the factor of a hundred between two of them.
 *
 * `formatCents` and `lib/pipeline`'s `formatMoney` were both called
 * `formatMoney`, in two modules, with opposite unit contracts — so which one a
 * component got was decided by its import line and looked identical at the
 * call site. GrantsTab and Asc718Tab got the dividing one for figures that were
 * never in cents and quoted a $2.50 option strike as $0.03.
 *
 * Written as one number formatted three ways, because the contrast is the
 * whole point: a rename can be undone, and this fails if it is.
 */
describe('the three of them, on one number', () => {
  it('divides by a hundred exactly once, and only in the one named for it', () => {
    // 250 of something. Minor units make it $2.50; major units make it $250.
    expect(formatCents(250, 'USD')).toBe('$2.50');
    expect(formatAmount(250, 'USD')).toBe('$250.00');
    expect(formatMoney(250, 'USD')).toBe('$250');
  });

  it('keeps the two major-unit formatters apart by their digits', () => {
    // `formatAmount` pins two places; `formatMoney` follows the magnitude — an
    // engine's per-share figure carries four, a total carries none.
    expect(formatAmount(2.5013, 'USD')).toBe('$2.50');
    expect(formatMoney(2.5013, 'USD')).toBe('$2.5013');
    expect(formatAmount(1_080_000, 'USD')).toBe('$1,080,000.00');
    expect(formatMoney(1_080_000, 'USD')).toBe('$1,080,000');
  });

  it('agrees on the absent value', () => {
    for (const f of [formatCents, formatAmount, formatMoney]) {
      expect(f(null)).toBe('—');
      expect(f(undefined)).toBe('—');
      expect(f('not-a-number')).toBe('—');
    }
  });
});

describe('ordinal', () => {
  it('uses the suffix that matches the last digit', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(62)).toBe('62nd');
    expect(ordinal(101)).toBe('101st');
  });

  it('gives the teens "th" regardless of their last digit', () => {
    // The rule the hardcoded "th" got right by accident and everything else wrong.
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(111)).toBe('111th');
    expect(ordinal(112)).toBe('112th');
  });

  it('handles zero and negatives without inventing a suffix', () => {
    expect(ordinal(0)).toBe('0th');
    expect(ordinal(-1)).toBe('-1st');
  });

  it('truncates toward zero rather than rendering a fraction', () => {
    expect(ordinal(2.7)).toBe('2nd');
  });
});
