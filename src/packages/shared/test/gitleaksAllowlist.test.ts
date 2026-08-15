import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The secret-scanner allowlist, and the two ways it can go wrong.
 *
 * `.gitleaks.toml` is run by CI (`Dependency & secret scan`) with no
 * `continue-on-error`, so it is a blocking gate — and it was failing. Sixty-
 * eight findings, every one a test fixture. A gate that is always red is not a
 * gate: the sixty-ninth finding would have been a real key, arriving in a job
 * everybody had already learned to scroll past.
 *
 * Widening the allowlist to fix that is the obvious move and the dangerous one,
 * so both directions are pinned here:
 *
 *   * every fixture the repository actually contains stays allowed, so the
 *     scan stays green and therefore stays read;
 *   * credential shapes that would matter are still caught, so "green" keeps
 *     meaning something.
 *
 * This runs without the gitleaks binary — it checks the allowlist patterns
 * themselves, which is the part a future edit gets wrong.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const configPath = path.join(repoRoot, '.gitleaks.toml');

/**
 * The `regexes = [...]` entries, as JavaScript patterns.
 *
 * Hand-extracted because the repo has no TOML parser and this is one known
 * array in a file we control. `'''…'''` is TOML's literal string: no escape
 * processing, so the pattern is exactly the characters between the quotes.
 */
function allowlistPatterns(): RegExp[] {
  const toml = readFileSync(configPath, 'utf8');
  const block = /regexes\s*=\s*\[([\s\S]*?)\n\]/.exec(toml);
  if (!block) throw new Error('no `regexes = [...]` array in .gitleaks.toml');
  return [...block[1]!.matchAll(/'''([\s\S]*?)'''/g)].map((m) => toJs(m[1]!));
}

/**
 * Go's regexp to JavaScript's.
 *
 * gitleaks compiles with Go's RE2, where `(?i)` is an inline flag. JavaScript
 * has no such syntax and `new RegExp('(?i)x')` throws, so the flag is lifted to
 * the flags argument. Everything else in this file is plain shared syntax.
 */
function toJs(pattern: string): RegExp {
  const ci = pattern.startsWith('(?i)');
  return new RegExp(ci ? pattern.slice(4) : pattern, ci ? 'i' : '');
}

/** Whether gitleaks would drop a finding with this secret. */
function allowed(secret: string): boolean {
  return allowlistPatterns().some((re) => re.test(secret));
}

/**
 * Every distinct secret the pinned CI version (8.21.2) reported before this
 * allowlist existed. Kept as data rather than re-derived, so the test does not
 * need the binary and does not go quiet if the binary is missing.
 */
const FIXTURES = [
  'integration-test-secret-0123456789abcdef',
  'test-secret-0123456789abcdef-0123456789',
  'ABCDEF234567',
  'sk_live_abc123',
  'sk-live-abc123',
  'pplx-0123456789abcdef',
  'n409_pat_abc123',
  'sk_test_notarealkey',
  'sk_test_integration',
  'n409_live_abcdef0123456789',
  'scim_live_abc123',
  'n409_brd_anything',
  'n409_brd_guess',
  'n409_brd_guess_again',
  'sk-or-v1-abcdef',
  'prior_1202_exclusions',
  '9f2c4a7e1b6d8035fe4a1c9b7d2e6083a5c4b1f7e9d0236a8c5b4f1e7d9a0c36',
  'b41f7e9d0236a8c5b4f1e7d9a0c369f2',
  'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  '-----BEGIN PRIVATE KEY-----[\\s\\S]*?-----END PRIVATE KEY-----',
  'dev-only-secret-change-me-0123456789abcdef',
];

/**
 * Credentials that must still trip the scan.
 *
 * Shaped like the real thing and deliberately close to the fixtures — a live
 * Stripe key next to the allowed test-mode one, a 64-hex secret next to the
 * three that are pinned literally — because "does the allowlist leak into the
 * neighbouring case" is the question that matters.
 *
 * Assembled from fragments rather than written whole, which is the one place
 * this file has to be indirect. These values must *not* be allowlisted — that
 * is the entire assertion — so a literal `sk_live_…` here would be flagged by
 * the scanner this test exists to protect, and the obvious way to quieten it
 * would be to allowlist the value, which is precisely the failure being
 * guarded against. Splitting the prefix from the body keeps the file clean to
 * a text scan while `allowed()` still sees the exact real shape.
 */
const MUST_STILL_FIRE = [
  ['sk', 'live', '51HxYzQvWrTyUiOpAsDfGhJkL'].join('_'),
  ['ghp', 'ZkQwErTyUiOpAsDfGhJkLzXcVbNm99'].join('_'),
  ['xoxb', '99887766554', 'XyZwVuTsRqPoNmLk'].join('-'),
  ['AKIA', 'Z3QWERTYUIOPLKJH'].join(''),
  ['AIza', 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'].join(''),
  ['n409', 'live', '9f2c4a7e1b6d8035fe4a1c9b'].join('_'),
  // A different 64-hex secret. The three that are allowed are pinned with `^…$`
  // precisely so they cannot generalise into "any hex string". No prefix to
  // split off, and no keyword near it, so the scanner leaves it alone as-is.
  'ff41d0c8b9a7e6f5d4c3b2a1908172635445362718091a2b3c4d5e6f708192a3',
];

describe('the gitleaks allowlist', () => {
  it('parses the patterns it is supposed to be checking', () => {
    // The failure this guards is the one every source-scanning test has: an
    // extraction that quietly matches nothing makes every assertion below pass
    // by checking an empty list.
    const patterns = allowlistPatterns();
    expect(patterns.length).toBeGreaterThan(5);
    expect(patterns.some((re) => re.test('integration-test-secret-0123456789abcdef'))).toBe(true);
  });

  it('allows every fixture the repository actually contains', () => {
    const missed = FIXTURES.filter((secret) => !allowed(secret));
    expect(missed, 'fixtures that would fail the scan again').toEqual([]);
  });

  it('still catches credential shapes that would matter', () => {
    const slipped = MUST_STILL_FIRE.filter((secret) => allowed(secret));
    expect(slipped, 'real-looking credentials the allowlist would hide').toEqual([]);
  });

  it('does not allowlist test directories wholesale', () => {
    // The tempting fix, and the wrong one: a `test/` path entry would also hide
    // a genuine provider key pasted into a test while reproducing a customer
    // issue — one of the likelier ways a real credential gets committed. The
    // fixtures are allowed by value so every file stays in scope.
    const toml = readFileSync(configPath, 'utf8');
    const paths = /paths\s*=\s*\[([\s\S]*?)\n\]/.exec(toml)?.[1] ?? '';
    expect(paths).not.toMatch(/test/i);
    expect(paths).not.toMatch(/spec/i);
  });

  it('keeps the scan a blocking gate in CI', () => {
    // The npm-audit and pip-audit steps around it are deliberately
    // `continue-on-error`. This one is not, and that is the only reason fixing
    // the fixtures mattered — if it were advisory, it would just be noise.
    const ci = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const step = /- name: gitleaks[\s\S]*?(?=\n {6}- name:|\n\n {2}\w|$)/.exec(ci)?.[0] ?? '';
    expect(step, 'the gitleaks CI step').toContain('gitleaks detect');
    expect(step).not.toContain('continue-on-error');
  });
});
