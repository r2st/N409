import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every list the evidence bundle counts either says when it stopped short, or
 * says why it cannot.
 *
 * The bundle is the artifact an auditor reads to answer "what is *not* here",
 * and its manifest hands them a `counts` map to answer it with. That makes a
 * silently short list worse here than anywhere else in the product: a page of
 * five hundred admin events reported as `admin_events: 500` is not a short
 * list, it is a bundle stating a wrong fact about the engagement, under a
 * heading that exists to be trusted.
 *
 * R221 found three lists in exactly that state — the spine, the review tasks
 * and the admin events — and capped and flagged all three. What it could not
 * fix is why they were missed: the manifest's `counts` and `truncated` maps
 * are two literals fifty lines apart, and nothing has ever required a key in
 * the first to appear in the second. `nonRepoQueryCensus` pins the three
 * flags R221 added, by name; that is a regression guard for three known bugs
 * and says nothing about the twentieth list somebody adds next year.
 *
 * So this is the population guard beside it, in the direction that catches the
 * next one: read both maps out of the route and require every counted list to
 * be flagged, or to be named below with the mechanism that makes it whole. The
 * bar is `unboundedListCensus`' — a mechanism, not a hope. A list that is
 * "never long in practice" is a list whose count will be wrong on the day it
 * is, in the file whose whole purpose is being right about that.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.resolve(here, '../../src/routes/evidence.ts');

/**
 * Counted lists that carry no truncation flag, and why each one is whole.
 *
 * Two kinds:
 *
 *   * `derived` — the number is computed from another counted list, so the
 *     flag on that list is the flag on this one. Giving it a second flag would
 *     be a second place to go stale.
 *   * `bounded` — the read cannot reach a cap, because the schema or the write
 *     path caps the rows first.
 */
const WHOLE: Record<string, { kind: 'derived' | 'bounded'; why: string }> = {
  field_changes: {
    kind: 'derived',
    why: 'Summed across `auditEntries`, which is `events` enriched — so `events`’ own flag is this number’s flag, and a second one could only disagree with it.',
  },
  calculation_traces: {
    kind: 'derived',
    why: '`listCalculationTraces` shares `listCalculations`’ window on purpose (CALCULATION_PAGE_LIMIT), so the runs and their traces describe the same set and one flag speaks for both.',
  },
  workbook_anomalies: {
    kind: 'derived',
    why: 'Findings computed by `detectFinancialAnomalies` over the workbook this bundle carries, so `workbook_cells`’ flag already says whether the grid they ran over was short.',
  },
  comparables_excluded: {
    kind: 'derived',
    why: 'A filter over the same `comparables` array, so the peer set’s own flag covers it — the excluded rows cannot be short while the set they come from is complete.',
  },
  signatures: {
    kind: 'bounded',
    why: 'UNIQUE (valuation_id, role) with `role` the `signature_role` enum, so the row count per engagement is the length of that enum whatever anybody signs.',
  },
  scenarios: {
    kind: 'bounded',
    why: 'MAX_SCENARIOS = 12, enforced by `countScenarios` on create — the bound is on the write, so the read cannot reach a cap.',
  },
};

const source = readFileSync(EVIDENCE, 'utf8');

/** An object literal `name: { … }`, brace-matched from the route source. */
function literal(name: string): string {
  const at = source.indexOf(`${name}: {`);
  expect(at, `${name} is no longer an object literal in evidence.ts`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`${name} literal is unterminated`);
}

/** Code only — this route explains every one of these keys at length. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
}

/**
 * The keys of `counts`: the properties one level inside the literal.
 *
 * Depth-matched rather than indentation-matched, because indentation is the
 * one thing about this file a reformat is guaranteed to change, and a scan
 * that read the wrong column would report an empty census rather than an error.
 */
function countedLists(): string[] {
  const body = code(literal('counts'));
  const keys: string[] = [];
  let depth = 0;
  for (const match of body.matchAll(/[{}]|(\w+)\s*:/g)) {
    if (match[0] === '{') depth++;
    else if (match[0] === '}') depth--;
    else if (depth === 1 && match[1]) keys.push(match[1]);
  }
  return keys;
}

/**
 * The lists `truncated` reports on. Each is written as a conditional spread of
 * a one-key object — `...(xTruncated ? { comments: COMMENT_PAGE_LIMIT } : {})`
 * — so the key is the flagged list and the value is the page size it stopped at.
 */
function flaggedLists(): string[] {
  return [...code(literal('truncated')).matchAll(/\{\s*(\w+):\s*[A-Za-z_][\w.]*\s*\}/g)].map((m) => m[1]!);
}

describe('the evidence bundle manifest cannot count a list it never flags', () => {
  it('reads both maps out of the route', () => {
    // The vacuity guard. Every regex here is over a shape this file reformats
    // — a literal re-indented, a spread rewritten — and the census passes
    // trivially the moment one stops firing.
    const counted = countedLists();
    const flagged = flaggedLists();
    expect(counted.length).toBeGreaterThan(15);
    expect(flagged.length).toBeGreaterThan(10);
    expect(counted).toContain('events');
    expect(counted).toContain('admin_events');
    // The three R221 capped and flagged, which is what this census generalises.
    for (const list of ['events', 'review_tasks', 'admin_events']) expect(flagged).toContain(list);
  });

  it('flags every counted list, or says what makes it whole', () => {
    const flagged = new Set(flaggedLists());
    expect(countedLists().filter((key) => !flagged.has(key) && !(key in WHOLE))).toEqual([]);
  });

  it('accounts for nothing that has since gained a flag or gone away', () => {
    const counted = new Set(countedLists());
    const flagged = new Set(flaggedLists());
    expect(Object.keys(WHOLE).filter((key) => !counted.has(key) || flagged.has(key))).toEqual([]);
  });

  it('flags nothing the manifest does not also count', () => {
    // The other direction: a flag whose list is absent from `counts` reports a
    // page size for a number the reader was never given, which is a truncation
    // notice about nothing.
    const counted = new Set(countedLists());
    expect(flaggedLists().filter((key) => !counted.has(key))).toEqual([]);
  });

  it('states a mechanism, not a hope, for every unflagged list', () => {
    const vague = Object.entries(WHOLE).filter(
      ([, entry]) =>
        entry.why.trim().length < 40 ||
        /\b(small|short|few|low) (enough|in practice)\b|\bunlikely to\b|\brarely\b|\bfor now\b|\bnobody has\b|\bin practice\b/i.test(
          entry.why,
        ),
    );
    expect(vague.map(([key]) => key)).toEqual([]);
  });

  it('holds the two bounds it claims are on the write side', () => {
    // `bounded` is the only kind here that is a claim about another file, and
    // it is the kind that rots: a cap lifted elsewhere turns this entry into
    // the "small in practice" the suite above refuses.
    const scenarios = readFileSync(path.resolve(here, '../../src/routes/scenarios.ts'), 'utf8');
    expect(scenarios).toMatch(/MAX_SCENARIOS\s*=\s*12/);
    // The signature bound is in the schema rather than in a constant, so it is
    // the migration that has to still say it.
    const table = readFileSync(
      path.resolve(here, '../../migrations/0041_payments_signatures_pipeline.sql'),
      'utf8',
    );
    expect(table).toMatch(/role\s+signature_role NOT NULL/);
    expect(table).toContain('UNIQUE (valuation_id, role)');
  });
});
