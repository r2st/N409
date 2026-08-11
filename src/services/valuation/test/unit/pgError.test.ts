import { describe, expect, it } from 'vitest';
import {
  asPgError,
  isForeignKeyViolation,
  isUniqueViolation,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../../src/db/pgError.js';

/**
 * The narrowing that replaced `(err as { code?: string }).code === '23505'`.
 *
 * The assertion form was wrong in two directions and the tests below pin both:
 * it claimed a shape for values that do not have it (a `TypeError`, a string,
 * null), and it could not tell one unique index from another — which on a table
 * with two of them is the difference between a 409 the caller can act on and
 * one that names the wrong field.
 */

/** A rejection shaped like the `pg` driver's. */
function pgReject(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code, ...extra });
}

describe('asPgError', () => {
  it('reads code, constraint and table off a driver error', () => {
    const err = pgReject(PG_UNIQUE_VIOLATION, { constraint: 'partners_key_key', table: 'partners' });
    expect(asPgError(err)).toEqual({
      code: PG_UNIQUE_VIOLATION,
      constraint: 'partners_key_key',
      table: 'partners',
    });
  });

  it('omits the fields the server did not name rather than inventing them', () => {
    expect(asPgError(pgReject('40001'))).toEqual({ code: '40001' });
  });

  it('returns null for everything that is not a driver error', () => {
    // Each of these reached the old assertion and compared `undefined` to
    // '23505' — harmless by luck, not by construction.
    expect(asPgError(new TypeError('fetch failed'))).toBeNull();
    expect(asPgError(null)).toBeNull();
    expect(asPgError(undefined)).toBeNull();
    expect(asPgError('23505')).toBeNull();
    expect(asPgError(23505)).toBeNull();
    expect(asPgError({})).toBeNull();
  });

  it('rejects a non-string code rather than trusting the field name', () => {
    expect(asPgError({ code: 23505 })).toBeNull();
  });

  it('ignores a constraint or table that is not a string', () => {
    expect(asPgError({ code: '23505', constraint: 7, table: null })).toEqual({ code: '23505' });
  });
});

describe('isUniqueViolation', () => {
  it('matches the SQLSTATE when no constraint is named', () => {
    expect(isUniqueViolation(pgReject(PG_UNIQUE_VIOLATION))).toBe(true);
    expect(isUniqueViolation(pgReject(PG_FOREIGN_KEY_VIOLATION))).toBe(false);
  });

  it('distinguishes one unique index from another on the same table', () => {
    // saved_views carries both of these (migration 0088). Reporting the second
    // as the first told a user to rename a view that was not the problem.
    const nameTaken = pgReject(PG_UNIQUE_VIOLATION, { constraint: 'saved_views_owner_name_idx' });
    const defaultRace = pgReject(PG_UNIQUE_VIOLATION, { constraint: 'saved_views_one_default_idx' });

    expect(isUniqueViolation(nameTaken, 'saved_views_owner_name_idx')).toBe(true);
    expect(isUniqueViolation(nameTaken, 'saved_views_one_default_idx')).toBe(false);
    expect(isUniqueViolation(defaultRace, 'saved_views_one_default_idx')).toBe(true);
    expect(isUniqueViolation(defaultRace, 'saved_views_owner_name_idx')).toBe(false);
  });

  it('does not match a named constraint when the server named none', () => {
    // Better a 500 that is visible in the logs than a 409 that names a field
    // the caller cannot fix.
    expect(isUniqueViolation(pgReject(PG_UNIQUE_VIOLATION), 'partners_key_key')).toBe(false);
  });

  it('is false for a rejection that is not a driver error at all', () => {
    expect(isUniqueViolation(new TypeError('connection reset'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('isForeignKeyViolation', () => {
  it('matches 23503, with or without a constraint name', () => {
    const err = pgReject(PG_FOREIGN_KEY_VIOLATION, { constraint: 'auto_emails_template_key_fkey' });
    expect(isForeignKeyViolation(err)).toBe(true);
    expect(isForeignKeyViolation(err, 'auto_emails_template_key_fkey')).toBe(true);
    expect(isForeignKeyViolation(err, 'something_else_fkey')).toBe(false);
    expect(isForeignKeyViolation(pgReject(PG_UNIQUE_VIOLATION))).toBe(false);
  });
});
