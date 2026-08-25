/**
 * The third census: every figure a specialty engine computes reaches the
 * deliverable, or is named here as one a reader does not need and why.
 *
 * Two directions were already guarded and both walk the questionnaire:
 * `specialtyFieldConsumption.test.ts` checks every question reaches an engine,
 * and `specialtyEngineParams.test.ts` checks every parameter an engine accepts
 * is asked of somebody. Neither can see this one. A key the engine returns and
 * the exhibit never reads is not a missing question and not a defaulted
 * parameter — it is arithmetic that ran, was stored on the calculation, and
 * showed nobody.
 *
 * That has now happened five times, every one found by a person reading two
 * files side by side rather than by a test:
 *
 *   - IFRS 2 `remeasurement`, the liability a cash-settled award creates (R134);
 *   - ESOP `value_basis`, which decides whether the level-of-value ladder is a
 *     chain of discounts or a disclosure-only gross-up;
 *   - `shares_outstanding`, the divisor of the one division on that exhibit;
 *   - impairment `qualitative_only`, the client's own record that the
 *     quantitative test was not the test performed;
 *   - ASC 820 `sensitivity`, the narrative disclosure 820-10-50-2(g) asks for.
 *
 * What the engine returns is Python, so the keys are resolved there and
 * published as `engine-wrapper/contract/specialty-results.json`; a pytest keeps
 * that file true to the source and this file keeps the exhibits true to it.
 *
 * A key counts as read only if it is named in the exhibit's own code with the
 * comments stripped. Scanning the raw source would let a key be "covered" by a
 * comment explaining why it was dropped, and this file is comment-heavy enough
 * that the census would have passed on four of the five findings above.
 *
 * There are two sweeps here. The first reads the published contract, which is
 * top-level keys only — that is what an AST over `return {...}` can offer, and
 * R135 recorded the hole it leaves: a block built by a helper has no literal to
 * read, so `remeasurement`, `level_3_rollforward`, `obsolescence` and the
 * per-method schedules were unswept and an exhibit printing three of a block's
 * five fields passed. The second sweep reads the captured samples instead, one
 * level down and further, and is at the bottom of this file.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as SAMPLES from '../../src/domain/specialtySamples.js';

/** Endpoint path → result variant → the keys that variant returns. */
const CONTRACT = JSON.parse(
  readFileSync(new URL('../../../engine-wrapper/contract/specialty-results.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, string[]>>;

const SOURCE = readFileSync(new URL('../../src/domain/specialtyExhibits.ts', import.meta.url), 'utf8');

/**
 * The exhibit function each kind dispatches to, and the contract variants whose
 * keys land in the object it receives. A kind whose endpoint dispatches by
 * method or test takes the union: one exhibit renders all of them, so a key any
 * variant can produce is a key that exhibit has to handle.
 */
const KINDS: Record<string, { fn: string; path: string; variants?: string[] }> = {
  qsbs: { fn: 'qsbsExhibit', path: '/engine/v1/qsbs' },
  ppa: { fn: 'ppaExhibit', path: '/engine/v1/ppa' },
  goodwill: { fn: 'impairmentExhibit', path: '/engine/v1/impairment' },
  esop: { fn: 'esopExhibit', path: '/engine/v1/esop' },
  fmv: { fn: 'smbExhibit', path: '/engine/v1/smb' },
  emi: { fn: 'emiCsopExhibit', path: '/engine/v1/emi-csop', variants: ['result', 'qualification=emi'] },
  csop: {
    fn: 'emiCsopExhibit',
    path: '/engine/v1/emi-csop',
    variants: ['result', 'qualification=csop'],
  },
  ip: { fn: 'intangibleExhibit', path: '/engine/v1/intangible' },
  '820': { fn: 'fairValue820Exhibit', path: '/engine/v1/fair-value-820' },
  gifts: { fn: 'giftEstateExhibit', path: '/engine/v1/gift-estate' },
  ifrs2: { fn: 'ifrs2Exhibit', path: '/engine/v1/ifrs2' },
};

/**
 * Keys the exhibit deliberately does not print, each with the reason. A figure
 * belongs here only when a reader loses nothing by its absence — because the
 * exhibit already shows it under another name, or derives it in front of them,
 * or it is a machine-facing summary of a table printed in full.
 *
 * "The exhibit would be busier with it" is not a reason. Every one of the five
 * findings above would have read that way to whoever dropped it.
 */
const NOT_RENDERED: Record<string, Record<string, string>> = {
  qsbs: {
    failed_tests:
      'the names of the tests that failed, which the requirement table prints in full with a Pass/Fail on each row',
  },
  esop: {
    ending_share_balance:
      'the last row of the repurchase schedule, whose Remaining shares column is printed year by year',
  },
  emi: {
    // grant_umv, individual_total_umv and company_total_umv were excused here
    // until R136. The reason given for the first — "the concluded UMV per
    // share" — described a different figure by five orders of magnitude, and
    // the other two were said to be stated in their own check detail lines,
    // which is true of the *total* and not of the grant it is built from. All
    // three are rows on the exhibit now (`grantRows`).
    failed_checks:
      'the names of the checks that failed, which the Schedule 4/5 table prints in full with a Pass/Fail on each row',
  },
  csop: {
    failed_checks: 'the names of the checks that failed, which the Schedule 4 table prints in full',
  },
  '820': {
    measurement_date:
      "the report's own valuation date, carried in the ExhibitContext and printed on the cover rather than repeated per exhibit",
    predominant_level:
      'the level holding the most fair value, which the hierarchy table ranks by amount and by percentage of total',
    level_3_pct_of_total:
      "the Level 3 row's own % of total column, already the third column of the hierarchy table",
  },
  gifts: {
    value_bridge:
      'the same four steps the bridge table is built from, in list form; the exhibit prints the steps rather than the list',
    total_discount_amount:
      'the pro rata value less the concluded value, both printed as rows of the bridge two lines apart',
  },
  ifrs2: {
    tranches: 'the number of rows in the expense schedule under graded attribution, which is printed in full',
  },
};

/** One top-level function's own text, with comments stripped. */
function textOf(fn: string): string {
  const start = SOURCE.indexOf(`function ${fn}(`);
  expect(start, `${fn} is not in specialtyExhibits.ts`).toBeGreaterThan(-1);
  const nextFn = SOURCE.slice(start + 1).search(/^(?:export )?function \w+\(/m);
  const body = nextFn === -1 ? SOURCE.slice(start) : SOURCE.slice(start, start + 1 + nextFn);
  return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Every top-level declaration in the module, and its text.
 *
 * Functions and consts both, because a column spec is a const: `IP_SCHEDULE`
 * holds the key of every column of every IP schedule, so an exhibit that
 * renders all five of a relief-from-royalty row's fields names none of them in
 * its own body. A census reading only functions calls that exhibit blank.
 */
const DECLARED = new Map<string, string>();
{
  const heads = [...SOURCE.matchAll(/^(?:export )?(?:function|const) (\w+)\b/gm)];
  heads.forEach((head, i) => {
    const start = head.index!;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : SOURCE.length;
    DECLARED.set(
      head[1]!,
      SOURCE.slice(start, end)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' '),
    );
  });
}

/**
 * The exhibit's body together with the bodies of the module's own functions it
 * calls, transitively.
 *
 * An exhibit that delegates a table to a helper reads its keys there, not in
 * its own text, and a census over the body alone sees neither the rendering nor
 * — worse — the fact that an excuse for that key has gone stale. That is not
 * hypothetical: `grant_umv` was excused as "the concluded UMV per share" (it is
 * an aggregate five orders of magnitude larger), and when the EMI exhibit
 * started printing it from `grantRows` the excuse went on passing, because the
 * function that renders it is not the function the census was reading.
 */
function bodyOf(fn: string, seen = new Set<string>()): string {
  if (seen.has(fn)) return '';
  seen.add(fn);
  const own = fn in KINDS || DECLARED.get(fn) === undefined ? textOf(fn) : DECLARED.get(fn)!;
  const referenced = [...new Set([...own.matchAll(/\b(\w+)\b/g)].map((m) => m[1]!))].filter(
    (name) => name !== fn && DECLARED.has(name) && !seen.has(name),
  );
  return [own, ...referenced.map((name) => bodyOf(name, seen))].join('\n');
}

function variantsFor(kind: string): string[] {
  const spec = KINDS[kind]!;
  return spec.variants ?? Object.keys(CONTRACT[spec.path]!);
}

function keysFor(kind: string): string[] {
  const spec = KINDS[kind]!;
  const variants = CONTRACT[spec.path]!;
  const union = new Set<string>();
  for (const variant of variantsFor(kind)) {
    for (const key of variants[variant] ?? []) union.add(key);
  }
  return [...union].sort();
}

describe('every figure a specialty engine computes reaches its exhibit', () => {
  it.each(Object.keys(KINDS))('%s', (kind) => {
    const body = bodyOf(KINDS[kind]!.fn);
    const excused = NOT_RENDERED[kind] ?? {};
    const dropped = keysFor(kind).filter((key) => !body.includes(key) && !(key in excused));
    expect(
      dropped,
      `${KINDS[kind]!.fn} never reads ${dropped.join(', ')}. Either render ${
        dropped.length === 1 ? 'it' : 'them'
      }, or add ${dropped.length === 1 ? 'an entry' : 'entries'} to NOT_RENDERED saying what a ` +
        'reader sees instead.',
    ).toEqual([]);
  });

  /**
   * The excuse list is the part that rots. An entry for a key that is now
   * rendered reads as a standing decision not to print it, and an entry for a
   * key no engine returns is a reason attached to nothing — both make the
   * census look like it is covering ground it is not.
   */
  it.each(Object.keys(NOT_RENDERED))('%s excuses only keys that are really absent', (kind) => {
    const body = bodyOf(KINDS[kind]!.fn);
    const keys = new Set(keysFor(kind));
    for (const [key, reason] of Object.entries(NOT_RENDERED[kind]!)) {
      expect(keys.has(key), `${kind} excuses ${key}, which no variant of its engine returns`).toBe(true);
      expect(body.includes(key), `${kind} excuses ${key}, but the exhibit renders it`).toBe(false);
      expect(reason.length, `${kind}.${key} needs a reason, not a placeholder`).toBeGreaterThan(30);
    }
  });

  /** A census over an empty set passes without asking anything. */
  it('reads a non-empty key list for every kind', () => {
    for (const kind of Object.keys(KINDS)) {
      expect(keysFor(kind).length, `${kind} contributed no keys`).toBeGreaterThan(2);
    }
  });

  /**
   * Every kind that has an exhibit is censused. Adding a twelfth specialty
   * endpoint and forgetting this map would leave its result unswept while the
   * suite stayed green — which is exactly how `820`, `gifts` and `ifrs2` came
   * to render no schedules at all.
   */
  it('covers every kind the exhibit switch dispatches', () => {
    const dispatched = [...SOURCE.matchAll(/case '([^']+)':/g)].map((m) => m[1]!);
    expect([...new Set(dispatched)].sort()).toEqual(Object.keys(KINDS).sort());
  });

  /** Every contract variant is claimed by some kind, so none is swept by nobody. */
  it('reaches every variant the result contract publishes', () => {
    const claimed = new Set<string>();
    for (const kind of Object.keys(KINDS)) {
      for (const variant of variantsFor(kind)) claimed.add(`${KINDS[kind]!.path} ${variant}`);
    }
    const published = Object.entries(CONTRACT).flatMap(([path, variants]) =>
      Object.keys(variants).map((v) => `${path} ${v}`),
    );
    expect(published.filter((p) => !claimed.has(p))).toEqual([]);
  });
});

// ── The same census, one level down ─────────────────────────────────────────

/**
 * The sweep above reads top-level keys only, which is what the published
 * contract can offer: it is resolved from each engine's `return {...}` by AST,
 * and a block built by a helper or a comprehension has no literal to read. Its
 * own R135 note said so — `remeasurement`, `level_3_rollforward`, `obsolescence`
 * and the per-method schedules are nested one deeper, and an exhibit reading a
 * block and printing three of its five fields passed.
 *
 * Every kind now has a captured payload, so the nested keys are read from those
 * instead. They are not a second source of truth: `specialtySamples.ts` is
 * verbatim engine output with the inputs recorded beside it, which is a
 * stronger reading of the result shape than the AST, not a weaker one — it
 * carries what the engine actually built rather than what it wrote down.
 *
 * The cost is that a sample exercises one path through its engine. A block only
 * a different input produces is invisible here, so this sweep supplements the
 * contract rather than replacing it.
 */
const SAMPLES_OF: Record<string, unknown[]> = {
  qsbs: [SAMPLES.SAMPLE_QSBS_RESULT],
  ppa: [SAMPLES.SAMPLE_PPA_RESULT],
  goodwill: [SAMPLES.SAMPLE_GOODWILL_RESULT, SAMPLES.SAMPLE_IMPAIRMENT_LONG_LIVED_RESULT],
  esop: [SAMPLES.SAMPLE_ESOP_RESULT],
  fmv: [SAMPLES.SAMPLE_FMV_RESULT],
  emi: [SAMPLES.SAMPLE_EMI_RESULT],
  csop: [SAMPLES.SAMPLE_CSOP_RESULT],
  ip: [SAMPLES.SAMPLE_IP_RESULT, SAMPLES.SAMPLE_IP_COST_RESULT],
  '820': [SAMPLES.SAMPLE_820_RESULT],
  gifts: [SAMPLES.SAMPLE_GIFTS_RESULT],
  ifrs2: [SAMPLES.SAMPLE_IFRS2_RESULT, SAMPLES.SAMPLE_IFRS2_CASH_RESULT],
};

/**
 * Containers whose keys are data rather than field names — a check name, a
 * method name, an add-back's name. The exhibit walks them with
 * `Object.entries`, so their keys are never in the source and the sweep
 * descends to the *values* instead: `tests.*.passed`, not `tests.gross_asset_test`.
 *
 * Declared rather than guessed. A container listed here that the exhibit does
 * not in fact iterate would hide every one of its fields, so the list is short
 * and each entry is a map the engine builds from the caller's own vocabulary.
 */
const ITERATED: Record<string, string[]> = {
  qsbs: ['tests'],
  fmv: ['methods', 'weights', 'sde_normalization.addbacks', 'sde_normalization.deductions'],
  emi: ['qualification.checks'],
  csop: ['qualification.checks'],
  ip: ['obsolescence'],
};

/**
 * Nested paths the exhibit deliberately does not print, each with the reason —
 * the same bar as `NOT_RENDERED` and, being a level down, the same failure
 * mode: a block whose name is rendered and whose contents are not.
 */
const NESTED_NOT_RENDERED: Record<string, Record<string, string>> = {
  ppa: {
    'intangibles[].pv_explicit':
      'part of the method payload spliced in per asset; the PPA reader is looking at an allocation, and how one intangible was priced is the IP exhibit',
    'intangibles[].pv_terminal': 'the same, for the terminal half of a relief-from-royalty conclusion',
    'intangibles[].schedule':
      'the year-by-year workings for one asset; three assets at five years each is the whole IP exhibit three times over inside an allocation table',
    'intangibles[].schedule[].year': 'a column of the per-asset schedule, which this exhibit does not print',
    'intangibles[].schedule[].revenue': 'a column of the per-asset schedule',
    'intangibles[].schedule[].royalty_savings': 'a column of the per-asset relief-from-royalty schedule',
    'intangibles[].schedule[].after_tax': 'a column of the per-asset relief-from-royalty schedule',
    'intangibles[].schedule[].survival': 'a column of the per-asset MEEM schedule',
    'intangibles[].schedule[].attributable_revenue': 'a column of the per-asset MEEM schedule',
    'intangibles[].schedule[].ebit': 'a column of the per-asset MEEM schedule',
    'intangibles[].schedule[].after_tax_earnings': 'a column of the per-asset MEEM schedule',
    'intangibles[].schedule[].contributory_charge': 'a column of the per-asset MEEM schedule',
    'intangibles[].schedule[].excess_earnings': 'a column of the per-asset MEEM schedule',
    'intangibles[].schedule[].pv':
      'a column of the per-asset schedule; its total is the value before TAB, which is printed',
  },
  esop: {
    'repurchase_obligation.ending_share_balance':
      'the same figure the top-level census excuses under its own name — the last row of the schedule, whose Remaining shares column is printed year by year',
  },
  emi: {
    'qualification.failed_checks':
      'the same list the top-level census excuses under its own name; the Schedule 5 table prints every check with a Pass/Fail on it',
  },
  csop: {
    'qualification.failed_checks':
      'the same list the top-level census excuses under its own name; the Schedule 4 table prints every check with a Pass/Fail on it',
  },
  '820': {
    'positions[].significant_unobservable_inputs':
      'the per-position copy of the inputs; the exhibit prints the aggregated table 820-10-50-2(bbb) asks for, with the range, the weighted average and the fair value each input governs',
  },
  gifts: {
    'value_bridge[].step':
      'a field of `value_bridge`, which the top-level census excuses in full — the exhibit prints the four steps rather than the list of them',
    'value_bridge[].rate': 'a field of `value_bridge`; see the entry for the list itself',
    'value_bridge[].amount': 'a field of `value_bridge`; see the entry for the list itself',
    'rev_rul_59_60.unaddressed':
      'the names of the factors marked No, which the factor table prints in full with a Yes/No on every row and a count of those addressed',
  },
  ifrs2: {
    'true_up.applies':
      'the flag `true_up.basis` is worded from; the exhibit prints that sentence, which states both whether a true-up applies and the paragraph it follows from',
    'true_up.condition_in_fair_value': 'the other flag `true_up.basis` is worded from; see the entry above',
  },
};

/** Every path below the top level, arrays collapsed to `[]`, maps to `*`. */
function nestedPaths(kind: string): string[] {
  const iterated = new Set(ITERATED[kind] ?? []);
  const out = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, `${path}[]`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const map = iterated.has(path);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = map ? `${path}.*` : path === '' ? key : `${path}.${key}`;
      if (!map && path !== '') out.add(next);
      walk(child, next);
    }
  };
  for (const sample of SAMPLES_OF[kind] ?? []) walk(sample, '');
  return [...out].sort();
}

/** The key a path ends in, as a whole word — `pv` must not match `pv_explicit`. */
const reads = (body: string, path: string): boolean => {
  const key = path.split('.').pop()!.replace('[]', '');
  return new RegExp(`(?<![A-Za-z0-9_])${key}(?![A-Za-z0-9_])`).test(body);
};

describe('every figure nested inside a specialty result reaches its exhibit', () => {
  it.each(Object.keys(KINDS))('%s', (kind) => {
    const body = bodyOf(KINDS[kind]!.fn);
    const excused = NESTED_NOT_RENDERED[kind] ?? {};
    const dropped = nestedPaths(kind).filter((path) => !reads(body, path) && !(path in excused));
    expect(
      dropped,
      `${KINDS[kind]!.fn} never reads ${dropped.join(', ')}. Either render ${
        dropped.length === 1 ? 'it' : 'them'
      }, or add ${dropped.length === 1 ? 'an entry' : 'entries'} to NESTED_NOT_RENDERED saying ` +
        'what a reader sees instead.',
    ).toEqual([]);
  });

  it.each(Object.keys(NESTED_NOT_RENDERED))('%s excuses only nested paths that exist', (kind) => {
    const body = bodyOf(KINDS[kind]!.fn);
    const paths = new Set(nestedPaths(kind));
    for (const [path, reason] of Object.entries(NESTED_NOT_RENDERED[kind]!)) {
      expect(paths.has(path), `${kind} excuses ${path}, which its captured result does not contain`).toBe(
        true,
      );
      expect(reads(body, path), `${kind} excuses ${path}, but the exhibit renders it`).toBe(false);
      expect(reason.length, `${kind}.${path} needs a reason, not a placeholder`).toBeGreaterThan(30);
    }
  });

  /** A sweep over an empty object passes without asking anything. */
  it('reads at least one captured result for every kind', () => {
    for (const kind of Object.keys(KINDS)) {
      const samples = SAMPLES_OF[kind] ?? [];
      expect(samples.length, `${kind} has no captured sample`).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(Object.keys(sample as object).length, `${kind} has an empty sample`).toBeGreaterThan(2);
      }
    }
  });

  /** Every declared map really is one the engine keys by the caller's words. */
  it('only calls a container iterated when the captured result has one there', () => {
    for (const [kind, paths] of Object.entries(ITERATED)) {
      for (const path of paths) {
        // Any of the kind's samples: a second payload exists precisely because
        // one run cannot produce every block, and `obsolescence` is only in the
        // cost-approach one.
        const found = (SAMPLES_OF[kind] ?? [])
          .map((sample) => {
            let node: unknown = sample;
            for (const step of path.split('.')) node = (node as Record<string, unknown>)?.[step];
            return node;
          })
          .filter((node) => node !== null && typeof node === 'object');
        expect(
          found.length,
          `${kind} declares ${path} iterated; no captured result has an object there`,
        ).toBeGreaterThan(0);
        for (const node of found) {
          expect(Object.keys(node as object).length, `${kind}.${path} is empty`).toBeGreaterThan(0);
        }
      }
    }
  });
});
