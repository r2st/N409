import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODEL_DLOM_METHODS } from '../../src/domain/dlom.js';
import { DLOC_METHODS, DLOM_METHODS } from '../../src/repos/params.js';

/**
 * The discount vocabularies are spelled twice — once in the engine, once here —
 * and nothing made the two agree.
 *
 * The engine is the authority: `dlom.py` and `dloc.py` decide what a run can
 * dispatch on. This service re-states those lists because it has to answer
 * questions before dispatching — the params route validates a method, the
 * health checks and the QA gate ask whether a chosen method needs a
 * volatility. Three separate `as const` arrays, kept true to Python by comment
 * alone.
 *
 * Drift is silent in the direction that matters. Adding a fifth model DLOM to
 * the engine without mirroring it here does not break a run: the method
 * dispatches fine, and the pre-dispatch check simply stops recognising it as
 * volatility-derived, so a payload missing `inputs.volatility` gets no warning
 * and the discount comes back at zero. In a blend that is worse still — the
 * model leg contributes silently nothing, so the concluded figure is a
 * plausible-looking number that is merely too low, in a document that states a
 * per-share value someone grants options at.
 *
 * `dlom.py`'s own docstring already promises this: "every caller that used to
 * spell `("chaffee", "finnerty")` inline reads it from here, so adding a fifth
 * model cannot miss a check." That is true of the Python callers. It was not
 * true across the language boundary, which is where the callers actually are.
 */

const enginePath = (file: string): URL =>
  new URL(`../../../engine-wrapper/app/engine/${file}`, import.meta.url);

/**
 * A `frozenset({...})` literal, by the name it is bound to.
 *
 * Deliberately narrow. It matches the one form these constants are written in
 * and throws on anything else rather than returning an empty set, because a
 * parser that silently finds nothing turns this whole file into a test that
 * two empty sets are equal.
 */
function frozensetLiteral(source: string, name: string): Set<string> {
  const line = new RegExp(
    `^${name}\\s*:\\s*frozenset\\[str\\]\\s*=\\s*frozenset\\(\\{([^}]*)\\}\\)`,
    'm',
  ).exec(source);
  if (!line) throw new Error(`no frozenset literal named ${name}; has it been rewritten?`);
  const members = [...line[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  if (members.length === 0) throw new Error(`${name} parsed as empty`);
  return new Set(members);
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

const DLOM_PY = readFileSync(enginePath('dlom.py'), 'utf8');
const DLOC_PY = readFileSync(enginePath('dloc.py'), 'utf8');

describe('the discount vocabularies match the engine that dispatches on them', () => {
  it('parses the engine sets at all', () => {
    // The vacuity guard. Every assertion below compares against these, so a
    // regex that stopped matching would make the whole file agree with itself.
    expect(sorted(frozensetLiteral(DLOM_PY, 'MODEL_DLOM_METHODS')).length).toBeGreaterThan(0);
    expect(sorted(frozensetLiteral(DLOM_PY, 'STUDY_DLOM_METHODS')).length).toBeGreaterThan(0);
    expect(sorted(frozensetLiteral(DLOC_PY, 'DLOC_METHODS')).length).toBeGreaterThan(0);
    expect(() => frozensetLiteral(DLOM_PY, 'NO_SUCH_SET')).toThrow();
  });

  it('mirrors MODEL_DLOM_METHODS, the set a missing volatility is checked against', () => {
    expect(sorted(MODEL_DLOM_METHODS)).toEqual(sorted(frozensetLiteral(DLOM_PY, 'MODEL_DLOM_METHODS')));
  });

  it('mirrors DLOM_METHODS, the set the params route validates against', () => {
    // Composed in Python as `MODEL | STUDY | {"qualitative"}`, so it is
    // composed the same way here rather than parsed — the union is the claim.
    const expected = new Set([
      ...frozensetLiteral(DLOM_PY, 'MODEL_DLOM_METHODS'),
      ...frozensetLiteral(DLOM_PY, 'STUDY_DLOM_METHODS'),
      'qualitative',
    ]);
    expect(sorted(DLOM_METHODS)).toEqual(sorted(expected));

    // And the union is still how the engine builds it. If `DLOM_METHODS` in
    // dlom.py gains a fourth term, the line above is comparing against a set
    // the engine no longer has.
    expect(DLOM_PY).toMatch(
      /^DLOM_METHODS\s*:\s*frozenset\[str\]\s*=\s*MODEL_DLOM_METHODS\s*\|\s*STUDY_DLOM_METHODS\s*\|\s*\{"qualitative"\}\s*$/m,
    );
  });

  it('mirrors DLOC_METHODS', () => {
    expect(sorted(DLOC_METHODS)).toEqual(sorted(frozensetLiteral(DLOC_PY, 'DLOC_METHODS')));
  });

  it('keeps the model methods a strict subset of the dispatchable ones', () => {
    // Not implied by the two comparisons above once either side is wrong, and
    // it is the invariant the QA gate leans on: a method it calls
    // volatility-derived must be a method a run can actually select.
    for (const method of MODEL_DLOM_METHODS) {
      expect(DLOM_METHODS as readonly string[], method).toContain(method);
    }
    expect(MODEL_DLOM_METHODS.length).toBeLessThan(DLOM_METHODS.length);
  });
});
