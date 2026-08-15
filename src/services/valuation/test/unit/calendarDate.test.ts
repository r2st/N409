import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calendarDate, calendarDateOf, calendarDateOrNull } from '../../src/domain/calendarDate.js';
import { buildCapTableGraph } from '../../src/domain/capTableGraph.js';
import { valuationTemplateVars } from '../../src/domain/communications.js';
import { toIsoDate, vestingTimeline } from '../../src/domain/vesting.js';
import { isoDate, resolveWindow } from '../../src/domain/volatility.js';

/**
 * The whole point of this file is the time zone it runs in.
 *
 * The bug being pinned only exists east of UTC, and the host these tests
 * normally run on is UTC — where local midnight and UTC midnight coincide, the
 * broken expression and the correct one agree on every input, and a test
 * asserting the right answer passes against either. So the assertions below
 * would have been decorative on CI.
 *
 * Setting `process.env.TZ` moves the process's local zone for real: Node
 * re-reads it and every subsequent `new Date(...)` and `getFullYear()` answers
 * in the new zone. Asia/Tokyo is UTC+09:00 with no DST, so local midnight is
 * 15:00 the *previous* day in UTC — the largest and simplest version of the
 * shift.
 *
 * Restored afterwards because vitest may run other files in this same worker,
 * and a leaked TZ would silently re-judge their date assertions.
 */
const REAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Tokyo';
});
afterAll(() => {
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

/**
 * What node-postgres hands back for a `date` (OID 1082): midnight *local*.
 *
 * Constructed the same way the driver does, rather than parsed from a string,
 * because `new Date('2026-06-30')` is parsed as UTC midnight and would be a
 * different value — the one this bug does not involve.
 */
const pgDate = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe('the shift this exists to prevent', () => {
  it('is real: toISOString dates a `date` column a day early east of UTC', () => {
    // Not an assertion about our code — an assertion about the premise. If this
    // ever stops holding, every test below is passing for the wrong reason.
    expect(pgDate(2026, 6, 30).toISOString().slice(0, 10)).toBe('2026-06-29');
    expect(new Date().getTimezoneOffset()).toBeLessThan(0);
  });

  it('returns the day the column actually holds', () => {
    expect(calendarDate(pgDate(2026, 6, 30))).toBe('2026-06-30');
  });

  it('holds at the boundaries a shift would cross', () => {
    expect(calendarDate(pgDate(2026, 1, 1))).toBe('2026-01-01'); // year
    expect(calendarDate(pgDate(2026, 3, 1))).toBe('2026-03-01'); // month
    expect(calendarDate(pgDate(2024, 3, 1))).toBe('2024-03-01'); // leap-year month
  });

  it('pads, so the string is sortable and parseable', () => {
    expect(calendarDate(pgDate(2026, 1, 5))).toBe('2026-01-05');
  });

  it('trusts a string as already being the day it says', () => {
    // The in-memory callers — a request body, a fixture, a value normalised
    // upstream — pass a string, and re-parsing it into a Date would reintroduce
    // exactly the zone question this avoids.
    expect(calendarDateOf('2026-06-30')).toBe('2026-06-30');
    expect(calendarDateOf('2026-06-30T00:00:00.000Z')).toBe('2026-06-30');
  });

  it('passes absence through rather than inventing a day', () => {
    expect(calendarDateOrNull(null)).toBe(null);
    expect(calendarDateOrNull(undefined)).toBe(null);
    expect(calendarDateOrNull('')).toBe(null);
  });
});

/**
 * The call sites. Each of these reads a real `date` column, and each was a
 * different way for one client-visible day to move backwards.
 */
describe('the columns that were moving', () => {
  it('dates a funding round to the day it closed (rounds.closed_on)', () => {
    const graph = buildCapTableGraph({
      companyName: 'Northwind',
      entries: [],
      rounds: [{ id: 'r1', name: 'Series A', closed_on: pgDate(2026, 6, 30), shares_issued: null }],
    });
    const round = graph.nodes.find((n) => n.kind === 'funding_round');
    expect(round?.label).toBe('Series A (2026-06-30)');
  });

  it('dates a grant to the day it was granted (grants.grant_date)', () => {
    expect(toIsoDate(pgDate(2026, 6, 30))).toBe('2026-06-30');
  });

  it('dates the engagement in a client email (valuations.valuation_date)', () => {
    const vars = valuationTemplateVars({
      company_name: 'Northwind',
      kind: '409a',
      valuation_date: pgDate(2026, 6, 30),
    });
    expect(vars.valuation_date).toBe('2026-06-30');
  });

  it('dates a volatility window from the valuation date it is anchored on', () => {
    expect(isoDate(pgDate(2026, 6, 30))).toBe('2026-06-30');
    // resolveWindow anchors the end on the engagement's valuation date, so the
    // exhibit reported a window ending the day before the valuation it supports.
    const { end } = resolveWindow(pgDate(2026, 6, 30), 365, pgDate(2026, 7, 1));
    expect(end).toBe('2026-06-30');
  });
});

/**
 * The other half of the fix, and the reason it could not be a single sweep.
 *
 * A Date built deliberately in UTC has its day in UTC, and reading *it* from
 * local parts introduces the same error in the opposite direction. These pin
 * that the two rules stayed separate.
 */
describe('the dates that were right already', () => {
  it('leaves UTC-anchored vesting arithmetic alone', () => {
    // vestingTimeline turns the start day into `${iso}T00:00:00Z` and walks it
    // with setUTCMonth, so its points are UTC-midnight Dates formatted through
    // toISOString. A monthly point must land on the day of the month it vests,
    // not the day before.
    const points = vestingTimeline({
      vestingStartDate: '2026-01-31',
      vestingMonths: 12,
      cliffMonths: 0,
      frequencyMonths: 1,
      totalShares: 1200,
    });
    expect(points[0]?.date).toBe('2026-01-31');
    expect(points.some((p) => p.date.endsWith('-01'))).toBe(false);
  });

  it('round-trips a stored day through the arithmetic and back unmoved', () => {
    // The composition that matters: local in (a `date` column), UTC out (a Date
    // this code built). Getting either half wrong moves the day.
    const stored = pgDate(2026, 6, 30);
    const timeline = vestingTimeline({
      vestingStartDate: toIsoDate(stored),
      vestingMonths: 12,
      cliffMonths: 0,
      frequencyMonths: 12,
      totalShares: 1200,
    });
    expect(timeline[0]?.date).toBe('2026-06-30');
    expect(timeline.at(-1)?.date).toBe('2027-06-30');
  });
});
