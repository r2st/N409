import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VALUATION_STATES, type ValuationState } from '../../src/domain/valuation.js';
import { AUTO_ADVANCE, canRestart } from '../../src/domain/workflow.js';

/**
 * The browser's copy of the lifecycle's forward edge.
 *
 * `WorkflowActions.tsx` does not merely render a button — it *names the state
 * the server is about to move to*: "Advance → Drafted". Its own comment says
 * why that matters ("promising 'review' and landing on 'paid' is how ops stop
 * trusting the control"), and to do it the component carries a second copy of
 * `AUTO_ADVANCE` and a second copy of the restart rule. web-frontend has no
 * `@n409/shared` dependency, so the duplication is by construction; what was
 * missing is anything comparing the two.
 *
 * A copy nothing compares is a copy that drifts, and this one drifts *quietly*:
 * a wrong entry does not throw, it puts a confident wrong destination on a
 * button that then performs the right transition. The reader is told the file
 * went somewhere it did not, and the disagreement surfaces later as a state
 * nobody can account for. `valuationStateLabels` pins the words; this pins the
 * edges the words are attached to.
 *
 * The two non-state buckets of the browser's `next` — the `paid` divert — are
 * checked as the rule rather than as a table, because that is how both sides
 * express it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENT = path.resolve(HERE, '../../../web-frontend/src/components/WorkflowActions.tsx');

function source(): string {
  return readFileSync(COMPONENT, 'utf8');
}

/** The browser's `AUTO_ADVANCE` object literal, read as text. */
function browserAdvance(): Record<string, string> {
  const src = source();
  const start = src.indexOf('const AUTO_ADVANCE');
  expect(start, 'AUTO_ADVANCE in web-frontend/src/components/WorkflowActions.tsx').toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  const close = src.indexOf('};', open);
  const out: Record<string, string> = {};
  for (const m of src.slice(open + 1, close).matchAll(/(\w+):\s*'([\w]+)'/g)) out[m[1]!] = m[2]!;
  return out;
}

describe('WorkflowActions mirrors the server lifecycle', () => {
  it('names the same next state for every state that has one', () => {
    const browser = browserAdvance();
    // Not just "every browser entry is right" — every *server* entry has to be
    // present, or a state quietly loses its button and reads as an end.
    expect(Object.keys(browser).sort()).toEqual(Object.keys(AUTO_ADVANCE).sort());
    for (const [from, to] of Object.entries(AUTO_ADVANCE)) {
      expect(browser[from], `next state after ${from}`).toBe(to);
    }
  });

  it('only names states that exist', () => {
    const known = new Set<string>(VALUATION_STATES);
    for (const [from, to] of Object.entries(browserAdvance())) {
      expect(known.has(from), `${from} is not a state`).toBe(true);
      expect(known.has(to), `${from} → ${to} names a state that does not exist`).toBe(true);
    }
  });

  it('refuses a restart from exactly the states the server refuses it from', () => {
    // The browser writes the rule out as two comparisons rather than as a
    // table. Reading the states it names back out of source is what keeps a
    // third forbidden state from being added on one side only — the button
    // would stay enabled and the server would answer 409.
    const src = source();
    const start = src.indexOf('const canRestart');
    expect(start, 'canRestart in WorkflowActions.tsx').toBeGreaterThan(-1);
    const expr = src.slice(start, src.indexOf('\n', src.indexOf(';', start)));
    const named = new Set([...expr.matchAll(/state !== '(\w+)'/g)].map((m) => m[1]!));
    const refused = VALUATION_STATES.filter((s: ValuationState) => !canRestart(s));
    expect([...named].sort()).toEqual([...refused].sort());
  });
});
