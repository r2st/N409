import { describe, expect, it } from 'vitest';
import { formatAmount, formatMoney, formatNumber } from '../src/lib/format';

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
