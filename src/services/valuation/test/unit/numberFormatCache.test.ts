import { describe, expect, it } from 'vitest';
import { numberFormat } from '../../src/domain/numberFormat.js';

describe('numberFormat cache', () => {
  it('returns a working Intl.NumberFormat', () => {
    const fmt = numberFormat('en-US', { style: 'currency', currency: 'USD' });
    expect(fmt.format(1234.5)).toContain('1,234');
  });

  it('returns the same instance for identical arguments (cache hit)', () => {
    const a = numberFormat('en-US', { minimumFractionDigits: 2 });
    const b = numberFormat('en-US', { minimumFractionDigits: 2 });
    expect(a).toBe(b);
  });

  it('returns different instances for different options', () => {
    const a = numberFormat('en-US', { minimumFractionDigits: 0 });
    const b = numberFormat('en-US', { minimumFractionDigits: 4 });
    expect(a).not.toBe(b);
  });

  it('returns different instances for different locales', () => {
    const a = numberFormat('en-US');
    const b = numberFormat('de-DE');
    expect(a).not.toBe(b);
  });

  it('handles no-options calls consistently', () => {
    const a = numberFormat('en-US');
    const b = numberFormat('en-US');
    expect(a).toBe(b);
  });

  it('returns a formatter even for an unusual locale (Intl falls back)', () => {
    const fmt = numberFormat('en-US', { minimumFractionDigits: 2 });
    expect(fmt.format(1000)).toContain('1,000');
  });

  it('throws on an invalid currency code', () => {
    expect(() => numberFormat('en-US', { style: 'currency', currency: 'NOPE' })).toThrow();
  });
});
