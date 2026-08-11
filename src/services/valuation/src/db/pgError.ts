/**
 * Narrowing for `pg` driver errors.
 *
 * A rejected `pool.query` is typed `unknown`, and every site that wanted to
 * distinguish a unique violation from a real failure reached for the same
 * assertion to get at it:
 *
 *     if ((err as { code?: string }).code === '23505') …
 *
 * That is a lie the compiler cannot check — `err` may be a `TypeError`, an
 * `AbortError`, or a string — and it had been written eight times, in three
 * slightly different shapes. Two of them tested the constraint name and six
 * did not, which is the difference between "the name is taken" and "some
 * unique index on this table fired".
 *
 * The distinction is not academic. `saved_views` carries two unique indexes:
 * one on (owner, lower(name)) and one enforcing a single default per owner. A
 * bare SQLSTATE check reports both as "you already have a view with that
 * name", so a user who loses the race to set a default is told to rename a
 * view that is not the problem.
 */

/** Unique violation — a row collided with a unique index or constraint. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Foreign-key violation — a referenced row is missing or still referenced. */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/** The fields of a `pg` error this codebase reads. */
export interface PgError {
  /** SQLSTATE, e.g. `23505`. */
  code: string;
  /** The index or constraint that rejected the row, when the server named one. */
  constraint?: string;
  /** The table it belongs to, when the server named one. */
  table?: string;
}

/**
 * `err` as a Postgres error, or null if it is anything else.
 *
 * Written with `in` rather than an assertion so the narrowing is the
 * compiler's rather than ours: a driver error that stops carrying `code`
 * becomes a null here, not a silent `undefined === '23505'`.
 */
export function asPgError(err: unknown): PgError | null {
  if (typeof err !== 'object' || err === null) return null;
  if (!('code' in err) || typeof err.code !== 'string') return null;
  const constraint = 'constraint' in err && typeof err.constraint === 'string' ? err.constraint : undefined;
  const table = 'table' in err && typeof err.table === 'string' ? err.table : undefined;
  return { code: err.code, ...(constraint ? { constraint } : {}), ...(table ? { table } : {}) };
}

/**
 * True when `err` is a unique violation.
 *
 * Pass `constraint` whenever the table has more than one unique index and the
 * message you are about to throw names one of them. Omit it only where the
 * table has exactly one, and the two statements mean the same thing.
 *
 * The name is the index or constraint identifier as Postgres reports it —
 * `saved_views_owner_name_idx`, `partners_key_key` — which is the name in the
 * migration, so a rename that is not mirrored here turns a 409 into a 500
 * rather than into a wrong 409. That is the failure worth having: a 500 is
 * visible in the logs and a wrong 409 is not.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = asPgError(err);
  if (!pg || pg.code !== PG_UNIQUE_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

/** True when `err` is a foreign-key violation, optionally on a named constraint. */
export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const pg = asPgError(err);
  if (!pg || pg.code !== PG_FOREIGN_KEY_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}
