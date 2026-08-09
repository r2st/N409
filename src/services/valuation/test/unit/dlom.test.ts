import { describe, expect, it } from 'vitest';
import {
  isModelDlomMethod,
  modelDlomMethodsIn,
  MODEL_DLOM_METHODS,
  selectsModelDlom,
} from '../../src/domain/dlom.js';

/**
 * Which marketability discounts need a volatility.
 *
 * Both callers — the health checks and the QA gate — used to spell this inline
 * as `method === 'chaffee' || method === 'finnerty'`, and both were already
 * wrong by two methods: Ghaidarov and Longstaff are equally volatility-derived,
 * so a run selecting one with no volatility got no warning that its discount
 * would come back as zero.
 *
 * A weighted blend (migration 0129) would have slipped past in the same way and
 * for the worse reason. A single-method run with no volatility produces a zero
 * discount, which somebody notices; a blend's model leg contributes silently
 * nothing, so the concluded figure is a plausible-looking number that is simply
 * too low.
 */

describe('isModelDlomMethod', () => {
  it.each([...MODEL_DLOM_METHODS])('%s is volatility-derived', (method) => {
    expect(isModelDlomMethod(method)).toBe(true);
  });

  it.each(['restricted_stock', 'qualitative', 'weighted'])('%s is not', (method) => {
    // `restricted_stock` is a lookup and `qualitative` is the analyst's own
    // figure — neither has any use for a volatility. `weighted` is the label the
    // engine records on a blend's *result*, not a method that can be selected.
    expect(isModelDlomMethod(method)).toBe(false);
  });

  it.each([null, undefined, 42, {}, ['finnerty']])('rejects the non-string %s', (value) => {
    expect(isModelDlomMethod(value)).toBe(false);
  });
});

describe('selectsModelDlom', () => {
  it('sees a single model method', () => {
    expect(selectsModelDlom({ dlom_method: 'ghaidarov' })).toBe(true);
  });

  it('sees a model method reached through a blend', () => {
    expect(
      selectsModelDlom({
        dlom_methods: [
          { method: 'restricted_stock', weight: 0.5 },
          { method: 'finnerty', weight: 0.5 },
        ],
      }),
    ).toBe(true);
  });

  it('is false for a blend of methods that need no volatility', () => {
    expect(
      selectsModelDlom({
        dlom_methods: [
          { method: 'restricted_stock', weight: 0.6 },
          { method: 'qualitative', weight: 0.4 },
        ],
      }),
    ).toBe(false);
  });

  it('is false when nothing is selected at all', () => {
    expect(selectsModelDlom({})).toBe(false);
    expect(selectsModelDlom({ dlom_method: null, dlom_methods: null })).toBe(false);
  });

  it('treats a malformed blend as selecting nothing rather than throwing', () => {
    // The params route, the engine pre-flight and the engine each reject a
    // malformed leg with a message about the leg. This predicate's job is only
    // to answer the volatility question, and it must not be the thing that
    // crashes on a shape somebody else is about to explain.
    for (const blend of [
      'finnerty',
      [{ weight: 0.5 }],
      [null, undefined],
      [{ method: 42, weight: 0.5 }],
      [],
    ]) {
      expect(selectsModelDlom({ dlom_methods: blend })).toBe(false);
    }
  });
});

describe('modelDlomMethodsIn', () => {
  it('names every model method a blend rests on, once each', () => {
    expect(
      modelDlomMethodsIn({
        dlom_methods: [
          { method: 'finnerty', weight: 0.4 },
          { method: 'chaffee', weight: 0.3 },
          { method: 'restricted_stock', weight: 0.3 },
        ],
      }),
    ).toEqual(['finnerty', 'chaffee']);
  });

  it('is empty when no model method was selected', () => {
    expect(modelDlomMethodsIn({ dlom_method: 'qualitative' })).toEqual([]);
  });

  it('does not repeat a method named by both forms', () => {
    // Not a legal state — the route, the engine and a table constraint each
    // refuse it — but this is the function that builds a user-facing message,
    // and "finnerty / finnerty DLOM needs a volatility" would be its own bug.
    expect(
      modelDlomMethodsIn({
        dlom_method: 'finnerty',
        dlom_methods: [
          { method: 'finnerty', weight: 0.5 },
          { method: 'qualitative', weight: 0.5 },
        ],
      }),
    ).toEqual(['finnerty']);
  });
});
