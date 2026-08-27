import { z } from 'zod';

/**
 * The years a `Date` is allowed to hold before it reaches Postgres.
 *
 * `z.coerce.date()` is `new Date(input)` followed by "is it an Invalid Date",
 * and nothing else. A JavaScript date spans ISO years -271821 to +275760;
 * Postgres `timestamptz` spans 4714 BC to 294276 AD. The overlap is not the
 * whole of either, and the part of the JavaScript range that falls outside
 * Postgres is reachable from a query string: `?from=-005000-01-01T00:00:00.000Z`
 * is a well-formed extended-ISO instant, parses to a real Date, satisfies the
 * schema, and is refused by the driver with `22008 timestamp out of range` the
 * moment it is bound as a parameter — a 500 out of `GET /api/v1/admin/events`
 * for a value the schema said was fine.
 *
 * Note that the *comparison* is enough to trigger it. The out-of-range instant
 * never has to be stored: it is a `WHERE occurred_at >= $1`, so Postgres parses
 * the parameter into a timestamp before it can compare anything, and fails
 * there. Every read filtered on a caller-supplied date is exposed, not just the
 * writes.
 *
 * ## Why years 1–9999 rather than Postgres's actual edge
 *
 * Two reasons, and neither is timidity about the exact boundary.
 *
 * The first is that the exact boundary moves. Postgres resolves an ancient
 * instant against the session time zone, and for dates before standardised
 * zones that offset is the location's *local mean time* — the box this was
 * measured on answered `+05:53`. So the last representable millisecond differs
 * between two servers that agree on everything else, and a bound pinned to it
 * would be a bound that passes here and fails there.
 *
 * The second is that this is the range the codebase already commits to
 * elsewhere. `z.string().datetime()` — how `due_at` and `occurred_at` are
 * spelled — accepts a four-digit year and nothing else, so those fields have
 * been bounded to 1–9999 all along, by accident of zod's regex rather than by
 * anyone deciding it. Applying the same range to the coerced spelling makes the
 * two agree on purpose, and leaves both comfortably inside Postgres in any time
 * zone.
 */
export const MIN_CALENDAR_YEAR = 1;
export const MAX_CALENDAR_YEAR = 9999;

/** Inclusive bounds, in UTC, of the range described above. */
export const MIN_CALENDAR_DATE = new Date(Date.UTC(1, 0, 1));
export const MAX_CALENDAR_DATE = new Date(Date.UTC(9999, 11, 31, 23, 59, 59, 999));

// `Date.UTC` maps years 0–99 onto 1900–1999, which would put the floor in the
// twentieth century and let every ancient date through the bound meant to stop
// them. `setUTCFullYear` is the documented way back out.
MIN_CALENDAR_DATE.setUTCFullYear(MIN_CALENDAR_YEAR);

/** True when `value` is a date Postgres will accept in any session time zone. */
export function isStorableDate(value: Date): boolean {
  const t = value.getTime();
  return Number.isFinite(t) && t >= MIN_CALENDAR_DATE.getTime() && t <= MAX_CALENDAR_DATE.getTime();
}

/**
 * `z.coerce.date()` with the range above applied.
 *
 * Use this anywhere a caller-supplied date is coerced. The bare spelling is
 * banned by `schemaBoundaryCensus.test.ts`, so a new one fails there rather
 * than in someone's audit log.
 */
export const calendarDate = () =>
  z.coerce
    .date()
    .refine(isStorableDate, `must be a date between year ${MIN_CALENDAR_YEAR} and ${MAX_CALENDAR_YEAR}`);
