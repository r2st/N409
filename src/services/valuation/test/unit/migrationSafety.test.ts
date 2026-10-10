// Additive-only migrations (round 158).
//
// `migrate.ts` is forward-only and checksummed: an applied migration can never
// be edited, and there is no down-step. The set is, today, perfectly additive —
// 132 files, zero DROP TABLE, zero DROP COLUMN, zero type changes, and all 31
// NOT NULL columns carry a DEFAULT. Nothing kept it that way, and the two
// things that depend on it both fail silently:
//
//   * deploy.sh restarts valuation first and waits, so the new schema is read
//     by the previous release's code for the length of that wait;
//   * deploy.sh --rollback restores the previous commit and deliberately does
//     not touch the schema, which is only safe while the schema is a superset.
//
// So this is a census with a claim attached, and the claim is the interesting
// part: it is not "no DROP". Dropping a CHECK constraint to widen it is the
// commonest shape in the directory and is additive where it counts.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIGRATION_SAFETY_RULES, destructiveFindings, strippedSql } from '../../src/db/migrationSafety.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

describe('strippedSql', () => {
  it('removes line and block comments', () => {
    expect(strippedSql('SELECT 1; -- DROP TABLE users')).not.toContain('DROP TABLE');
    expect(strippedSql('SELECT 1; /* DROP TABLE users */')).not.toContain('DROP TABLE');
  });

  it('does not read a -- inside a block comment as a line comment', () => {
    const stripped = strippedSql('/* a -- b */ SELECT 2;');
    expect(stripped).toContain('SELECT 2');
  });

  it('removes string literals, including doubled quotes', () => {
    // A seeded help article or prompt may legitimately contain the phrase.
    expect(strippedSql("INSERT INTO help VALUES ('how to drop column x');")).not.toContain('drop column');
    expect(strippedSql("INSERT INTO help VALUES ('it''s a drop column guide');")).not.toContain(
      'drop column',
    );
  });

  it('removes dollar-quoted bodies', () => {
    expect(strippedSql('CREATE FUNCTION f() AS $$ DROP TABLE users; $$ LANGUAGE sql;')).not.toContain(
      'DROP TABLE',
    );
    expect(strippedSql('SELECT $tag$ DROP TABLE users $tag$;')).not.toContain('DROP TABLE');
  });

  it('leaves real DDL alone', () => {
    expect(strippedSql('ALTER TABLE t DROP COLUMN c;')).toContain('DROP COLUMN');
  });
});

