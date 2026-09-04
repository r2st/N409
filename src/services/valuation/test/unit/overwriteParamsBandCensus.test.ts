import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OVERWRITE_FIELDS_BY_KEY,
  PARAMS_DERIVED_KEYS,
  overwriteBand,
} from '../../src/domain/overwrites.js';

/**
 * Two doors onto one figure, stating one range (R406, methodology M6).
 *
 * `domain/overwrites.ts` publishes a numeric range per field and
 * `validateOverwriteValue` enforces it; `routes/params.ts` bounds the same
 * quantities on the screen the engine's input is actually typed on. Four keys
 * were bounded in both files under different numbers — see PARAMS_BAND — so a
 * figure the params screen accepted was one the Overwrites tab refused to
 * record, and the schema endpoint published a maximum the platform did not
 * hold to.
 *
 * The four are wired to the registry now. This census is about the fifth: a key
 * that comes to be bounded in both places with two literals, which is the shape
 * the bug had. Scanned rather than listed, because a list only holds what
 * somebody remembered to add to it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARAMS = path.resolve(HERE, '../../src/routes/params.ts');

/**
 * Names the two files share that are not the same figure.
 *
 * The census matches on the key, which is what makes it cheap and what makes
 * it right for the four it was written for — an analyst reading the Overwrites
 * tab and the params screen sees one field. It also means a name reused for a
 * different quantity looks like a disagreement, so each one is written down
 * with why it is not.
 *
 * Not covered, and deliberately: the registry's `industry_beta` (−2 … 5) and
 * the params route's `unlevered_beta_input` (−5 … 10) *are* one quantity under
 * two names, so no key-matching census can see them. They are left as they are
 * rather than quietly aligned — nothing publishes one as the schema of the
 * other, which is the failure PARAMS_BAND is about.
 */
const DIFFERENT_CELL: ReadonlyMap<string, string> = new Map([
  [
    'beta',
    "the registry's `beta` is the engagement's relevered equity beta; the params route bounds " +
      'one peer’s own beta inside `wacc_inputs.comparable_betas[]`, which is an observation about ' +
      'that company rather than a figure imposed on this engagement',
  ],
]);

/** `key: z.number()…min(a)…max(b)` occurrences in the params route. */
function literalBands(source: string): Map<string, { min?: number; max?: number }> {
  const found = new Map<string, { min?: number; max?: number }>();
  const re = /\b([a-z_][a-z0-9_]*)\s*:\s*(z\.number\(\)[^\n,]*)/g;
  for (const m of source.matchAll(re)) {
    const [, key, expr] = m;
    const lo = /\.(?:min|gte)\((-?[\d_.]+)\)/.exec(expr!) ?? /\.gt\((-?[\d_.]+)\)/.exec(expr!);
    const hi = /\.(?:max|lte)\((-?[\d_.]+)\)/.exec(expr!) ?? /\.lt\((-?[\d_.]+)\)/.exec(expr!);
    if (!lo && !hi) continue;
    const num = (raw: string): number => Number(raw.replaceAll('_', ''));
    found.set(key!, {
      ...(lo ? { min: num(lo[1]!) } : {}),
      ...(hi ? { max: num(hi[1]!) } : {}),
    });
  }
  return found;
}

describe('overwrite / params band census', () => {
  const source = readFileSync(PARAMS, 'utf8');

  it('bounds no registry-ranged field with its own literals', () => {
    const offenders: string[] = [];
    for (const [key, band] of literalBands(source)) {
      if (DIFFERENT_CELL.has(key)) continue;
      const def = OVERWRITE_FIELDS_BY_KEY.get(key);
      if (!def || (def.min === undefined && def.max === undefined)) continue;
      if (band.min !== def.min || band.max !== def.max) {
        offenders.push(
          `${key}: params [${band.min}, ${band.max}] vs overwrites [${def.min}, ${def.max}] — ` +
            "derive it with banded('" +
            key +
            "') instead of restating the numbers",
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('derives the four shared keys from the registry', () => {
    // The scan above cannot see a `banded(...)` call, so the wiring is asserted
    // directly: a refactor that quietly reverted one to literals fails the
    // first test, and one that dropped the call fails this one.
    for (const key of PARAMS_DERIVED_KEYS) {
      expect(source).toContain(`banded('${key}')`);
      expect(() => overwriteBand(key)).not.toThrow();
    }
  });

  it('publishes the band the params screen accepts', () => {
    expect(overwriteBand('runway_months')).toEqual({ min: 0, max: 600 });
    expect(overwriteBand('forecast_horizon_years')).toEqual({ min: 0, max: 50 });
    expect(overwriteBand('equity_risk_premium')).toEqual({ min: 0, max: 1 });
    // The one the params route argues for in prose: 100%+ control premiums are
    // observed, and a registry ceiling of 1 refused to record them.
    expect(overwriteBand('control_premium')).toEqual({ min: 0, max: 10 });
  });

  it('exempts only names that are a different figure', () => {
    // An exemption for a key the params route no longer bounds is a note about
    // code that is gone, and the next reader takes it for a live one.
    const bounded = literalBands(source);
    for (const key of DIFFERENT_CELL.keys()) {
      expect(bounded.has(key), `${key} is exempted but not bounded in params.ts`).toBe(true);
      expect(OVERWRITE_FIELDS_BY_KEY.has(key)).toBe(true);
    }
  });

  it('refuses to hand out a band the registry does not state', () => {
    expect(() => overwriteBand('company_legal_name')).toThrow(/no bounded range/);
    expect(() => overwriteBand('not_a_field')).toThrow(/No overwrite field/);
  });
});
