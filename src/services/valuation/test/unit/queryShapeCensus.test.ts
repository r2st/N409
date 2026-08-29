import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseUserNameFilter } from '../../src/domain/scim.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * A query string is not a `Record<string, string>`.
 *
 * Fastify's parser collects a repeated key into an array, so `?fmvs=1&fmvs=2`
 * reaches the handler as `['1', '2']` — and nothing stops a caller sending
 * that. It is not even hostile by nature: a link builder that appends a
 * parameter already present, a form with two inputs of the same name, and a
 * proxy that re-adds a filter all produce it.
 *
 * Almost every route parses its query with zod, where an array against
 * `z.string()` is a 400 that names the parameter. Two read it through a cast
 * instead, and a cast is a compile-time assertion with no runtime force: the
 * declared `string` was simply wrong, and the first line to treat the value as
 * one decided what happened. On `GET /valuations/:id/grants/:grantId` that line
 * was `q.split(',')`, which an array does not have, so the caller was told the
 * server broke rather than that the query did.
 *
 * `parseIfMatch` shows the shape of the answer for headers — it takes
 * `string | string[] | undefined` and says in a comment what it does with the
 * second. This is the same rule for the query, enforced rather than remembered:
 * a cast may not *claim* a scalar. `unknown` is fine, because a field typed
 * `unknown` cannot be used without a runtime check.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = path.resolve(HERE, '../../src/routes');

/** `req.query as { … }` / `request.query as { … }`, with its declared shape. */
const CAST = /\b(?:req|request)\.query as \{([^}]*)\}/g;

function castsInRoutes(): { file: string; line: number; shape: string; text: string }[] {
  const found: { file: string; line: number; shape: string; text: string }[] = [];
  for (const file of sourceFiles(ROUTES)) {
    const rel = path.relative(ROUTES, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      for (const m of lines[i].matchAll(CAST)) {
        found.push({ file: rel, line: i + 1, shape: m[1]!, text: trimmed });
      }
    }
  }
  return found;
}

describe('a query parameter is never cast to a scalar it may not be', () => {
  it('no route claims a query field is a string, number or boolean', () => {
    const lying = castsInRoutes()
      .filter(({ shape }) => /:\s*(?:string|number|boolean)\b/.test(shape))
      .map(({ file, line, text }) => `routes/${file}:${line}  ${text}`);
    expect(
      lying,
      'a repeated parameter arrives as an array; parse the query with zod, or type the field `unknown`:\n' +
        lying.join('\n'),
    ).toEqual([]);
  });

  it('is scanning the routes, not an empty directory', () => {
    // The guard above is one bad path away from passing over nothing.
    const files = sourceFiles(ROUTES).map((f) => path.relative(ROUTES, f));
    expect(files).toContain('grants.ts');
    expect(files).toContain('scim.ts');
    expect(files.length).toBeGreaterThan(50);
  });

  it('still recognises the shape it is looking for', () => {
    // The one remaining cast, which is allowed *because* it says `unknown`.
    // If this stops matching, the regex has drifted off the idiom and the
    // guard above is green for the wrong reason.
    const shapes = castsInRoutes().map(({ shape }) => shape);
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes.some((s) => /unknown/.test(s))).toBe(true);
  });
});

describe('the SCIM userName filter', () => {
  it('reads the address out of the filter an IdP sends', () => {
    expect(parseUserNameFilter('userName eq "Ada@Example.com"')).toBe('ada@example.com');
  });

  it('treats a repeated ?filter= as no filter rather than a coerced one', () => {
    // `['userName eq "a@b.c"', 'x']` stringifies to `userName eq "a@b.c",x`,
    // which the regex happily matches — so the array did not crash, it quietly
    // answered a question nobody asked.
    expect(parseUserNameFilter(['userName eq "a@b.c"', 'x'])).toBeNull();
  });

  it.each([[undefined], [null], [{}], [42], ['']])(
    'treats %p as no filter, which is what listing everyone means',
    (value) => {
      expect(parseUserNameFilter(value)).toBeNull();
    },
  );
});