describe('destructiveFindings', () => {
  it('accepts an ordinary additive migration', () => {
    expect(destructiveFindings("ALTER TABLE users ADD COLUMN nickname text NOT NULL DEFAULT '';")).toEqual(
      [],
    );
  });

  it('accepts dropping a CHECK constraint to widen it', () => {
    // The commonest shape in the directory, 25 of them. Old code never violated
    // the constraint, so loosening it cannot break a reader.
    const sql = `
      ALTER TABLE valuation_params DROP CONSTRAINT IF EXISTS valuation_params_method_ck;
      ALTER TABLE valuation_params ADD CONSTRAINT valuation_params_method_ck
        CHECK (method IN ('opm', 'pwerm', 'cvm'));
    `;
    expect(destructiveFindings(sql)).toEqual([]);
  });

  it('accepts relaxing a column to nullable', () => {
    // `DROP NOT NULL` is an ALTER COLUMN sub-action and a relaxation; it must
    // not be caught by the drop-column rule.
    expect(destructiveFindings('ALTER TABLE api_tokens ALTER COLUMN partner_id DROP NOT NULL;')).toEqual([]);
  });

  it('accepts dropping an index, trigger, policy or function', () => {
    // All re-creatable from this repository, and none of them hold rows.
    for (const stmt of [
      'DROP INDEX IF EXISTS idx_users_email;',
      'DROP TRIGGER IF EXISTS t ON users;',
      'DROP POLICY IF EXISTS p ON users;',
      'DROP FUNCTION IF EXISTS f();',
    ]) {
      expect([stmt, destructiveFindings(stmt)]).toEqual([stmt, []]);
    }
  });

  it('refuses dropping a table', () => {
    const found = destructiveFindings('DROP TABLE legacy_valuations;');
    expect(found.map((f) => f.rule)).toEqual(['drop-table']);
  });

  it('refuses dropping a column', () => {
    const found = destructiveFindings('ALTER TABLE users DROP COLUMN legacy_flag;');
    expect(found.map((f) => f.rule)).toEqual(['drop-column']);
  });

  it('refuses changing a column type, in both spellings', () => {
    for (const stmt of [
      'ALTER TABLE users ALTER COLUMN amount TYPE bigint;',
      'ALTER TABLE users ALTER COLUMN amount SET DATA TYPE bigint;',
    ]) {
      expect([stmt, destructiveFindings(stmt).map((f) => f.rule)]).toEqual([stmt, ['change-column-type']]);
    }
  });

  it('refuses a rename', () => {
    for (const stmt of ['ALTER TABLE users RENAME COLUMN a TO b;', 'ALTER TABLE users RENAME TO people;']) {
      expect([stmt, destructiveFindings(stmt).map((f) => f.rule)]).toEqual([stmt, ['rename']]);
    }
  });

  it('refuses a NOT NULL column with no DEFAULT', () => {
    const found = destructiveFindings('ALTER TABLE users ADD COLUMN tier text NOT NULL;');
    expect(found.map((f) => f.rule)).toEqual(['not-null-without-default']);
  });

  it('accepts a NOT NULL column that has a DEFAULT, in either order', () => {
    for (const stmt of [
      "ALTER TABLE users ADD COLUMN tier text NOT NULL DEFAULT 'free';",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'free';",
      'ALTER TABLE p ADD COLUMN refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0);',
    ]) {
      expect([stmt, destructiveFindings(stmt)]).toEqual([stmt, []]);
    }
  });

  it('does not let one column’s DEFAULT excuse another column’s missing one', () => {
    // The lookahead must stop at the statement, not run to the end of the file.
    const sql =
      'ALTER TABLE users ADD COLUMN tier text NOT NULL;\n' +
      "ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free';";
    expect(destructiveFindings(sql).map((f) => f.rule)).toEqual(['not-null-without-default']);
  });

  it("does not let a comma-separated column's DEFAULT excuse a prior column's missing one", () => {
    const sql = "ALTER TABLE users ADD COLUMN tier text NOT NULL, ADD COLUMN plan text NOT NULL DEFAULT 'free';";
    expect(destructiveFindings(sql).map((f) => f.rule)).toEqual(['not-null-without-default']);
  });

  it('does not read its own prose as DDL', () => {
    // Two migrations in the directory discuss renaming in comments. A scanner
    // that reports those would be fixed by deleting the explanation.
    const sql = `
      -- The slug must not change because an account was renamed.
      /* We deliberately do not DROP COLUMN here; see 0122. */
      ALTER TABLE blog_posts ADD COLUMN slug text;
    `;
    expect(destructiveFindings(sql)).toEqual([]);
  });

  it('reports every rule a migration breaks, not just the first', () => {
    const sql = 'ALTER TABLE users DROP COLUMN a; DROP TABLE old_users;';
    expect(
      destructiveFindings(sql)
        .map((f) => f.rule)
        .sort(),
    ).toEqual(['drop-column', 'drop-table']);
  });

  it('finds a match in the second file scanned as well as the first', () => {
    // Module-level /g regexes keep `lastIndex` between calls. Without a reset
    // the scan gets progressively blinder the more migrations there are —
    // which is the worst possible direction for this bug to fail in.
    const sql = 'DROP TABLE a;';
    expect(destructiveFindings(sql)).toHaveLength(1);
    expect(destructiveFindings(sql)).toHaveLength(1);
    expect(destructiveFindings(sql)).toHaveLength(1);
  });

  it('quotes what it found, so the failure names the statement', () => {
    const [finding] = destructiveFindings('ALTER TABLE users DROP COLUMN legacy_flag;');
    expect(finding!.excerpt).toContain('legacy_flag');
  });
});

// ── The census ───────────────────────────────────────────────────────────────
describe('the migration set', () => {
  it('has migrations to check', () => {
    expect(migrationFiles().length).toBeGreaterThan(100);
  });

  it('is additive, every file of it', () => {
    const offenders: string[] = [];
    for (const { name, sql } of migrationFiles()) {
      for (const finding of destructiveFindings(sql)) {
        offenders.push(`${name} [${finding.rule}] ${finding.message}\n    ${finding.excerpt}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('states the rules it is enforcing', () => {
    // A census whose rule list quietly shrank would keep passing. Pinning the
    // set means removing a rule is a decision somebody has to write down.
    expect([...MIGRATION_SAFETY_RULES].sort()).toEqual([
      'change-column-type',
      'drop-column',
      'drop-table',
      'not-null-without-default',
      'rename',
    ]);
  });

  it('still contains the widen-a-constraint pattern the rules deliberately allow', () => {
    // Guards against the opposite failure: a census that passes because the
    // thing it was scoped around is no longer there. If DROP CONSTRAINT ever
    // vanishes from the directory, the "not all DROPs" carve-out is untested
    // and this says so rather than going quietly green.
    const withDrops = migrationFiles().filter((f) => /DROP\s+CONSTRAINT/i.test(strippedSql(f.sql)));
    expect(withDrops.length).toBeGreaterThan(10);
  });
});
