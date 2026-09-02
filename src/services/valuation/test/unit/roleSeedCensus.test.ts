import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLE_KEYS } from '../../src/domain/roles.js';

/**
 * The role vocabulary is a TypeScript constant; the `roles` table it joins
 * against is a SQL seed. Nothing checked they agreed.
 *
 * `assignRoles` is `INSERT INTO user_roles … SELECT $1, id FROM roles WHERE key
 * = ANY($2)`, so it inserts one row per key it *finds*. A key this build
 * declares and the database has never been seeded with contributed no row, and
 * — before round 390 — raised nothing: the statement succeeded, the
 * transaction committed, and the route answered 2xx holding a grant it had
 * silently dropped. What the caller then reported was the set it had *asked*
 * for, because `createUser` and `createProvisionedUser` both return
 * `{ ...row, roles: args.roles }`. `adminPatchUser` is worse still: it replaces
 * the set with `DELETE FROM user_roles` followed by this insert, so an operator
 * moving somebody onto an unseeded key leaves that account with no roles at
 * all, over a 204.
 *
 * `assignRoles` refuses an unmatched key now, which turns the silence into a
 * failed request. This is what keeps it from getting that far. Both sides are
 * derived — the constant, and every `roles` seed across the migration history —
 * so adding a key without its migration fails on a laptop with no database, and
 * names the key it wants. Same shape and same reason as
 * `promptRegistrySeeds.test.ts`, which pins the other two-lists-no-compiler
 * pair in this service.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Every role key seeded across the migration history, and the file that did it.
 *
 * Scoped to statements that insert into `roles` — matching bare quoted strings
 * anywhere in a migration would pick up `user_roles` grants, enum labels and
 * comments. The seed spans two files by design (0002 for the observed set, 0081
 * for `auditor`), which is exactly why the population has to be derived rather
 * than pointed at one of them.
 */
function seededRoles(): Map<string, string> {
  const seeds = new Map<string, string>();
  for (const file of migrationFiles()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    // `INSERT INTO roles (key) VALUES ('a'), ('b'), …;` — take the statement,
    // not the file, so a later unrelated INSERT cannot leak keys into it.
    for (const [statement] of sql.matchAll(/INSERT\s+INTO\s+roles\s*\([^)]*\)[\s\S]*?;/gi)) {
      for (const [, key] of statement.matchAll(/'([a-z_]+)'/g)) {
        if (!seeds.has(key)) seeds.set(key, file);
      }
    }
  }
  return seeds;
}

describe('role seed census', () => {
  it('seeds every key ROLE_KEYS declares', () => {
    const seeded = seededRoles();
    const missing = ROLE_KEYS.filter((key) => !seeded.has(key));
    expect(
      missing,
      `these role keys have no INSERT INTO roles anywhere in migrations/, so ` +
        `assignRoles would refuse every grant naming one: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('seeds no key the vocabulary does not know', () => {
    // The other direction. A seeded row for a key no `ROLE_KEYS` entry names is
    // a row `permissions.ts` grants nothing to and `RoleSet` refuses in a body
    // — reachable only by editing `user_roles` by hand, and then invisible to
    // every screen that renders a role by its label.
    const vocabulary = new Set<string>(ROLE_KEYS);
    for (const [key, file] of seededRoles()) {
      expect(vocabulary.has(key), `${file} seeds role '${key}', which is not in ROLE_KEYS`).toBe(true);
    }
  });

  it('never deletes a seeded role', () => {
    // `user_roles.role_id` is `REFERENCES roles(id)` with no ON DELETE, so a
    // migration removing a role row would fail against any database where
    // somebody holds it — in deployment, at migrate time, half way through a
    // release. Retiring a key means leaving its row and taking it out of
    // ROLE_KEYS, which the assertion above already allows for.
    for (const file of migrationFiles()) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      expect(/DELETE\s+FROM\s+roles\b/i.test(sql), `${file} deletes from roles`).toBe(false);
    }
  });

  it('derives its population from the migrations rather than a literal', () => {
    // The vacuity guard. Both assertions above pass trivially if the matcher
    // stops matching — a seed written `INSERT INTO roles(key)` without the
    // space, or a file renamed out of `*.sql`. A green from a census that found
    // nothing is the one failure a census cannot survive.
    const seeded = seededRoles();
    expect(seeded.size).toBeGreaterThanOrEqual(ROLE_KEYS.length);
    expect(new Set(seeded.values()).size).toBeGreaterThan(1);
  });
});
