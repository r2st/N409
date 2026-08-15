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
 * This is latent rather than live, but not for the reason it is tempting to
 * give. The Hetzner host runs America/New_York — checked, not assumed — where
 * local midnight is 05:00 the *same* UTC day, so the UTC day is the right one
 * and every site reads correctly. Anywhere at or west of UTC is safe like this;
 * the error exists only east of it, and there it is immediate. So the guard is
 * the host's offset being ≤ 0, which nothing enforces and a relocation would
 * silently spend. It becomes wrong quietly, because an off-by-one date looks
 * like a date.
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
 * Today, as a calendar day.
 *
 * The mirror image of the bug above, and the one that is live rather than
 * latent. Everything up to here is about reading a day *out* of a Date the
 * driver built; this is about writing one *in* from the clock, and the
 * expression the codebase reached for was `new Date().toISOString().slice(0,
 * 10)` — the UTC day, at eleven call sites.
 *
 * The UTC day is not today. It is today only while the process's offset from
 * UTC happens to be zero, and it fails in both directions:
 *
 *   * West of UTC — the Hetzner host, America/New_York, UTC−04:00 — the UTC day
 *     rolls over at 20:00 local. Between 8pm and midnight, "today" is tomorrow.
 *     A board resolution minted at 9pm is dated the day after the meeting that
 *     passed it; a debt instrument valued at 10pm is dated a day that has not
 *     happened; a fund mark is measured into the future. Each of those is a
 *     `date` column on a document a client receives, and a valuation dated
 *     ahead of itself is the kind of error an auditor finds rather than we do.
 *
 *   * East of UTC — every browser this runs in from Europe eastwards — the UTC
 *     day is still *yesterday* for the first hours of the morning. That is the
 *     half that reaches a user directly: `notFuture` compares the day they
 *     typed against this, so a founder in Sydney filling the intake at 9am is
 *     told the date they entered "cannot be in the future" for a date that is
 *     today. There is no value they can enter that the form accepts.
 *
 * Reading the local parts answers the question actually being asked — what day
 * is it here — in every zone, and collapses to the same string when the offset
 * is zero, which is why this went unnoticed on a UTC CI box.
 *
 * "Here" is the process's zone: the browser's for the frontend copy of this
 * rule, which is what a date typed into a form means; and for the server, the
 * host's — America/New_York on the Hetzner box, so a server-minted valuation
 * date is a US business day. That is a choice rather than a truth — the
 * client's own zone is not on the request — but it is the choice the
 * deliverables are written for, and it is at least a day that has begun
 * somewhere.
 *
 * Worth being exact about where that zone comes from, because it is not pinned:
 * nothing sets `TZ` in the units or the env file, so Node reads
 * `/etc/localtime` and the answer is host state rather than deployed config.
 * It has been America/New_York on that box since it was built, and the
 * behaviour above is correct today. But a rebuilt host, or a container that
 * defaults to UTC, would move every server-minted date by up to four hours
 * without a line of this repository changing — and the failure is the silent
 * kind this function exists to remove. `Environment=TZ=America/New_York` in
 * the systemd units would make the zone a deployed fact; until then, treat it
 * as an assumption that happens to hold.
 *
 * `at` exists so a caller can pass the instant under test. Defaulting it to the
 * clock is what every call site wants and what none of them should have to
 * write.
 */
export function todayLocal(at: Date = new Date()): string {
  return calendarDate(at);
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

/**
 * A driver row with its `date` columns rendered as the days they hold.
 *
 * The formatting above fixes a value once someone remembers to call it. This
 * fixes a *row*, at the one place every reader of that table goes through, and
 * it exists because the alternative was not working: the row interfaces declare
 * these columns `string` — `repos/transactions.ts` has said `occurred_on:
 * string` since it was written — while the driver hands back a Date. Nothing
 * type-checks the claim, so every consumer downstream is written against a
 * string that is not one, and the largest class of them do the thing the
 * declaration invites: send the row straight into a JSON response.
 *
 * That is where it surfaces. `JSON.stringify` reaches `Date.prototype.toJSON`,
 * i.e. `toISOString()`, and a column holding 2029-06-30 leaves as
 * `2029-06-29T15:00:00.000Z` — an instant, on the wrong day, for a value that
 * was never an instant. A client slicing the first ten characters, which is
 * exactly what a `YYYY-MM-DD` contract invites it to do, reads the day before.
 *
 * Normalising in the repo rather than at each send is deliberate. There are
 * more send sites than columns, they are added faster than they are audited,
 * and a route that forgets is silently wrong rather than broken. Past the repo
 * the declared type is true, and it is true for the workbook and the exhibits
 * and the audit diff as much as for the response.
 *
 * Only for columns that are `date` in the schema. A `timestamptz` — `created_at`
 * and every stamp like it — is a real instant whose ISO form is correct, and
 * passing one here would throw away the time.
 */
export function calendarDateRow<T extends object>(row: T, ...keys: Array<keyof T>): T {
  const out = { ...row };
  for (const key of keys) {
    const value = out[key];
    // Left alone unless it is a Date: a string is either already normalised or
    // came from somewhere that never had the problem, and `null` is a column
    // that is not set. The cast is the one place this file admits that a `date`
    // column typed `string` arrives as neither.
    if (value instanceof Date) out[key] = calendarDate(value) as T[keyof T];
  }
  return out;
}
