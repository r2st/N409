import { describe, expect, it } from 'vitest';
import { formatAmount, formatMoney, formatNumber, moneyFormatter, ordinal } from '../src/lib/format';

describe('money & number formatting (M4)', () => {
  it('formats integer cents as currency', () => {
    expect(formatMoney(250050, 'USD')).toBe('$2,500.50');
    expect(formatMoney('500000000', 'USD')).toBe('$5,000,000.00');
  });

  it('falls back to USD when currency is missing', () => {
    expect(formatMoney(100, null)).toBe('$1.00');
  });

  it('renders a dash for absent or invalid values', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney('')).toBe('—');
    expect(formatMoney('not-a-number')).toBe('—');
  });

  it('formats major-unit amounts without the cents conversion', () => {
    // Cap-table figures come from the customer's spreadsheet as dollars, so
    // they must not be divided by 100 the way formatMoney does.
    expect(formatAmount(2500.5, 'USD')).toBe('$2,500.50');
    expect(formatAmount(1_870_000, 'USD')).toBe('$1,870,000.00');
    expect(formatMoney(1_870_000, 'USD')).toBe('$18,700.00'); // contrast: cents
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
    expect(() => formatMoney(250050, '123')).not.toThrow();
    expect(formatMoney(250050, '123')).toBe('123 2,500.50');
    expect(formatAmount(2500.5, '$$$')).toBe('$$$ 2,500.50');
    expect(moneyFormatter('us1', { maximumFractionDigits: 0 })(1234)).toBe('us1 1,234');
  });

  it('still uses Intl for a well-formed code', () => {
    expect(formatMoney(250050, 'EUR')).toBe('€2,500.50');
    // Well-formed but unassigned: Intl prints the code itself, no throw.
    // (Intl separates it with a non-breaking space; the fallback uses a plain
    // one, which is how the two cases are told apart here.)
    expect(formatMoney(250050, 'ABC')).toBe('ABC\u00a02,500.50');
  });

  it('falls back to USD for an empty code rather than printing a blank prefix', () => {
    expect(formatMoney(100, '')).toBe('$1.00');
    expect(moneyFormatter(undefined)(1)).toBe('$1.00');
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
