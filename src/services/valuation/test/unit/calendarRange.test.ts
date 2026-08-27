import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  calendarDate,
  isStorableDate,
  MAX_CALENDAR_DATE,
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_DATE,
  MIN_CALENDAR_YEAR,
} from '../../src/domain/calendarRange.js';

/**
 * The bound behind `dateWindowFields` and `blog.published_at`.
 *
 * `schemaBoundaryInputs.test.ts` is the half that needs Postgres — that the
 * window which used to 500 out of the driver now 400s at the schema. This file
 * is the range itself, and the two ways it is easy to get wrong.
 */

describe('the gap this closes', () => {
  it('is a date zod accepts and Postgres will not', () => {
    // Well-formed extended ISO 8601. `new Date` parses it; `z.coerce.date()`
    // asks only "is it an Invalid Date", so the schema is satisfied.
    const ancient = z.coerce.date().safeParse('-005000-01-01T00:00:00.000Z');
    expect(ancient.success).toBe(true);
    expect(ancient.success && ancient.data.getUTCFullYear()).toBe(-5000);
    // Postgres `timestamptz` starts at 4714 BC, so binding that as a parameter
    // is `22008 timestamp out of range` — on a read as much as on a write,
    // because the comparison has to parse it before it can compare anything.
  });

  it('is not reachable through the other date spelling', () => {
    // `z.string().datetime()` matches a four-digit year and nothing else, which
    // is why `due_at` and `occurred_at` were never exposed. The coerced
    // spelling now agrees with it on purpose rather than by accident.
    expect(z.string().datetime().safeParse('-005000-01-01T00:00:00.000Z').success).toBe(false);
    expect(z.string().datetime().safeParse('+275760-09-13T00:00:00.000Z').success).toBe(false);
  });
});

describe('the range', () => {
  it('starts at year 1 and not at 1901', () => {
    // `Date.UTC(1, ...)` is 1901: the two-digit-year rule maps 0–99 onto
    // 1900–1999. A floor built that way admits every ancient date it exists to
    // refuse, and looks right in the source.
    expect(MIN_CALENDAR_DATE.getUTCFullYear()).toBe(MIN_CALENDAR_YEAR);
    expect(MIN_CALENDAR_DATE.getUTCFullYear()).not.toBe(1901);
    expect(MAX_CALENDAR_DATE.getUTCFullYear()).toBe(MAX_CALENDAR_YEAR);
  });

  it('admits both ends of itself', () => {
    expect(isStorableDate(MIN_CALENDAR_DATE)).toBe(true);
    expect(isStorableDate(MAX_CALENDAR_DATE)).toBe(true);
    expect(isStorableDate(new Date('2026-08-27T00:00:00.000Z'))).toBe(true);
  });

  it('refuses one millisecond outside either end', () => {
    expect(isStorableDate(new Date(MIN_CALENDAR_DATE.getTime() - 1))).toBe(false);
    expect(isStorableDate(new Date(MAX_CALENDAR_DATE.getTime() + 1))).toBe(false);
  });

  it('refuses the extremes of the JavaScript range', () => {
    expect(isStorableDate(new Date(8.64e15))).toBe(false);
    expect(isStorableDate(new Date(-8.64e15))).toBe(false);
    expect(isStorableDate(new Date(NaN))).toBe(false);
  });
});

describe('calendarDate()', () => {
  const parse = (v: unknown) => calendarDate().safeParse(v);

  it('still coerces what the query strings actually carry', () => {
    expect(parse('2026-08-27').success).toBe(true);
    expect(parse('2026-08-27T12:00:00.000Z').success).toBe(true);
    expect(parse(new Date('2026-08-27')).success).toBe(true);
  });

  it('refuses the out-of-range instants that used to reach the driver', () => {
    for (const bad of [
      '-005000-01-01T00:00:00.000Z',
      '-271821-04-20T00:00:00.000Z',
      '+275760-09-13T00:00:00.000Z',
    ]) {
      expect(parse(bad).success, bad).toBe(false);
    }
  });

  it('still refuses what was never a date', () => {
    expect(parse('not-a-date').success).toBe(false);
    expect(parse('').success).toBe(false);
  });

  it('refuses an epoch handed over as a number past the range', () => {
    // `z.coerce.date()` takes a number as milliseconds, so a body field is a
    // second way in that no query string offers.
    expect(parse(-8.64e15).success).toBe(false);
    expect(parse(0).success).toBe(true);
  });
});
