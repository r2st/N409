/**
 * Bare calendar dates (`YYYY-MM-DD`) — the shape every date column in this
 * platform holds and every route accepts.
 *
 * `/^\d{4}-\d{2}-\d{2}$/` is a *shape* check, and it was being used as a
 * validity check. It admits `2026-02-31`, `2026-13-01`, `2026-00-10` and
 * `2026-02-29` in a non-leap year, none of which are days, and what happens
 * next depends only on where the string lands:
 *
 * * straight into a `date` column — Postgres refuses it and the unhandled
 *   driver error surfaces as a 500 where the honest answer is a 422;
 * * into `new Date(...)` — JavaScript rolls it forward without a word, so
 *   `2026-02-31` silently becomes `2026-03-03` and `2026-02-29` becomes
 *   `2026-03-01`. On a grant's vesting start or a valuation date, that is a
 *   wrong answer nothing downstream can detect.
 *
 * The second is the reason this lives in shared rather than being fixed per
 * route: a 500 is at least visible.
 */

const ISO_DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days in each month of a common year; February is special-cased below. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * True when `value` is a real day on the proleptic Gregorian calendar.
 *
 * Counting days directly rather than round-tripping through `Date`: the obvious
 * `new Date(Date.UTC(y, m - 1, d))` round-trip rejects every year from 0 to 99,
 * because `Date.UTC` maps a two-digit year argument to 1900-1999 and the
 * comparison then fails for a date that is perfectly real. Years that old are
 * nonsense for a valuation, but they are the intake form's *typo* case
 * (`0202-05-14` is one slipped keystroke), and a check named "is this a real
 * date" should reject those for being out of range somewhere that says so —
 * not silently, here, for an unrelated reason.
 */
export function isIsoCalendarDate(value: string): boolean {
  const m = ISO_DATE_SHAPE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const limit = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day <= limit;
}

/** Human-readable reason a value is not a calendar date, or null when it is. */
export function isoCalendarDateError(value: string): string | null {
  if (!ISO_DATE_SHAPE.test(value)) return 'Expected YYYY-MM-DD';
  if (isIsoCalendarDate(value)) return null;
  return `${value} is not a real calendar date`;
}
