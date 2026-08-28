// The two session bounds a migration runs under, and the message it fails with.
//
// Both halves of this exist because the runner borrows a client from the
// *application* pool, and a pool tuned for request handlers is tuned wrongly
// for DDL in both directions at once: `statement_timeout` is 15s, which is far
// too short for an index build, and `lock_timeout` is Postgres's default of 0,
// which is unbounded and therefore the dangerous one.
//
// The runner-side behaviour is asserted against a real database in
// integration/migrationRunner.test.ts — including that `SET LOCAL` does not
// leak the raised ceiling back onto the pooled connection. What is here is the
// part that needs no database: how a value is resolved, and what an operator
// meeting the failure at 3am is told.
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS,
  DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  explainMigrationFailure,
  resolveMigrationTimeouts,
} from '../../src/db/migrate.js';

const DEFAULTS = {
  ddlLockTimeoutMs: DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS,
  statementTimeoutMs: DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
};

describe('resolveMigrationTimeouts', () => {
  it('falls back to the defaults when nothing is set', () => {
    expect(resolveMigrationTimeouts({})).toEqual(DEFAULTS);
  });

  it('reads both variables', () => {
    expect(
      resolveMigrationTimeouts({
        MIGRATION_DDL_LOCK_TIMEOUT_MS: '1500',
        MIGRATION_STATEMENT_TIMEOUT_MS: '60000',
      }),
    ).toEqual({ ddlLockTimeoutMs: 1500, statementTimeoutMs: 60_000 });
  });

  it('accepts zero, which is what Postgres reads as "no bound"', () => {
    // Worth allowing explicitly rather than by accident: disabling the
    // statement ceiling by hand is a legitimate thing to do for one deploy of
    // one very large migration, under supervision.
    expect(resolveMigrationTimeouts({ MIGRATION_STATEMENT_TIMEOUT_MS: '0' }).statementTimeoutMs).toBe(0);
  });

  // These values are interpolated into a `SET LOCAL`, which takes no bind
  // parameter — so anything that is not an integer has to be refused here
  // rather than passed through to the database.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not a number', 'soon'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['infinite', 'Infinity'],
    ['a SET fragment', "3000; SET lock_timeout = '1h'"],
  ])('ignores a %s value and keeps the default', (_label, raw) => {
    expect(resolveMigrationTimeouts({ MIGRATION_DDL_LOCK_TIMEOUT_MS: raw })).toEqual(DEFAULTS);
  });

  it('defaults to a lock wait shorter than the statement ceiling', () => {
    // The direction is the whole design: waiting for a lock blocks unrelated
    // traffic to the same table, while running a statement does not. If these
    // ever cross, a migration would spend minutes holding the queue shut.
    expect(DEFAULT_MIGRATION_DDL_LOCK_TIMEOUT_MS).toBeLessThan(DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS);
  });

  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('reads process.env when no environment is passed', () => {
    process.env.MIGRATION_DDL_LOCK_TIMEOUT_MS = '2222';
    expect(resolveMigrationTimeouts().ddlLockTimeoutMs).toBe(2222);
  });
});

describe('explainMigrationFailure', () => {
  const timeouts = { ddlLockTimeoutMs: 3000, statementTimeoutMs: 300_000 };
  const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('names the migration and repeats what Postgres said', () => {
    const text = explainMigrationFailure('0007_x.sql', pgErr('42601', 'syntax error'), timeouts);
    expect(text).toContain('0007_x.sql');
    expect(text).toContain('syntax error');
  });

  it('says a lock timeout is retryable and nothing was applied', () => {
    const text = explainMigrationFailure(
      '0007_x.sql',
      pgErr('55P03', 'canceling statement due to lock timeout'),
      timeouts,
    );
    expect(text).toContain('3000ms');
    expect(text).toContain('was not applied');
    expect(text).toMatch(/retries/);
    // The advice has to point at the holder, because raising the bound makes
    // the queue behind the migration longer rather than shorter.
    expect(text).toContain('pg_stat_activity');
  });

  it('says a statement timeout is NOT retryable', () => {
    const text = explainMigrationFailure(
      '0007_x.sql',
      pgErr('57014', 'canceling statement due to statement timeout'),
      timeouts,
    );
    expect(text).toContain('300000ms');
    expect(text).toContain('will not pass on a retry');
  });

  // The two cancellations read almost identically coming out of Postgres, and
  // the operational conclusions are opposites. That distinction is the reason
  // this function exists, so it is asserted directly.
  it('draws opposite conclusions from the two cancellation codes', () => {
    const lock = explainMigrationFailure('0007_x.sql', pgErr('55P03', 'canceling'), timeouts);
    const stmt = explainMigrationFailure('0007_x.sql', pgErr('57014', 'canceling'), timeouts);
    expect(lock).not.toEqual(stmt);
    expect(lock).toContain('will succeed once the holder is gone');
    expect(stmt).toContain('will not pass on a retry');
  });

  it('handles an error that is not an Error and carries no code', () => {
    expect(explainMigrationFailure('0007_x.sql', 'a bare string', timeouts)).toContain('a bare string');
    expect(explainMigrationFailure('0007_x.sql', null, timeouts)).toContain('0007_x.sql');
  });
});
