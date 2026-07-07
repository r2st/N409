import { describe, expect, it } from 'vitest';
import { formatMoney, formatNumber } from '../src/lib/format';

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

  it('formats large share counts with separators', () => {
    expect(formatNumber('10000000')).toBe('10,000,000');
    expect(formatNumber(null)).toBe('—');
  });
});
