import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { finite, finiteNonNegative, finitePositive } from '../../src/domain/finite.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * Infinity is a number to zod, and JSON hands it out for free.
 *
 * `z.number()` rejects NaN and stops there. `.positive()`, `.nonnegative()` and
 * `.min(0)` all constrain from below and let `Infinity` through; only a bound
 * that tests the top of the range — `.max()`, `.lt()`, `.lte()` — or `.int()`
 * or `.finite()` happens to exclude it. Meanwhile `JSON.parse('1e999')` is
 * `Infinity` and `JSON.stringify(Infinity)` is `null`, so the round trip through
 * a jsonb column or an outbound engine request turns the number an analyst sent
 * into "not provided", under a 200 that says it was saved.
 *
 * The first half of this file is the behaviour — that the schemas which were
 * letting that happen now refuse it. The second is a source scan, in the shape
 * of `privilegedRouteAuthorization.test.ts`, so the next `z.number().positive()`
 * fails here rather than in someone's cap table.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

describe('the JSON round trip this guards against', () => {
  it('parses 1e999 to Infinity and stringifies it back to null', () => {
    const parsed = JSON.parse('{"cash":1e999}') as { cash: number };
    expect(parsed.cash).toBe(Infinity);
    expect(JSON.stringify(parsed)).toBe('{"cash":null}');
  });

  it('is exactly what a lower bound alone fails to catch', () => {
    expect(z.number().positive().safeParse(Infinity).success).toBe(true);
    expect(z.number().nonnegative().safeParse(Infinity).success).toBe(true);
    expect(z.number().min(0).safeParse(Infinity).success).toBe(true);
  });
});

describe('domain/finite', () => {
  it('refuses both infinities and NaN', () => {
    for (const schema of [finite(), finiteNonNegative(), finitePositive()]) {
      expect(schema.safeParse(Infinity).success).toBe(false);
      expect(schema.safeParse(-Infinity).success).toBe(false);
      expect(schema.safeParse(NaN).success).toBe(false);
    }
  });

  it('keeps the sign constraints it is named for', () => {
    expect(finite().safeParse(-3.5).success).toBe(true);
    expect(finiteNonNegative().safeParse(0).success).toBe(true);
    expect(finiteNonNegative().safeParse(-0.01).success).toBe(false);
    expect(finitePositive().safeParse(0).success).toBe(false);
    expect(finitePositive().safeParse(0.01).success).toBe(true);
  });
});

describe('engine inputs refuse an overflowed number', () => {
  // Imported lazily so the source scan below still runs if the route module
  // grows an import that needs a live pool.
  const load = async () => (await import('../../src/routes/engineInputs.js')).EngineInputsBody;

  it('rejects a share count of 1e999 rather than storing null', async () => {
    const EngineInputsBody = await load();
    const body = JSON.parse(
      '{"share_classes":[{"kind":"common","name":"Common","shares":1e999}]}',
    ) as unknown;
    const result = EngineInputsBody.safeParse(body);
    expect(result.success).toBe(false);
  });

  it.each([
    ['cash', '{"cash":1e999}'],
    ['debt', '{"debt":1e999}'],
    ['shares_outstanding_common', '{"shares_outstanding_common":1e999}'],
    ['liquidation_preference', '{"liquidation_preference":1e999}'],
    ['last_round_post_money', '{"last_round_post_money":1e999}'],
    ['income.free_cash_flows', '{"income":{"free_cash_flows":[1e999]}}'],
    ['income.terminal_metric', '{"income":{"terminal_metric":1e999}}'],
    ['market_movement.index_end', '{"market_movement":{"index_end":1e999}}'],
  ])('rejects %s', async (_field, json) => {
    const EngineInputsBody = await load();
    expect(EngineInputsBody.safeParse(JSON.parse(json)).success).toBe(false);
  });

  it('still accepts the large-but-real figures a cap table carries', async () => {
    const EngineInputsBody = await load();
    const result = EngineInputsBody.safeParse({
      shares_outstanding_common: 8_000_000,
      cash: 12_500_000.75,
      debt: 0,
      income: { free_cash_flows: [-2_000_000, 4_000_000], terminal_metric: 9_000_000 },
    });
    expect(result.success).toBe(true);
  });
});

/**
 * Every `z.number()` in the service, with the method chain that follows it.
 * Deliberately textual: the schemas are module-level constants spread over 80
 * route files, and importing them all to introspect `_def` would run every
 * module's side effects to check a property the source already states.
 */
interface NumberSite {
  file: string;
  line: number;
  chain: string;
}

/** Method names, in order, chained onto the expression starting at `from`. */
function chainAfter(source: string, from: number): string[] {
  const parts: string[] = [];
  let i = from;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (source[i] !== '.') break;
    let j = i + 1;
    let name = '';
    while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) name += source[j++]!;
    if (!name) break;
    while (j < source.length && /\s/.test(source[j]!)) j++;
    if (source[j] === '(') {
      let depth = 0;
      do {
        if (source[j] === '(') depth++;
        else if (source[j] === ')') depth--;
        j++;
      } while (j < source.length && depth > 0);
    }
    parts.push(name);
    i = j;
  }
  return parts;
}

/** A chain that cannot admit Infinity, whatever else it does or does not do. */
const EXCLUDES_INFINITY = new Set(['finite', 'max', 'lt', 'lte', 'int']);

function unboundedNumberSites(): NumberSite[] {
  const sites: NumberSite[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/z\.number\(\)/g)) {
      const chain = chainAfter(source, match.index + match[0].length);
      if (chain.some((part) => EXCLUDES_INFINITY.has(part))) continue;
      sites.push({
        file: path.relative(SRC, file),
        line: source.slice(0, match.index).split('\n').length,
        chain: chain.join('.'),
      });
    }
  }
  return sites;
}

/**
 * Sites that admit Infinity at the schema and are bounded somewhere the scan
 * cannot see. Same contract as the route-audit exemption lists: each one names
 * what checks it instead, so a reviewer can go and read that check.
 */
const BOUNDED_ELSEWHERE: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'routes/overwrites.ts',
    reason:
      'the override value is a union whose numeric branch is checked by ' +
      "domain/overwrites.ts validateOverwriteValue — 'must be a finite number', plus the field's own min/max",
  },
  {
    file: 'domain/finite.ts',
    reason: 'the module that defines the bound; `.finite()` is applied by its exported factories',
  },
];

const EXEMPT_FILES = new Set(BOUNDED_ELSEWHERE.map((e) => e.file));

describe('no schema accepts Infinity', () => {
  const sites = unboundedNumberSites();

  it('finds the z.number() sites at all (the scan is not silently empty)', () => {
    const scanned = sourceFiles(SRC).filter((f) => readFileSync(f, 'utf8').includes('z.number()'));
    expect(scanned.length).toBeGreaterThan(20);
  });

  it('leaves none unbounded outside the exemption list', () => {
    const offenders = sites
      .filter((s) => !EXEMPT_FILES.has(s.file))
      .map((s) => `${s.file}:${s.line}  z.number().${s.chain}`);
    expect(offenders).toEqual([]);
  });

  it('keeps the exemption list honest — every entry still has a site', () => {
    const files = new Set(sites.map((s) => s.file));
    for (const entry of BOUNDED_ELSEWHERE) {
      if (entry.file === 'domain/finite.ts') continue; // the definition, not a use
      expect(files.has(entry.file), `${entry.file} no longer has an unbounded z.number()`).toBe(true);
    }
  });
});
