import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every route that sets a password applies the password policy.
 *
 * `accountSettings.test.ts` has claimed since it was written that
 * `password_min_length` "tightens the floor for every password entry point",
 * and drove two of them. The third, `POST /api/v1/users`, validated
 * `min(10)` in its zod schema and stopped: the *floor*, not the effective
 * minimum, so a deployment configured to 16 went on accepting ten-character
 * passwords through the admin console — the entry point whose accounts tend to
 * be the privileged ones. The complexity half was not there at all, so
 * `1234567890` was refused at registration, at reset, at invite acceptance and
 * at change-password, and created here.
 *
 * A behavioural test can only drive the entry points somebody remembered to
 * list, and the one that was missing is by definition the one nobody
 * remembered. So the rule is stated over the source instead, against the thing
 * an entry point cannot avoid doing: a password that is going to be stored has
 * to be hashed first. Every file that calls `hashPassword` therefore has to
 * reach the policy, and a sixth route added next year has to answer this before
 * it can store anything.
 *
 * This does not check that the *same* password reaches both, which no source
 * scan can. It checks the thing that was actually wrong: a file that hashes and
 * has never heard of the policy at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../src');
const SERVICE = path.resolve(here, '../..');

/** The one file allowed to hash without consulting the policy: the hasher. */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/auth/password.ts',
    why: 'It *is* `hashPassword` — the scrypt wrapper the entry points call. A policy check here would run on every verify as well as every set, and would put the rule below the layer that knows the effective minimum.',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Files that turn a plaintext password into something storable. */
function hashingFiles(): Array<{ file: string; src: string }> {
  return walk(SRC)
    .map((file) => ({ file: path.relative(SERVICE, file), src: readFileSync(file, 'utf8') }))
    .filter(({ src }) => /\bhashPassword\s*\(/.test(src));
}

describe('every route that stores a password checks it first', () => {
  const files = hashingFiles();
  const exempt = new Set(EXEMPT.map((e) => e.file));

  it('finds the idiom at all', () => {
    // The vacuity guard. If `hashPassword` is renamed or moved behind a helper,
    // this census asks nothing and passes — which is worse than not existing,
    // because the green tick is what stops anyone looking.
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.map((f) => f.file)).toContain('src/auth/password.ts');
  });

  it('exempts nothing that no longer exists', () => {
    const seen = new Set(files.map((f) => f.file));
    expect(EXEMPT.filter((e) => !seen.has(e.file)).map((e) => e.file)).toEqual([]);
  });

  it('reaches the policy from every file that hashes', () => {
    const unchecked = files
      .filter((f) => !exempt.has(f.file))
      .filter((f) => !/passwordPolicyError|assertPasswordStrong/.test(f.src))
      .map((f) => f.file);
    expect(unchecked).toEqual([]);
  });

  it('reads the effective minimum rather than hard-coding the floor', () => {
    // `PASSWORD_MIN_LENGTH` is what a deployment starts at, not what it is:
    // an administrator may raise `password_min_length`, and a check that never
    // asks the settings store enforces the number in the source instead.
    const unconfigured = files
      .filter((f) => !exempt.has(f.file))
      .filter((f) => !/get\(['"]password_min_length['"]\)/.test(f.src))
      .map((f) => f.file);
    expect(unconfigured).toEqual([]);
  });
});
