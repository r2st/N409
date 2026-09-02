/**
 * `rowByColumn` takes the descriptor path for one column name, not all of them
 * (R377, performance).
 *
 * The `defineProperty` call is there because a column headed `__proto__` is
 * dropped by a plain store — that behaviour is pinned in
 * `capTableAdversarialImport.test.ts` and is not what these tests are about.
 * What they are about is that it was being made for *every* column, at six and
 * a half times the cost of a store (247 ms against 38 for 200,000 ten-column
 * rows) and leaving the row in a shape that is also slower to read afterwards —
 * and every cell of every imported sheet is read at least once after this.
 *
 * The rows this builds are identical either way, so the assertions are about
 * the work and about the two branches producing the same object.
 */
import { describe, expect, it, vi } from 'vitest';
import { rowByColumn } from '../../src/domain/sheetColumns.js';

/**
 * The names `Object.defineProperty` was called with on a plain object.
 *
 * Filtered rather than counted raw: installing the spy defines `mock` on the
 * spy function itself, so a bare `toHaveBeenCalledTimes` would be counting
 * vitest's own bookkeeping alongside the calls under test.
 */
function definedNames(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .filter((call) => typeof call[0] === 'object' && call[0] !== null)
    .map((call) => String(call[1]));
}

describe('rowByColumn', () => {
  it('makes no descriptor call for a sheet with ordinary headers', () => {
    const spy = vi.spyOn(Object, 'defineProperty');
    try {
      rowByColumn(['class', 'shares', 'price'], ['Common', '100', '1.25']);
      expect(definedNames(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('makes exactly one for a sheet that carries the name that needs it', () => {
    const spy = vi.spyOn(Object, 'defineProperty');
    try {
      rowByColumn(['class', '__proto__', 'price'], ['Common', 'kept', '1.25']);
      expect(definedNames(spy)).toEqual(['__proto__']);
    } finally {
      spy.mockRestore();
    }
  });

  it('gives both branches the same descriptor, so the row cannot drift', () => {
    // The store branch is only correct because a plain assignment produces
    // exactly what the `defineProperty` call spells out. If either side is
    // edited without the other, a row would carry two kinds of property.
    const row = rowByColumn(['class', '__proto__'], ['Common', 'kept']);
    const stored = Object.getOwnPropertyDescriptor(row, 'class');
    const defined = Object.getOwnPropertyDescriptor(row, '__proto__');
    expect(defined).toEqual({ ...stored, value: 'kept' });
    expect(stored).toEqual({ value: 'Common', writable: true, enumerable: true, configurable: true });
  });

  it('still trims, skips unnamed columns and pads a short row', () => {
    const row = rowByColumn(['class', null, 'price', 'note'], ['  Common  ', 'x', ' 1.25 ']);
    expect(row).toEqual({ class: 'Common', price: '1.25', note: '' });
    expect(Object.keys(row)).toEqual(['class', 'price', 'note']);
  });

  it('the spy sees the shape this replaced', () => {
    // Without this the first two assertions would pass over a broken spy.
    const spy = vi.spyOn(Object, 'defineProperty');
    try {
      const obj = {};
      for (const name of ['a', 'b', 'c']) {
        Object.defineProperty(obj, name, { value: '1', writable: true, enumerable: true, configurable: true });
      }
      expect(definedNames(spy)).toEqual(['a', 'b', 'c']);
    } finally {
      spy.mockRestore();
    }
  });
});
