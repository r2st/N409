import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../support/sourceFiles.js';

/**
 * Which run a surface reads, and why that is a question about *shape*.
 *
 * One valuation's `calculations` rows come in two shapes. The 409A pipeline
 * writes `results = { approaches, discounts, assumptions, … }`; a specialty
 * engine writes `results = { kind, specialty }` (`routes/specialty.ts`). The
 * Calculations tab offers the ordinary compute on every kind, so on a specialty
 * engagement the two interleave in one `created_at DESC` ordering and the
 * newest row is whichever button was pressed last.
 *
 * `latestSucceededCalculation` answers "the newest of any shape", which is the
 * right question for a surface that only needs the run's *identity* — has QA
 * graded the latest one, has anything succeeded at all — and the wrong question
 * for every surface that goes on to read a shape-specific key or to print the
 * headline columns under a caption fixed by the engagement's kind. Reading the
 * wrong shape does not fail: the key is simply absent, and the surface reports
 * the absence as a fact about the engagement. That is how a VAL231 pack came to
 * report the UMV and AMV HMRC is being asked to agree as *not supplied*, and how
 * an EMI deliverable came to carry a §409A allocation waterfall under its own
 * "Scheme Qualification" heading.
 *
 * Three repo helpers answer the shape question instead — `latestApproachBaseline`,
 * `latestSucceededSpecialtyCalculation` and `latestCalculationForKind`. This is
 * the register of the callers that deliberately did *not* move to one, so the
 * next author adding a caller has to say which of the two questions they are
 * asking rather than inheriting the default. A file dropping off the list is as
 * much a failure as one appearing on it: a stale register reads as a reviewed
 * one.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const REPO = path.resolve(HERE, '../..');

/**
 * Every caller of the any-shape reader, and the reason it is right there.
 *
 * `repos/calculations.ts` is excluded as the definition site. Everything else
 * under `src` that names the function is either on this list with a reason or
 * is an unreviewed caller.
 */
const ANY_SHAPE_CALLERS: Record<string, string> = {
  'src/domain/publishGate.ts':
    'Needs the run’s identity, not its contents: QA must have graded whatever ran last, of either shape.',
  'src/routes/qa.ts':
    'The same reading as the publish gate — a review is filed against a calculation id, and the banner must agree with the gate it describes.',
  'src/routes/healthChecks.ts':
    'As above for the health-check gate; `runHealthChecks` is itself kind-aware about what the columns mean.',
  'src/routes/ai.ts':
    'Only asks whether anything has been computed before an agent may narrate it; the payload is handed to the agent as-is.',
  'src/routes/monitoring.ts':
    'Snapshots whatever the engagement currently concludes; `assembleSnapshot` decides per kind whether that figure carries a §409A safe harbor (R143).',
  'src/routes/boardApproval.ts':
    'Reads the headline column deliberately and then refuses it unless the run concludes a §409A FMV (`concludes409AFmvPerShare`, R142).',
  'src/routes/grants.ts': 'Same column, same refusal, on the what-if exercise ladder (R143).',
  'src/routes/asc718.ts':
    'Same column, same refusal, on the option-expense underlying — and the refusal names the kind rather than asking for a calculation that already ran.',
  'src/routes/bridge.ts':
    'Refuses every specialty kind up front, so only 409A-family runs reach the read and there is no second shape on those.',
  'src/routes/compare.ts':
    'Asks both shapes and picks per pair, so the two sides are never compared in a vocabulary only one of them has.',
  'src/routes/scenarios.ts':
    'The sandbox itself takes `latestApproachBaseline`; this call is only how the refusal tells "nothing has run" apart from "a run of the wrong shape has" (R145).',
  'src/routes/rollforward.ts':
    'The prior engagement’s run is passed to the roll-forward engine whole; a payload it cannot read is refused there rather than silently reshaped here.',
};

const callers = sourceFiles(SRC)
  .filter((file) => /\blatestSucceededCalculation\s*\(/.test(readFileSync(file, 'utf8')))
  .map((file) => path.relative(REPO, file))
  .filter((file) => file !== 'src/repos/calculations.ts')
  .sort();

describe('the any-shape calculation reader', () => {
  it('has no caller that has not been asked which question it is asking', () => {
    expect(callers).toEqual(Object.keys(ANY_SHAPE_CALLERS).sort());
  });

  it('states a reason for every one of them', () => {
    // A blank entry is a file added to silence the census rather than reviewed.
    for (const [file, reason] of Object.entries(ANY_SHAPE_CALLERS)) {
      expect(reason.length, file).toBeGreaterThan(40);
    }
  });

  /*
   * The shape-aware helpers exist and are reachable — a register that pointed
   * at nothing would leave every caller above with no alternative to be
   * deliberately declining.
   */
  it('names helpers that answer the shape question instead', async () => {
    const repo = await import('../../src/repos/calculations.js');
    expect(typeof repo.latestApproachBaseline).toBe('function');
    expect(typeof repo.latestSucceededSpecialtyCalculation).toBe('function');
    expect(typeof repo.latestCalculationForKind).toBe('function');
  });
});
