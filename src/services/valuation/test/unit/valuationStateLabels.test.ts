import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VALUATION_STATES,
  VALUATION_STATE_LABELS,
  stateLabel,
  type ValuationState,
} from '../../src/domain/valuation.js';

/**
 * The words an operator is shown for a lifecycle state, on both sides of the
 * wire (round 255).
 *
 * Eight refusals interpolated the column value straight into their `detail`:
 * "Illegal transition draft_changes → published", "Cannot restart from
 * 'onboarding_completed'", and a comma-separated list of legal next states that
 * was fourteen more of the same. Those keys appear nowhere a person can see
 * them — the screen the operator is looking at while being refused labels the
 * very same column "Changes requested".
 *
 * web-frontend does not depend on `@n409/shared`, so its `STATE_LABELS` and the
 * service's `VALUATION_STATE_LABELS` are two copies of one fact, and a copy
 * nothing compares is a copy that drifts. This reads the browser's map out of
 * source and requires the two to agree, which is the cheapest place to catch a
 * rename that only half-lands.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORMAT = path.resolve(HERE, '../../../web-frontend/src/lib/format.ts');

/** The browser's `STATE_LABELS` object literal, read as text. */
function browserLabels(): Record<string, string> {
  const source = readFileSync(FORMAT, 'utf8');
  const start = source.indexOf('export const STATE_LABELS');
  expect(start, 'STATE_LABELS in web-frontend/src/lib/format.ts').toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  const body = source.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(\w+):\s*'((?:[^\\']|\\.)*)'/g)) out[m[1]!] = m[2]!;
  return out;
}

describe('valuation state labels', () => {
  it('covers every state, by type rather than by list', () => {
    // `Record<ValuationState, string>` is the real guard — a sixteenth state
    // will not compile until it is named here. This checks the census itself
    // still has a population.
    expect(Object.keys(VALUATION_STATE_LABELS).sort()).toEqual([...VALUATION_STATES].sort());
  });

  it('says the same thing as the browser', () => {
    const browser = browserLabels();
    expect(Object.keys(browser).length).toBe(VALUATION_STATES.length);
    for (const state of VALUATION_STATES) {
      expect(stateLabel(state), `label for ${state}`).toBe(browser[state]);
    }
  });

  it('never answers with the column value', () => {
    // The property that made the old messages unreadable: the label was the key.
    const identical = VALUATION_STATES.filter((s: ValuationState) => stateLabel(s) === s);
    expect(identical, 'states labelled with their own column value').toEqual([]);
  });
});

describe('the refusals that used to name the column', () => {
  const SERVICE = path.resolve(HERE, '../..');
  const FILES = ['src/domain/transitionGuard.ts', 'src/routes/workflow.ts', 'src/routes/reviews.ts'].map(
    (rel) => ({ rel, text: readFileSync(path.join(SERVICE, rel), 'utf8') }),
  );

  it('interpolates no bare state into a problem detail', () => {
    /*
     * Keyed on the interpolation rather than on the eight strings that happened
     * to be wrong, because the failure mode is the ninth. `${valuation.state}`,
     * `${from}`, `${to}`, `${live}` — any of them inside a `problems.…()`
     * argument is the column value on its way to a reader.
     */
    const findings: string[] = [];
    for (const { rel, text } of FILES) {
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of stripped.matchAll(/problems\.\w+\(([\s\S]*?)\n\s*\);/g)) {
        for (const bare of m[1]!.matchAll(/\$\{\s*(?!stateLabel)([\w.]*\b(?:state|from|to|live)\b)\s*\}/g)) {
          findings.push(`${rel} → \${${bare[1]!}}`);
        }
      }
    }
    expect(findings, 'refusals naming a lifecycle state by its column value').toEqual([]);
  });

  it('has something to look at', () => {
    expect(FILES.every(({ text }) => text.includes('stateLabel('))).toBe(true);
  });
});
