import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * A zod `.parse()` inside a request handler is a 500 waiting for a bad body.
 *
 * `registerProblemHandler` renders anything that is not an `ApiProblem` and
 * carries no `statusCode` as `urn:n409:problem:internal` with a 500. A ZodError
 * is exactly that: it has a `name`, an `issues` array and nothing the handler
 * can read a status off. So a client that sends `{"apply": "yes"}` where a
 * boolean was wanted is told the *server* failed and that retrying might work,
 * for a body that can never be accepted — and the operator gets an `unhandled
 * error` log line and a bump in the 5xx rate for someone else's typo.
 *
 * This service reads bodies with `safeParse` in 227 places and did it with a
 * throwing `.parse()` in exactly one (`capTableSync.ts`, the pull body — R87).
 * That is the shape of the mistake: not a policy nobody follows, a single
 * instance that slipped past review because the two spellings differ by four
 * characters and both compile.
 *
 * A behavioural test closes the one route. This closes the class, and it is the
 * only thing that can: there is no request that exercises "some future handler
 * someone writes with `.parse()`", and adding a blanket ZodError branch to the
 * shared error handler would be worse than the gap — a ZodError raised while
 * parsing a *provider's* response is a genuine upstream fault, and rendering
 * that as "your request is invalid" would misdiagnose an outage as a client bug.
 *
 * ## What counts
 *
 * Only zod. `JSON.parse`, `Number.parseInt`, `Date.parse` and the several
 * domain parsers named `parse…` are different functions with different
 * contracts, so the scan resolves the receiver to a zod schema declared in the
 * same file rather than matching the method name. `safeParse` and
 * `safeParseAsync` are the correct spellings and are not matched at all — the
 * literal `.parse(` does not occur in either.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const REPORT_SRC = path.resolve(HERE, '../../../report/src');

/**
 * Names bound to a zod schema in this file: `const X = z.…`, and the re-export
 * shape `export const X = z.…`. Only same-file bindings, deliberately — an
 * imported schema is resolvable in principle and the false-positive risk is not
 * worth it, and every schema this service parses is declared beside its route.
 */
export function zodSchemaNames(source: string): Set<string> {
  const names = new Set<string>();
  const decl = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*z\s*\./g;
  for (const m of source.matchAll(decl)) names.add(m[1]!);
  return names;
}

/** `Name.parse(` / `Name.parseAsync(` for any of the given names. */
export function throwingParses(source: string, names: Set<string>): string[] {
  const out: string[] = [];
  const call = /([A-Za-z_$][\w$]*)\s*\.\s*(parse|parseAsync)\s*\(/g;
  for (const m of source.matchAll(call)) {
    if (names.has(m[1]!)) out.push(`${m[1]}.${m[2]}(`);
  }
  // An inline schema parsed on the spot, with no name to resolve.
  const inline = /\bz\s*\.[\w.]+\([^\n]*\)\s*\.\s*(parse|parseAsync)\s*\(/g;
  for (const m of source.matchAll(inline)) out.push(`z.….${m[1]}(`);
  return out;
}

function scan(dir: string): { file: string; call: string }[] {
  const found: { file: string; call: string }[] = [];
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes("from 'zod'")) continue;
    for (const call of throwingParses(source, zodSchemaNames(source))) {
      found.push({ file: path.relative(path.resolve(HERE, '../../../..'), file), call });
    }
  }
  return found;
}

describe('the scanner itself', () => {
  it('finds a schema declared with or without export and with a type annotation', () => {
    const names = zodSchemaNames(
      [
        'const A = z.object({});',
        'export const B = z.string();',
        'const C: z.ZodType<number> = z.number();',
        '  const D = z\n    .object({})\n    .strict();',
      ].join('\n'),
    );
    expect([...names].sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('flags a throwing parse on a schema it resolved', () => {
    const src = 'const Body = z.object({});\nconst v = Body.parse(req.body);';
    expect(throwingParses(src, zodSchemaNames(src))).toEqual(['Body.parse(']);
  });

  it('flags parseAsync, which throws the same way', () => {
    const src = 'const Body = z.object({});\nawait Body.parseAsync(req.body);';
    expect(throwingParses(src, zodSchemaNames(src))).toEqual(['Body.parseAsync(']);
  });

  it('flags an inline schema parsed on the spot', () => {
    const src = 'const v = z.object({ a: z.string() }).parse(req.body);';
    expect(throwingParses(src, zodSchemaNames(src))).toEqual(['z.….parse(']);
  });

  it('does not flag safeParse, which is the correct spelling', () => {
    const src = [
      'const Body = z.object({});',
      'const p = Body.safeParse(req.body);',
      'const q = await Body.safeParseAsync(req.body);',
    ].join('\n');
    expect(throwingParses(src, zodSchemaNames(src))).toEqual([]);
  });

  it('does not flag the other parsers that share the method name', () => {
    const src = [
      'const Body = z.object({});',
      'const e = JSON.parse(raw);',
      'const n = Number.parseInt(s, 10);',
      'const d = Date.parse(s);',
      'const c = currencyParser.parse(s);',
    ].join('\n');
    expect(throwingParses(src, zodSchemaNames(src))).toEqual([]);
  });

  it('walks a non-empty file set, so a green result is not vacuous', () => {
    const withZod = sourceFiles(SRC).filter((f) => readFileSync(f, 'utf8').includes("from 'zod'"));
    expect(withZod.length).toBeGreaterThan(50);
  });
});

describe('zod throwing-parse sweep', () => {
  it('parses no request-shaped value with a throwing zod parse (valuation)', () => {
    expect(scan(SRC).map((f) => `${f.file}  ${f.call}`)).toEqual([]);
  });

  it('parses no request-shaped value with a throwing zod parse (report)', () => {
    expect(scan(REPORT_SRC).map((f) => `${f.file}  ${f.call}`)).toEqual([]);
  });
});
