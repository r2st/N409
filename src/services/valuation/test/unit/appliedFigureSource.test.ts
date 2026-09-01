import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OVERWRITE_FIELDS } from '../../src/domain/overwrites.js';
import { EngineInputsBody } from '../../src/routes/engineInputs.js';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * Four field names live in two registries, and only one of them is an input.
 *
 * `valuation_params.engine_inputs` is the document `buildEngineInputs`
 * (routes/calculations.ts) assembles a run from, alongside the stored
 * extraction, the screened peer set and the caller's own body. The `overwrites`
 * table is the audit trail beside a figure — the before/after pair, the reason
 * naming the run that produced it, the "was 0.65, now 0.64" on the overwrites
 * tab. Nothing merges the second into the first, and nothing is meant to: most
 * of the 68 override fields have no engine input at all, and the four that
 * share a name with one are the whole overlap.
 *
 * That overlap is the trap. A reader wanting "the sigma this engagement
 * applies" finds a row in `overwrites` with exactly that name, reads it, and is
 * wrong in a way that looks right — because the adopt route writes that row, so
 * the figure is there whenever the reader was written against an engagement
 * somebody had adopted one on. R302 found both live instances, in the same
 * file:
 *
 *   * `applied_volatility`, the figure the volatility panel exists to compare
 *     against a derivation, read nothing at all on an engagement whose sigma
 *     was typed on the financial-model form — which is the ordinary way it is
 *     set, and the only way before a derivation exists.
 *   * `time_to_exit_years`, carried to the estimator and onto the stored run as
 *     disclosure, was absent on every engagement that set its horizon the same
 *     way, so Exhibit F-1 printed a measurement window with no expected term
 *     beside it and made none of the disclosure it exists to make.
 *
 * A behavioural test closes the two sites. This closes the class: a file that
 * reads the override table must not be the file that asks one of these four
 * names what the engagement applies.
 *
 * `risk_free_rate` and `valuation_date` are the two that have never been read
 * this way. They are in the list because they are one plausible edit from it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const PKG = path.resolve(HERE, '../..');

/**
 * The body's own field names.
 *
 * `EngineInputsBody` carries a `.superRefine`, so it is a ZodEffects wrapping
 * the object rather than the object — `.shape` on it is undefined, and reading
 * it straight would hand this whole guard an empty key set and a green run.
 * Unwrapped until a shape appears, and the result is asserted below rather than
 * assumed.
 */
function objectShape(schema: unknown): Record<string, unknown> {
  let node = schema as { shape?: Record<string, unknown>; _def?: Record<string, unknown> } | undefined;
  for (let depth = 0; node && depth < 8; depth += 1) {
    const def = node._def as { shape?: () => Record<string, unknown>; schema?: unknown } | undefined;
    if (node.shape) return node.shape;
    if (typeof def?.shape === 'function') return def.shape();
    node = def?.schema as typeof node;
  }
  return {};
}

const ENGINE_INPUT_KEYS = new Set(Object.keys(objectShape(EngineInputsBody)));

/** The names that mean one thing in `engine_inputs` and another in `overwrites`. */
const SHARED_KEYS = OVERWRITE_FIELDS.map((f) => f.key)
  .filter((key) => ENGINE_INPUT_KEYS.has(key))
  .sort();

/**
 * The registry's own home, plus the two surfaces whose subject *is* the trail.
 *
 * `repos/overwrites.ts` and `routes/overwrites.ts` are the table's reader and
 * writer; `domain/overwrites.ts` is the field list itself, where every one of
 * these names is a declaration rather than a lookup. `export/valuationWorkbook.ts`
 * annotates an assumptions cell with whether an override was recorded against
 * it, which is a question about the trail and is answered correctly by reading
 * the trail.
 */
const TRAIL_IS_THE_SUBJECT = new Set([
  'src/domain/overwrites.ts',
  'src/repos/overwrites.ts',
  'src/routes/overwrites.ts',
  'src/export/valuationWorkbook.ts',
]);

/** Comments stripped: this class is explained in prose in the files it polices. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const offenders = sourceFiles(SRC)
  .map((file) => ({ rel: path.relative(PKG, file), source: code(readFileSync(file, 'utf8')) }))
  .filter(({ rel }) => !TRAIL_IS_THE_SUBJECT.has(rel))
  .filter(({ source }) => source.includes('listOverwrites'))
  .flatMap(({ rel, source }) =>
    SHARED_KEYS.filter((key) => source.includes(`'${key}'`) || source.includes(`"${key}"`)).map(
      (key) => `${rel}: ${key}`,
    ),
  );

describe('an applied figure is read from the engine inputs, not the override trail', () => {
  it('reads both registries rather than an empty set', () => {
    // A guard whose key set collapsed to nothing passes on every file in the
    // tree, which is the failure mode this class of test has.
    expect(ENGINE_INPUT_KEYS.has('volatility')).toBe(true);
    expect(ENGINE_INPUT_KEYS.size).toBeGreaterThan(10);
    expect(OVERWRITE_FIELDS.length).toBeGreaterThan(60);
  });

  it('names the overlap it is guarding', () => {
    // Asserted rather than trusted: the guard is worth exactly the key set it
    // walks, and a field renamed out of either registry would silently shrink
    // it to nothing.
    expect(SHARED_KEYS).toEqual(['risk_free_rate', 'time_to_exit_years', 'valuation_date', 'volatility']);
  });

  it('is not read out of the overwrites table anywhere in src', () => {
    expect(offenders).toEqual([]);
  });

  it('matches a lookup as it is actually written', () => {
    // The shape the two live instances had, so a reintroduction fails here.
    const sample = code(
      [
        "import { listOverwrites } from '../repos/overwrites.js';",
        "const applied = overwrites.find((o) => o.field_key === 'volatility');",
      ].join('\n'),
    );
    expect(sample.includes('listOverwrites')).toBe(true);
    expect(SHARED_KEYS.some((key) => sample.includes(`'${key}'`))).toBe(true);
  });

  it('leaves a file that reads the trail about a field with no engine input alone', () => {
    // `routes/comparables.ts` targets its screen on `ltm_revenue`,
    // `ltm_ebitda`, `industry_id` and `revenue_growth_rate` — override fields
    // with no engine input of the same name, so the trail is the only place
    // they exist and reading it is the right thing.
    for (const key of ['ltm_revenue', 'ltm_ebitda', 'industry_id', 'revenue_growth_rate']) {
      expect(SHARED_KEYS).not.toContain(key);
    }
  });
});
