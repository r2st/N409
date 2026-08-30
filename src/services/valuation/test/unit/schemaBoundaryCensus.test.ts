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

/**
 * A schema that accepts a list, or a page size, without saying how big.
 *
 * The two classes above are about a *value* the schema admits and the database
 * cannot hold. This is the third, and it is about a *count*: `z.array(X)` with
 * no `.max()` accepts as many elements as fit in the body, and a page-size
 * parameter with no ceiling accepts whatever number a caller types. Neither is
 * a data-loss bug; both are the shape where one request costs the service an
 * arbitrary amount of work — a thousand share classes handed to the engine, a
 * `?per_page=1000000` that asks Postgres for the whole table and then
 * serialises it.
 *
 * Both are currently clean — every request-side array and every page-size
 * parameter in this service already carries a ceiling — which is exactly when
 * the rule is worth writing down. The bound on these was reached one endpoint
 * at a time by whoever wrote each schema; nothing said it had to be, so the
 * fortieth is where it would have stopped being true.
 *
 * The exemption is stated as a property rather than a list: a schema whose
 * declaration is named `…Response` documents what this service *sends*, and is
 * rendered into the partner OpenAPI document rather than parsed from a
 * request. A ceiling there would be a claim about a page size the route
 * already enforces, restated in a second place to go stale.
 */
describe('a schema that accepts a list says how long it may be', () => {
  /**
   * The `const NAME =` a line belongs to, searching upwards.
   *
   * Not `export const` only: most schemas here are locals declared inside the
   * `register…Routes` function that uses them, and a walk that recognised only
   * the exported spelling attributed all of those to whatever happened to be
   * exported further up the file.
   */
  function ownerOf(lines: string[], index: number): string {
    for (let i = index; i >= 0; i--) {
      const declared = /(?:export\s+)?const (\w+)\s*=/.exec(lines[i]!);
      if (declared) return declared[1]!;
    }
    return '';
  }

  /** The one file whose schemas describe what is sent rather than what is parsed. */
  const CONTRACT = `domain${path.sep}partnerApiContract.ts`;

  /**
   * Whether a hit documents an outgoing payload rather than parsing one.
   *
   * Both halves are required. The name alone would exempt any local a route
   * happened to call `…Response`; the file alone would exempt the request
   * schemas that live in the contract beside the response ones.
   */
  const documentsOutput = (hit: { where: string; owner: string }) =>
    hit.owner.endsWith('Response') && hit.where.startsWith(CONTRACT);

  interface Hit {
    where: string;
    owner: string;
    text: string;
  }

  function scan(matches: (line: string) => boolean): Hit[] {
    const hits: Hit[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        const trimmed = text.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
        if (!matches(text)) return;
        hits.push({ where: `${rel}:${i + 1}`, owner: ownerOf(lines, i), text: trimmed });
      });
    }
    return hits;
  }

  /**
   * Whether every `z.array(...)` on a line carries its *own* `.max()`.
   *
   * The obvious spelling — "the line contains `z.array(` and `.max(`" — is
   * wrong, and wrong in the direction that reports a clean census over an
   * unbounded array. `z.array(z.number().gt(0).max(1000))` bounds each element
   * at a thousand and says nothing at all about how many elements there may
   * be, which is the distinction `domain/roles.ts` spells out in prose: the
   * element bound and the array bound are different claims and only one of
   * them is this rule. So the argument is skipped by matching parentheses and
   * the `.max()` is looked for after the closing one, where the array's own
   * modifiers are.
   */
  function arraysBounded(line: string): boolean {
    for (let at = line.indexOf('z.array('); at >= 0; at = line.indexOf('z.array(', at + 1)) {
      let depth = 0;
      let close = -1;
      for (let i = at + 'z.array'.length; i < line.length; i++) {
        if (line[i] === '(') depth++;
        else if (line[i] === ')' && --depth === 0) {
          close = i;
          break;
        }
      }
      // An argument that runs off the end of the line: the chain continues on
      // the next one, so this scan cannot answer and says so by failing.
      if (close < 0) return false;
      // Stop at the next `z.array(`, so a second array on the same line does
      // not lend this one its ceiling.
      const next = line.indexOf('z.array(', close);
      if (!/\.max\(/.test(line.slice(close, next < 0 ? undefined : next))) return false;
    }
    return true;
  }

  const arrays = (bounded: boolean) =>
    scan((line) => /z\.array\(/.test(line) && arraysBounded(line) === bounded);

  /**
   * A page size the caller chooses: `limit`, `per_page`, `count`, `page_size`.
   * `page` itself is absent on purpose — its ceiling is `pageParam()`'s, which
   * `paginationBounds.test.ts` holds, and it is written as a helper call rather
   * than as a `z.number()` chain.
   */
  const pageSizes = (bounded: boolean) =>
    scan(
      (line) =>
        /\b(?:limit|per_page|count|page_size)\s*:\s*z\./.test(line) &&
        /z\.(?:coerce\.)?number\(/.test(line) &&
        /\.max\(/.test(line) === bounded,
    );

  it('bounds every z.array a request is parsed with', () => {
    const unbounded = arrays(false).filter((hit) => !documentsOutput(hit));
    expect(unbounded.map((hit) => `${hit.where}  (${hit.owner})  ${hit.text}`)).toEqual([]);
  });

  it('bounds every page size a caller may name', () => {
    const unbounded = pageSizes(false).filter((hit) => !documentsOutput(hit));
    expect(unbounded.map((hit) => `${hit.where}  (${hit.owner})  ${hit.text}`)).toEqual([]);
  });

  it('is looking at a real population, and at declarations it can name', () => {
    // The vacuity guard, and this scan needs one: it goes green the moment the
    // `z.array(` spelling, the `.max(` spelling or the walk to the enclosing
    // `export const` stops firing, and all three are shapes a reformat moves.
    expect(arrays(true).length).toBeGreaterThan(30);
    expect(pageSizes(true).length).toBeGreaterThan(20);
    // Every bounded hit resolves to a declaration, so a failure would name the
    // schema rather than an empty string.
    expect(arrays(true).filter((hit) => hit.owner === '')).toEqual([]);
  });

  it('exempts output documentation only, and finds some to exempt', () => {
    // The exemption is load-bearing — without it this fails — so it has to be
    // asserted rather than assumed, in both directions: the exempted hits are
    // all in the partner contract, and they are all response schemas.
    const exempt = [...arrays(false), ...pageSizes(false)];
    expect(exempt.length).toBeGreaterThan(0);
    for (const hit of exempt) {
      expect(hit.owner, `${hit.where} is unbounded and does not document a response`).toMatch(/Response$/);
      expect(hit.where, `${hit.where} is outside the partner contract`).toContain('partnerApiContract.ts');
    }
  });
});
