import { z } from 'zod';

/**
 * The ceiling on every number that ends up in an `integer` column.
 *
 * `domain/pagination.ts` bounded `page` because the repos multiply it into an
 * OFFSET and Postgres reads OFFSET as a bigint. This is the same failure one
 * type narrower, and it is the more common one: most numeric columns in the
 * schema are `integer` — int4 — not bigint.
 *
 *   valuations.delivery_days      integer
 *   grants.options_count          integer NOT NULL CHECK (options_count > 0)
 *   report_versions.version       integer NOT NULL
 *   prompt_versions.version       integer NOT NULL CHECK (version >= 1)
 *
 * A schema of `z.number().int().positive()` admits 3000000000. Zod is satisfied,
 * the handler is satisfied, and the driver hands it to Postgres, which answers
 *
 *   22003  value "3000000000" is out of range for type integer
 *
 * Nothing catches that, so a number one digit too long is a 500 rather than the
 * 422 naming the field that every other out-of-range value gets. On the read
 * paths it is worse than untidy: `GET .../report/versions/3000000000` is a 500
 * on a route whose entire job is to answer 404 for a version that does not
 * exist, which makes it an error-shape oracle for whether a report exists at
 * all.
 *
 * The bound is int4's own maximum, not a business rule. It says only "this
 * could be stored"; a column that wants a tighter range still declares one
 * (`vesting_months` stops at 240, `frequency_months` at 12). The point is that
 * the request is refused in the validator, where the response is a 422 that
 * names the field, instead of in the driver, where it is a 500 that names
 * nothing.
 */
export const INT4_MAX = 2_147_483_647;

/** True when `n` can reach an `integer` column without overflowing it. */
export function fitsInt4(n: number): boolean {
  return Number.isInteger(n) && n >= -2_147_483_648 && n <= INT4_MAX;
}

/** A count stored in an `integer` column: positive, and small enough to store. */
export const int4Positive = () => z.number().int().positive().max(INT4_MAX);

/** A 1-based version number stored in an `integer` column. */
export const int4Version = () => z.number().int().min(1).max(INT4_MAX);
