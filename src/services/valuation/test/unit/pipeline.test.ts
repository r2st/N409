import { describe, expect, it } from 'vitest';
import { validateWeights } from '../../src/routes/params.js';
import { deepMerge } from '../../src/routes/calculations.js';
import { safeFilename } from '../../src/routes/documents.js';

describe('validateWeights', () => {
  const empty = { weight_asset: null, weight_opm: null, weight_income: null, weight_market: null };

  it('accepts an all-null weight set', () => {
    expect(validateWeights(empty, {}).ok).toBe(true);
  });

  it('accepts a complete set summing to exactly 1', () => {
    expect(
      validateWeights(empty, { weight_asset: 0, weight_opm: 0.6, weight_income: 0.15, weight_market: 0.25 }).ok,
    ).toBe(true);
  });

  it('accepts float-noisy sums that are exact in basis points', () => {
    // 0.1 + 0.2 + 0.3 + 0.4 !== 1 in IEEE754 addition order dependent cases
    expect(
      validateWeights(empty, { weight_asset: 0.1, weight_opm: 0.2, weight_income: 0.3, weight_market: 0.4 }).ok,
    ).toBe(true);
  });

  it('rejects a partial set', () => {
    const res = validateWeights(empty, { weight_opm: 1 });
    expect(res.ok).toBe(false);
  });

  it('rejects sums off by one basis point', () => {
    const res = validateWeights(empty, {
      weight_asset: 0.2501,
      weight_opm: 0.25,
      weight_income: 0.25,
      weight_market: 0.25,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toContain('1.0001');
  });

  it('merges against current DB values (numeric strings)', () => {
    const current = { weight_asset: '0.25', weight_opm: '0.25', weight_income: '0.25', weight_market: '0.25' };
    expect(validateWeights(current, { weight_market: 0.3 }).ok).toBe(false);
    expect(validateWeights(current, { weight_market: 0.25 }).ok).toBe(true);
  });

  it('allows clearing all four', () => {
    const current = { weight_asset: '0.25', weight_opm: '0.25', weight_income: '0.25', weight_market: '0.25' };
    expect(
      validateWeights(current, {
        weight_asset: null,
        weight_opm: null,
        weight_income: null,
        weight_market: null,
      }).ok,
    ).toBe(true);
  });
});

describe('deepMerge', () => {
  it('merges nested objects, later wins', () => {
    expect(
      deepMerge({ a: 1, m: { x: 1, y: 2 } }, { m: { y: 3, z: 4 }, b: 2 }),
    ).toEqual({ a: 1, b: 2, m: { x: 1, y: 3, z: 4 } });
  });

  it('replaces arrays and scalars wholesale', () => {
    expect(deepMerge({ arr: [1, 2] }, { arr: [3] })).toEqual({ arr: [3] });
    expect(deepMerge({ v: { nested: true } }, { v: 5 })).toEqual({ v: 5 });
  });
});

describe('safeFilename', () => {
  it('keeps ordinary names', () => {
    expect(safeFilename('cap-table.v2.csv')).toBe('cap-table.v2.csv');
  });

  it('strips directories and separators', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a\\b:c.pdf')).toBe('a_b_c.pdf');
  });

  it('never returns an empty name', () => {
    expect(safeFilename('///')).toBe('upload');
  });
});
