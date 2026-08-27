import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * The source half of round 174, in the shape `finiteNumberSweep` established:
 * the next schema written the wrong way fails here rather than in production.
 *
 * Two classes, both of them "the schema accepted it and something downstream
 * could not":
 *
 *  - `z.coerce.date()` accepts every instant a `Date` can hold, which is a
 *    range fifty times wider than Postgres `timestamptz`. See
 *    domain/calendarRange.ts.
 *  - a `.partial()` patch body that strips unknown keys instead of refusing
 *    them applies the half of a patch it recognised and returns 200, so a
 *    misspelled field reads as saved.
 *
 * Both are scanned rather than enumerated, because a list of the sites that
 * were wrong in August 2026 stops being true the first time someone adds a
 * route. What is enumerated is the exceptions, and each one carries its reason.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

/** Source lines, with the file and 1-based line number they came from. */
function* everyLine(): Generator<{ file: string; line: number; text: string }> {
  // Prose about a spelling is not the spelling. Both files below explain at
  // length what `z.coerce.date()` does wrong, and a scan that cannot tell a
  // comment from code would fail on its own documentation.
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      yield { file: rel, line: i + 1, text: lines[i] };
    }
  }
}

describe('coerced dates are bounded to what Postgres can hold', () => {
  /**
   * `calendarRange.ts` is where the bounded spelling is defined, so it is the
   * one file allowed to write the bare one.
   */
  const DEFINITION = 'domain/calendarRange.ts';

  it('has no bare z.coerce.date() outside its own definition', () => {
    const bare: string[] = [];
    for (const { file, line, text } of everyLine()) {
      if (file === DEFINITION) continue;
      if (/z\.coerce\.date\(\)/.test(text)) bare.push(`${file}:${line}  ${text.trim()}`);
    }
    expect(bare, `use calendarDate() from domain/calendarRange.js instead:\n${bare.join('\n')}`).toEqual([]);
  });

  it('finds the definition it is excusing, so the exception is not stale', () => {
    const src = readFileSync(path.join(SRC, DEFINITION), 'utf8');
    expect(src).toContain('z.coerce');
    expect(src).toContain('export const calendarDate');
  });

  it('scans a file set that actually contains the routes', () => {
    // The guard above is one `readdirSync` away from passing over an empty
    // list. Prove the walk reaches the two directories the schemas live in.
    const files = sourceFiles(SRC).map((f) => path.relative(SRC, f));
    expect(files).toContain('routes/blog.ts');
    expect(files).toContain('domain/dateWindow.ts');
    expect(files.length).toBeGreaterThan(200);
  });
});

describe('patch bodies refuse unknown keys', () => {
  /**
   * A `.partial()` body is a patch: every field optional, and whatever is
   * present is what the caller means to change. Stripping an unknown key turns
   * `{title: 'A', publised: true}` into a 200 that applied one of the two
   * fields the caller sent and said nothing about the other.
   *
   * `.strict()` may appear a few lines below `.partial()` — the house spelling
   * puts the chain across lines — so the window is the chain, not the line.
   */
  it('every .partial() schema is also .strict()', () => {
    const stripping: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('*') || lines[i].trim().startsWith('//')) continue;
        if (!lines[i].includes('.partial()')) continue;
        const chain = [lines[i], ...lines.slice(i + 1, i + 4)].join(' ');
        if (!chain.includes('.strict()')) stripping.push(`${rel}:${i + 1}  ${lines[i].trim()}`);
      }
    }
    expect(
      stripping,
      `a patch body that strips unknown keys applies half a patch under a 200:\n${stripping.join('\n')}`,
    ).toEqual([]);
  });

  it('is looking at a population, not at nothing', () => {
    let seen = 0;
    for (const { text } of everyLine()) if (text.includes('.partial()')) seen++;
    // Twenty-one at the time of writing. The floor is here so that a refactor
    // which renames the idiom cannot turn this guard green by emptying it.
    expect(seen).toBeGreaterThanOrEqual(15);
  });
});
