import { describe, expect, it } from 'vitest';
import { isIsoCalendarDate, isoCalendarDateError } from '../src/dates.js';

/**
 * `/^\d{4}-\d{2}-\d{2}$/` is a shape check, and every route schema in the
 * valuation service was using it as a validity check. What an impossible date
 * then did depended only on where the string landed: into a `date` column it
 * was a 500 from the driver, and into `new Date(...)` it was a silent roll
 * forward into the following month.
 */

describe('isIsoCalendarDate', () => {
  it('accepts ordinary days', () => {
    for (const d of ['2026-01-01', '2026-06-30', '2026-12-31', '1900-01-01', '2000-02-29']) {
      expect(isIsoCalendarDate(d), d).toBe(true);
    }
  });

  it('rejects the day-of-month overflows that used to roll forward silently', () => {
    // Each of these is what `new Date` turns them into, in comment form.
    expect(isIsoCalendarDate('2026-02-31')).toBe(false); // → 2026-03-03
    expect(isIsoCalendarDate('2026-04-31')).toBe(false); // → 2026-05-01
    expect(isIsoCalendarDate('2026-06-31')).toBe(false);
    expect(isIsoCalendarDate('2026-09-31')).toBe(false);
    expect(isIsoCalendarDate('2026-11-31')).toBe(false);
  });

  it('rejects 29 February in a common year but keeps it in a leap year', () => {
    expect(isIsoCalendarDate('2026-02-29')).toBe(false); // → 2026-03-01
    expect(isIsoCalendarDate('2024-02-29')).toBe(true);
    // Century rule: 1900 is not a leap year, 2000 is.
    expect(isIsoCalendarDate('1900-02-29')).toBe(false);
    expect(isIsoCalendarDate('2000-02-29')).toBe(true);
  });

  it('rejects out-of-range months and zero components', () => {
    for (const d of ['2026-13-01', '2026-00-10', '2026-01-00', '2026-99-99']) {
      expect(isIsoCalendarDate(d), d).toBe(false);
    }
  });

  it('rejects anything that is not the bare YYYY-MM-DD shape', () => {
    for (const d of [
      '',
      '2026-1-1',
      '26-01-01',
      '2026/01/01',
      '2026-01-01T00:00:00Z',
      '2026-01-01 ',
      ' 2026-01-01',
      'not-a-date',
      '20260101',
    ]) {
      expect(isIsoCalendarDate(d), JSON.stringify(d)).toBe(false);
    }
  });

  it('accepts a real day in a year below 100', () => {
    // The obvious `Date.UTC` round-trip rejects all of these, because Date.UTC
    // maps a two-digit year to 1900-1999. Absurd for a valuation, but that is
    // an out-of-range question the intake rules answer with a message that says
    // so — not something this check should decide silently as a side effect.
    expect(isIsoCalendarDate('0026-01-01')).toBe(true);
    expect(isIsoCalendarDate('0202-05-14')).toBe(true);
    expect(isIsoCalendarDate('0099-12-31')).toBe(true);
    // Leap rules still apply down there: year 4 is a leap year, year 100 is not.
    expect(isIsoCalendarDate('0004-02-29')).toBe(true);
    expect(isIsoCalendarDate('0100-02-29')).toBe(false);
  });
});

describe('isoCalendarDateError', () => {
  it('is null for a real date', () => {
    expect(isoCalendarDateError('2026-06-30')).toBeNull();
  });

  it('distinguishes a wrong shape from an impossible day', () => {
    expect(isoCalendarDateError('30/06/2026')).toBe('Expected YYYY-MM-DD');
    expect(isoCalendarDateError('2026-02-31')).toBe('2026-02-31 is not a real calendar date');
  });
});
