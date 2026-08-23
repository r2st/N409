import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * A `%…%` pattern built by hand is a search box that reads what the user typed
 * as pattern language.
 *
 * Every list endpoint on the platform offers a substring search, and each one
 * wraps the query in `%…%` and hands it to ILIKE. The value goes to Postgres
 * through a placeholder, so this is not injection and `sqlInterpolationSweep`
 * has nothing to say about it — the query is bound correctly and *means* the
 * wrong thing. `%` matches any run and `_` matches any single character, so a
 * company genuinely called "100% Renewable" could not be found by typing its
 * name, and a bare `%` turned the narrowest possible query into no filter at
 * all: the shared inbox answered it with every thread the reader could see.
 *
 * `db/like.ts` was written to close exactly this and did, for the call sites
 * that used it. The inbox never did — it was written with its own
 * `` `%${filter.search}%` `` — and retention had a *third* thing, a private
 * copy of the character class inline in the query. Two of the three ways to
 * spell this were wrong, which is the argument for stating it once here rather
 * than trusting the next author to find the helper.
 *
 * Same shape as `finiteNumberSweep` and `todayLocalSweep`: a source scan,
 * because the behavioural version of this test can only ever be written for
 * the endpoints somebody already thought of.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The `src/` tree: this file sits at `src/services/valuation/test/unit`. */
const SRC = path.resolve(HERE, '../../../..');

/**
 * The TypeScript trees that can hold a query.
 *
 * `services/ai` is Python and has no `src` at all; `web-frontend` is the
 * browser bundle and reaches Postgres through the API like any other client.
 * Neither can contain the mistake. The roster is asserted to exist below, so a
 * service that gets renamed fails here rather than quietly leaving the scan.
 */
const ROOTS = ['services/valuation/src', 'services/web/src', 'services/report/src', 'packages'];

/** Build output is a copy of the sources already scanned, and `.d.ts` besides. */
const isBuildOutput = (file: string): boolean => file.split(path.sep).includes('dist');

/**
 * A LIKE pattern assembled in a template literal: a leading `%`, one
 * interpolation, a trailing `%`.
 *
 * Deliberately blind to what is *inside* the `${…}` — `likeContains(q)` and a
 * raw `q` are the same shape here, and both are wrong in this position. The
 * one legitimate way to write it is to call the helper, which returns the
 * whole pattern; a call site that still holds the percent signs itself has not
 * been converted, whatever it wrapped in the middle.
 */
const HAND_ROLLED = /`%\$\{[^}]*\}%`/;

/**
 * The one file allowed to write the pattern, because it is the definition.
 *
 * A path and not a basename: a new `like.ts` somewhere else is a second copy
 * of the rule, which is the thing this census exists to prevent.
 */
const DEFINES_IT = 'services/valuation/src/db/like.ts';

interface Hit {
  file: string;
  line: number;
  text: string;
}

function handRolledPatterns(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ROOTS) {
    const dir = path.join(SRC, root);
    for (const file of sourceFiles(dir)) {
      if (isBuildOutput(file)) continue;
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const m = HAND_ROLLED.exec(line);
          if (m) hits.push({ file: rel, line: i + 1, text: m[0] });
        });
    }
  }
  return hits;
}

describe('substring searches escape what the user typed', () => {
  const hits = handRolledPatterns();

  it('scans every tree it claims to', () => {
    // A root that has been renamed away resolves to nothing, and `sourceFiles`
    // would throw rather than pass — but only while it is the *first* thing
    // read. Asserting the roster directly says so plainly instead of as an
    // ENOENT from somewhere inside a walk.
    for (const root of ROOTS) expect(existsSync(path.join(SRC, root)), root).toBe(true);
  });

  it('can still see the pattern it is looking for', () => {
    // The vacuity guard. Every assertion below is satisfied by a scan that
    // finds nothing, and this census is one refactor away from finding
    // nothing — `likeContains` could be rewritten to build its pattern by
    // concatenation and the regex would go quiet while the class reopened.
    // So the definition itself is required to be visible: if the scan cannot
    // find the one place that is *supposed* to match, it is not scanning.
    expect(hits.map((h) => h.file)).toContain(DEFINES_IT);
  });

  it('leaves the pattern nowhere but its definition', () => {
    const strays = hits.filter((h) => h.file !== DEFINES_IT).map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(strays).toEqual([]);
  });

  it('routes every ILIKE through a helper that escapes', () => {
    // The other direction. A query can also acquire the percent signs in SQL
    // — `'%' || $1 || '%'` — which the scan above cannot see because there is
    // no template literal at all. Requiring every file that says ILIKE to
    // import the helper catches that spelling, and catches a fourth one
    // nobody has thought of yet, without needing to enumerate them.
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(path.join(SRC, root))) {
        if (isBuildOutput(file)) continue;
        const src = readFileSync(file, 'utf8');
        if (!/\bILIKE\b/.test(src)) continue;
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (rel === DEFINES_IT) continue;
        if (!/from '.*db\/like\.js'/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
