import { describe, expect, it } from 'vitest';
import { CountryCode, CurrencyCode, isCurrencyCode } from '../../src/domain/currency.js';

/**
 * The write boundaries used to spell this `z.string().length(3)`, which checks
 * a length and not a code. `Intl.NumberFormat` throws a RangeError for a code
 * that is not three letters, so a valuation stored with `"123"` crashed every
 * money value the browser rendered — for as long as the row existed.
 */
describe('CurrencyCode', () => {
  it('accepts a three-letter code and normalises it to upper case', () => {
    expect(CurrencyCode.parse('USD')).toBe('USD');
    expect(CurrencyCode.parse('usd')).toBe('USD');
    expect(CurrencyCode.parse('gBp')).toBe('GBP');
    expect(CurrencyCode.parse(' eur ')).toBe('EUR');
  });

  it('accepts a well-formed code Intl does not recognise', () => {
    // Intl formats these rather than throwing, and the assigned-code list
    // changes without us — rejecting them would refuse real currencies.
    expect(CurrencyCode.parse('XBT')).toBe('XBT');
    expect(() => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'XBT' })).not.toThrow();
  });

  it('rejects the three-character strings that are not codes', () => {
    for (const bad of ['123', '$$$', 'us1', 'U S', 'US-', '€€€']) {
      expect(() => CurrencyCode.parse(bad)).toThrow();
      // Each of these is what Intl refuses, which is the point of the check.
      expect(() => new Intl.NumberFormat('en-US', { style: 'currency', currency: bad }).format(1)).toThrow(
        RangeError,
      );
    }
  });

  it('rejects the wrong length', () => {
    expect(() => CurrencyCode.parse('US')).toThrow();
    expect(() => CurrencyCode.parse('USDX')).toThrow();
    expect(() => CurrencyCode.parse('')).toThrow();
  });

  it('isCurrencyCode agrees with the schema', () => {
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('usd')).toBe(true);
    expect(isCurrencyCode('123')).toBe(false);
    expect(isCurrencyCode('USDX')).toBe(false);
  });
});

/**
 * R343, M19 — the same gap, one field over. `service_countries` was spelled
 * `z.string().length(2)` at all three of its doors while every one of them
 * documented the field as "ISO-3166 alpha-2", so `"12"` and `"$$"` reached the
 * `text[]` column from a partner API key, and `"gb"` and `"GB"` were stored as
 * two distinct members of a set the auditor workbook joins into one cell.
 */
describe('CountryCode', () => {
  it('accepts a two-letter code and normalises it to upper case', () => {
    expect(CountryCode.parse('US')).toBe('US');
    expect(CountryCode.parse('gb')).toBe('GB');
    expect(CountryCode.parse('dE')).toBe('DE');
    expect(CountryCode.parse(' fr ')).toBe('FR');
  });

  it('accepts a well-formed code that is not assigned today', () => {
    // The assigned list changes without us; a code this platform has not heard
    // of is a country it should not be refusing to serve.
    expect(CountryCode.parse('zz')).toBe('ZZ');
  });

  it('rejects the two-character strings that are not codes', () => {
    for (const bad of ['12', '$$', '  ', 'U1', 'U-', '€€']) {
      expect(() => CountryCode.parse(bad)).toThrow();
    }
  });

  it('rejects the wrong length', () => {
    expect(() => CountryCode.parse('U')).toThrow();
    expect(() => CountryCode.parse('USA')).toThrow();
    expect(() => CountryCode.parse('')).toThrow();
  });
});
