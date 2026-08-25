/**
 * The whole point of this file is the time zone it runs in.
 *
 * `new Date('2026-03-15')` is specified to parse the date-only form as UTC
 * midnight, so `toLocaleDateString` renders whatever *local* day that instant
 * falls on. At or east of Greenwich that is the same day and the broken
 * expression agrees with the correct one on every input — which is why an
 * assertion written on a UTC runner would be decorative. West of Greenwich it
 * is the day before.
 *
 * America/Los_Angeles is the mirror image of the Asia/Tokyo zone the valuation
 * service's `calendarDate` tests use, and it is where this product's users
 * actually are: a 409A platform's market is the United States, so the zone that
 * breaks is the ordinary case rather than the exotic one.
 *
 * The zone is restored afterwards because vitest reuses workers across files,
 * and a leaked TZ would silently re-judge every other date assertion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from '../src/lib/format';

const REAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

/**
 * What the day *should* render as, built from local parts so the assertion
 * does not depend on the runner's locale — only on which day it names.
 */
function localDay(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

describe('a calendar day west of Greenwich', () => {
  it('is the zone where the bug exists', () => {
    // The vacuity guard: every assertion below passes under UTC whether or not
    // the fix is present, so the file is worthless if the TZ did not take.
    expect(new Date().getTimezoneOffset()).toBeGreaterThan(0);
    // And the shape of the bug, stated directly.
    expect(new Date('2026-03-15').getDate()).toBe(14);
  });

  it('renders the day the string names, not the day before', () => {
    // A funding round that closed on the 15th — `closed_on` is a Postgres
    // `date` and arrives as `2026-03-15`.
    expect(formatDate('2026-03-15')).toBe(localDay(2026, 3, 15));
  });

  it('holds across a year boundary, where the slip changes the year too', () => {
    expect(formatDate('2026-01-01')).toBe(localDay(2026, 1, 1));
  });

  it('holds on the day the clocks go forward', () => {
    // 2026-03-08 is the DST transition in this zone; local midnight still
    // exists, but it is the kind of day an offset-arithmetic fix gets wrong.
    expect(formatDate('2026-03-08')).toBe(localDay(2026, 3, 8));
  });

  it('leaves a real instant alone', () => {
    // A `timestamptz` names a moment, and which local day it falls on is the
    // right question to ask of it. 08:00 UTC is still the 15th in California.
    expect(formatDate('2026-03-15T08:00:00.000Z')).toBe(localDay(2026, 3, 15));
    // …and 04:00 UTC is not — this is the case the anchored pattern protects.
    expect(formatDate('2026-03-15T04:00:00.000Z')).toBe(localDay(2026, 3, 14));
  });

  it('reads a calendar day the same way in formatDateTime', () => {
    expect(formatDateTime('2026-03-15')).toContain(localDay(2026, 3, 15));
  });

  it('still renders a dash for a day that does not exist', () => {
    // The constructor rolls these forward rather than refusing them, so
    // without a parts check `2026-02-30` would render as March 2nd.
    expect(formatDate('2026-02-30')).toBe('—');
    expect(formatDate('2026-13-01')).toBe('—');
    expect(formatDate('2027-02-29')).toBe('—');
  });

  it('does not read a two-digit-looking year as 19xx', () => {
    // `new Date(26, 0, 1)` is 1926 — the constructor's own two-digit mapping,
    // which is why `localDay` cannot express the expectation and this one is
    // built the long way.
    const year26 = new Date(26, 0, 1);
    year26.setFullYear(26);
    expect(formatDate('0026-01-01')).toBe(
      year26.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    );
    expect(formatDate('0026-01-01')).not.toContain('1926');
  });

  it('still renders a dash for nothing at all', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });
});
