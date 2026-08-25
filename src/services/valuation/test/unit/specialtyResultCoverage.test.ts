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
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
    grant_umv: 'the concluded UMV per share, printed as its own row above the checks',
    individual_total_umv:
      "stated in the individual-limit check's own detail line, against the limit it is being tested on",
    company_total_umv: "stated in the company-limit check's own detail line",
    failed_checks:
      'the names of the checks that failed, which the Schedule 4/5 table prints in full with a Pass/Fail on each row',
  },
  csop: {
    grant_umv: 'the concluded UMV per share, printed as its own row above the checks',
    individual_total_umv: "stated in the individual-limit check's own detail line",
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

/** The exhibit function's body, with comments stripped. */
function bodyOf(fn: string): string {
  const start = SOURCE.indexOf(`function ${fn}(`);
  expect(start, `${fn} is not in specialtyExhibits.ts`).toBeGreaterThan(-1);
  const nextFn = SOURCE.slice(start + 1).search(/^(?:export )?function \w+\(/m);
  const body = nextFn === -1 ? SOURCE.slice(start) : SOURCE.slice(start, start + 1 + nextFn);
  return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
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
