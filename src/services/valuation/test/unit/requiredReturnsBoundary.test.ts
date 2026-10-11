import { describe, expect, it } from 'vitest';
import {
  requiredReturnBands,
  requiredReturnRows,
  RequiredReturnTableError,
  REQUIRED_RETURN_BANDS,
} from '../../src/domain/requiredReturns.js';

describe('requiredReturnBands boundary inputs', () => {
  it('returns the built-in ladder for null', () => {
    expect(requiredReturnBands(null)).toBe(REQUIRED_RETURN_BANDS);
  });

  it('returns the built-in ladder for undefined', () => {
    expect(requiredReturnBands(undefined)).toBe(REQUIRED_RETURN_BANDS);
  });

  it('rejects a non-array override', () => {
    expect(() => requiredReturnBands('not an array')).toThrow(RequiredReturnTableError);
    expect(() => requiredReturnBands(42)).toThrow(RequiredReturnTableError);
    expect(() => requiredReturnBands({})).toThrow(RequiredReturnTableError);
  });

  it('rejects an empty array', () => {
    expect(() => requiredReturnBands([])).toThrow(RequiredReturnTableError);
  });

  it('rejects a non-object entry', () => {
    expect(() => requiredReturnBands(['not an object'])).toThrow(RequiredReturnTableError);
    expect(() => requiredReturnBands([null])).toThrow(RequiredReturnTableError);
  });

  it('rejects an invalid stage', () => {
    expect(() =>
      requiredReturnBands([{ stage: 99, category: 'Test', low: 0.3, high: 0.5 }]),
    ).toThrow(RequiredReturnTableError);
    expect(() =>
      requiredReturnBands([{ stage: 0, category: 'Test', low: 0.3, high: 0.5 }]),
    ).toThrow(RequiredReturnTableError);
  });

  it('accepts valid stages 1-6', () => {
    for (let stage = 1; stage <= 6; stage++) {
      expect(
        requiredReturnBands([{ stage, category: `Stage ${stage}`, low: 0.2, high: 0.4 }]),
      ).toHaveLength(1);
    }
  });

  it('rejects empty or non-string category', () => {
    expect(() =>
      requiredReturnBands([{ stage: 1, category: '', low: 0.3, high: 0.5 }]),
    ).toThrow(RequiredReturnTableError);
    expect(() =>
      requiredReturnBands([{ stage: 1, category: '   ', low: 0.3, high: 0.5 }]),
    ).toThrow(RequiredReturnTableError);
    expect(() =>
      requiredReturnBands([{ stage: 1, category: 42, low: 0.3, high: 0.5 }]),
    ).toThrow(RequiredReturnTableError);
  });

  it('rejects low/high at boundary 0', () => {
    expect(() =>
      requiredReturnBands([{ stage: 1, category: 'Test', low: 0, high: 0.5 }]),
    ).toThrow(RequiredReturnTableError);
  });

  it('rejects low/high at boundary 5', () => {
    expect(() =>
      requiredReturnBands([{ stage: 1, category: 'Test', low: 0.3, high: 5 }]),
    ).toThrow(RequiredReturnTableError);
  });

  it('accepts low/high just inside (0, 5)', () => {
    const bands = requiredReturnBands([{ stage: 1, category: 'Test', low: 0.001, high: 4.999 }]);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.low).toBe(0.001);
    expect(bands[0]!.high).toBe(4.999);
  });

  it('rejects low > high', () => {
    expect(() =>
      requiredReturnBands([{ stage: 1, category: 'Test', low: 0.6, high: 0.3 }]),
    ).toThrow(RequiredReturnTableError);
  });

  it('accepts low === high', () => {
    const bands = requiredReturnBands([{ stage: 1, category: 'Test', low: 0.5, high: 0.5 }]);
    expect(bands[0]!.low).toBe(0.5);
    expect(bands[0]!.high).toBe(0.5);
  });

  it('rejects NaN values', () => {
    expect(() =>
      requiredReturnBands([{ stage: 1, category: 'Test', low: NaN, high: 0.5 }]),
    ).toThrow(RequiredReturnTableError);
  });

  it('rejects Infinity values', () => {
    expect(() =>
      requiredReturnBands([{ stage: 1, category: 'Test', low: 0.3, high: Infinity }]),
    ).toThrow(RequiredReturnTableError);
  });

  it('rejects negative values', () => {
    expect(() =>
      requiredReturnBands([{ stage: 1, category: 'Test', low: -0.1, high: 0.5 }]),
    ).toThrow(RequiredReturnTableError);
  });
});

describe('requiredReturnRows boundary inputs', () => {
  it('returns all bands when stage is null', () => {
    const rows = requiredReturnRows(null);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.matched === false)).toBe(true);
  });

  it('returns all bands when stage is undefined', () => {
    const rows = requiredReturnRows(undefined);
    expect(rows).toHaveLength(6);
  });

  it('marks the correct stage', () => {
    const rows = requiredReturnRows(3);
    const matched = rows.filter((r) => r.matched);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.stage).toBe(3);
  });

  it('marks nothing when stage is out of range', () => {
    const rows = requiredReturnRows(99);
    expect(rows.every((r) => r.matched === false)).toBe(true);
  });

  it('returns rows sorted by stage', () => {
    const rows = requiredReturnRows(1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.stage).toBeGreaterThan(rows[i - 1]!.stage);
    }
  });

  it('includes a label for each row', () => {
    const rows = requiredReturnRows(1);
    for (const row of rows) {
      expect(typeof row.label).toBe('string');
      expect(row.label.length).toBeGreaterThan(0);
    }
  });
});

describe('built-in REQUIRED_RETURN_BANDS invariants', () => {
  it('covers all 6 stages', () => {
    const stages = REQUIRED_RETURN_BANDS.map((b) => b.stage);
    expect(stages).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('has monotonically falling returns', () => {
    for (let i = 1; i < REQUIRED_RETURN_BANDS.length; i++) {
      expect(REQUIRED_RETURN_BANDS[i]!.high).toBeLessThanOrEqual(REQUIRED_RETURN_BANDS[i - 1]!.high);
      expect(REQUIRED_RETURN_BANDS[i]!.low).toBeLessThanOrEqual(REQUIRED_RETURN_BANDS[i - 1]!.low);
    }
  });

  it('has low < high on every band', () => {
    for (const band of REQUIRED_RETURN_BANDS) {
      expect(band.low).toBeLessThan(band.high);
    }
  });

  it('has all values inside (0, 5)', () => {
    for (const band of REQUIRED_RETURN_BANDS) {
      expect(band.low).toBeGreaterThan(0);
      expect(band.high).toBeLessThan(5);
    }
  });
});
