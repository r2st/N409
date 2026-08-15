/**
 * `YYYY-MM-DD` from a `date` column, without routing it through UTC.
 *
 * A Postgres `date` (OID 1082) is a calendar day and carries no time zone at
 * all. node-postgres has to hand it back as *something*, and what it picks is a
 * JS Date at **midnight local time** — `2026-06-30` becomes
 * `2026-06-30T00:00:00` in whatever zone the process runs in. The Date is an
 * artifact of the driver, not a moment the column ever named.
 *
 * `toISOString().slice(0, 10)` then re-reads that artifact as an instant and
 * asks what UTC day it fell on. East of UTC it did not fall on the same one:
 * local midnight at UTC+02:00 is 22:00 the *previous* day in UTC, so every
 * `date` formatted that way comes out dated a day early. A valuation date, a
 * grant date, a round's closing date, the ends of a volatility window — each
 * silently moves backwards by one.
 *
 * This is latent rather than live: the Hetzner host runs UTC, where local
 * midnight and UTC midnight coincide and every site is right. It becomes wrong
 * the moment that is not true — a developer's laptop, a relocated host, a
 * container that inherits a zone — and it becomes wrong quietly, because an
 * off-by-one date looks like a date.
 *
 * Formatting from the local parts is the inverse of how the value was built, so
 * it returns the day the column actually holds, in every zone.
 *
 * ## When *not* to use this
 *
 * Only for values that came out of a `date` column. Two neighbouring cases look
 * identical in the source and must keep using `toISOString()`:
 *
 *   * A Date built deliberately in UTC — `new Date(\`${iso}T00:00:00Z\`)` with
 *     `setUTCDate`/`setUTCFullYear` arithmetic on it, as `vesting.ts` and
 *     `asc718.ts` do. Its local parts are the shifted ones; UTC is where its
 *     day lives, and reading it locally would introduce the very error this
 *     fixes, in the other direction.
 *
 *   * A `timestamptz`. That is a real instant, and which calendar day it counts
 *     as is a genuine question rather than a driver artifact. Rendering its UTC
 *     day is a choice — the one already made for `published_at`, `issued_at`
 *     and the report generation stamps — and not something to change here.
 */
export function calendarDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/**
 * The same, for the callers that receive either form.
 *
 * A `date` reaches these modules as a Date from the driver and as a string from
 * anything assembling the same shape in memory — a request body, a fixture, a
 * value already normalised upstream. Taking only the Date is how more than one
 * of these helpers first threw inside a render, so both are accepted and a
 * string is trusted as already being the day it says.
 */
export function calendarDateOf(value: Date | string): string {
  return value instanceof Date ? calendarDate(value) : String(value).slice(0, 10);
}

/** As {@link calendarDateOf}, but `null`/`undefined` in gives `null` out. */
export function calendarDateOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : calendarDateOf(value);
}
