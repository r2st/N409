import { describe, expect, it } from 'vitest';
import { checkParamInvariants, ParamsPatchBody } from '../../src/routes/params.js';

/**
 * The DLOC derivation, held to what the engine will actually run (R413, M6).
 *
 * `dloc_method` picks a branch of `engine/dloc.py concluded_dloc`, and each
 * branch has an input it refuses to run without. Those refusals used to arrive
 * at Calculate rather than at Save: the PATCH returned 200, the engagement
 * looked configured, and the 422 landed on whoever next pressed the button —
 * `StatedDiscount`'s own argument, one branch further in.
 *
 * The row shape here is the merged one `checkParamInvariants` is given: the
 * stored row plus the patch about to land on it, which is why a method set in
 * one request and a figure set in the next is still checked as a pair.
 */

/** A stored params row with nothing configured. */
const EMPTY: Record<string, unknown> = {
  // All four null is the "no weights stated" arm of `validateWeights`, which
  // runs before the DLOC rules and would otherwise answer for them.
  weight_asset: null,
  weight_opm: null,
  weight_income: null,
  weight_market: null,
  dloc: null,
  dloc_method: null,
  control_premium: null,
  dlom_method: null,
  dlom_qualitative: null,
};

const check = (current: Record<string, unknown>, patch: Record<string, unknown>) =>
  checkParamInvariants({ ...EMPTY, ...current }, ParamsPatchBody.parse(patch));

describe('qualitative DLOC', () => {
  it('needs its figure', () => {
    const result = check({}, { dloc_method: 'qualitative' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toMatch(/dloc is required/);
  });

  it('takes the figure from the stored row when the patch only sets the method', () => {
    expect(check({ dloc: '0.2' }, { dloc_method: 'qualitative' }).ok).toBe(true);
  });

  it('takes the method from the stored row when the patch only sets the figure', () => {
    expect(check({ dloc_method: 'qualitative' }, { dloc: 0.2 }).ok).toBe(true);
  });

  /**
   * `_MAX_DLOC` in engine/dloc.py. The pre-flight bounds `dloc` at [0, 1) and
   * only *warns* past 0.35, so 0.96 passed every check the platform made and
   * died inside the allocation with a message naming the engine's constant.
   */
  it('refuses a stated discount the engine will not apply', () => {
    const result = check({}, { dloc_method: 'qualitative', dloc: 0.96 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toMatch(/at most 0\.95/);
  });

  it('accepts the ceiling itself', () => {
    expect(check({}, { dloc_method: 'qualitative', dloc: 0.95 }).ok).toBe(true);
  });

  it('reads a numeric column that arrived from pg as a string', () => {
    expect(check({ dloc: '0.96' }, { dloc_method: 'qualitative' }).ok).toBe(false);
    expect(check({ dloc: '0.95' }, { dloc_method: 'qualitative' }).ok).toBe(true);
  });

  /**
   * The ceiling is a bound on one *derivation*, not on the field: with no
   * method set the engine applies `dloc` through an unbounded `_num`, and a
   * figure the platform has already run and printed must stay recordable.
   */
  it('does not bound a stated DLOC with no method behind it', () => {
    expect(check({}, { dloc: 0.96 }).ok).toBe(true);
    expect(check({}, { dloc_method: null, dloc: 0.99 }).ok).toBe(true);
  });

  it('does not bound the studies or control-premium derivations by it', () => {
    expect(check({ dloc: '0.96' }, { dloc_method: 'studies' }).ok).toBe(true);
    expect(check({ dloc: '0.96' }, { dloc_method: 'control_premium', control_premium: 1.5 }).ok).toBe(true);
  });
});

describe('control-premium DLOC', () => {
  it('needs the premium it inverts', () => {
    const result = check({}, { dloc_method: 'control_premium' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toMatch(/control_premium is required/);
  });

  it('is satisfied by a premium already on the row', () => {
    expect(check({ control_premium: '0.25' }, { dloc_method: 'control_premium' }).ok).toBe(true);
  });

  it('accepts a premium over 100%, which the params route argues are observed', () => {
    expect(check({}, { dloc_method: 'control_premium', control_premium: 1.5 }).ok).toBe(true);
  });
});

describe('the band both DLOC doors publish', () => {
  // R413: the registry published 0…0.9 for this cell while the params screen
  // took 0…0.9999. They are one number now; the qualitative ceiling above is a
  // separate, narrower rule about one derivation.
  it('accepts a stated discount the Overwrites tab used to refuse', () => {
    expect(ParamsPatchBody.safeParse({ dloc: 0.95 }).success).toBe(true);
    expect(ParamsPatchBody.safeParse({ dloc: 0.9999 }).success).toBe(true);
    expect(ParamsPatchBody.safeParse({ dloc: 1 }).success).toBe(false);
  });
});
