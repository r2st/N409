/**
 * One date renderer, so a calendar day cannot be re-broken one component at a
 * time.
 *
 * `formatDate` knows that a bare `YYYY-MM-DD` is a calendar day and must not be
 * routed through UTC — see `formatDateCalendarDay.test.ts` for what that costs
 * when it is. That knowledge is worth nothing to a component that reaches for
 * `new Date(value).toLocaleDateString()` instead, and five of them did. All
 * five happened to be holding a `timestamptz`, so all five were correct; what
 * makes this worth a rule is that nothing about the call site says which kind
 * of string it is holding, and the failure is a date that looks like a date.
 *
 * The rule is the pair, not the constructor: `new Date(x)` for arithmetic — a
 * duration, a comparison against `Date.now()` — is ordinary and stays.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: path.relative(SRC, file).split(path.sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

/**
 * `new Date(…)` with a `.toLocale…` on the same expression. Whitespace is
 * collapsed first so a call broken across lines by the formatter still matches.
 */
const RENDERS_A_DATE_ITSELF = /new Date\([^)]*\)\s*\.toLocale(Date|)String\(/;

describe('every rendered date goes through format.ts', () => {
  it('is looking at a source tree', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('has no component formatting a date string itself', () => {
    const offenders = FILES.filter(
      ({ file, text }) => file !== 'lib/format.ts' && RENDERS_A_DATE_ITSELF.test(text.replace(/\s+/g, ' ')),
    ).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('would catch the pattern it is looking for', () => {
    // The vacuity guard. A census over a tree that no longer contains the
    // idiom passes whether or not the regex works, so the regex is asked
    // directly about the four shapes the five sites were written in.
    for (const sample of [
      'new Date(p.created_at).toLocaleDateString()',
      "new Date(x).toLocaleDateString(undefined, { year: 'numeric' })",
      'new Date(iso).toLocaleString()',
      '{new Date(bundle.access_expires_at)\n  .toLocaleDateString()}',
    ]) {
      expect(RENDERS_A_DATE_ITSELF.test(sample.replace(/\s+/g, ' '))).toBe(true);
    }
    // And not about the arithmetic it must leave alone.
    for (const sample of ['new Date(iso).getTime()', 'Date.now() - new Date(iso).getTime()']) {
      expect(RENDERS_A_DATE_ITSELF.test(sample.replace(/\s+/g, ' '))).toBe(false);
    }
  });
});
