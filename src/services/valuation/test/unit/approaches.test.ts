import { describe, expect, it } from 'vitest';
import {
  RECALC_APPROACHES,
  RECALC_APPROACH_KEYS,
  type RecalcApproach,
} from '../../src/domain/approaches.js';

describe('RECALC_APPROACHES', () => {
  it('has exactly four valuation approaches', () => {
    expect(RECALC_APPROACH_KEYS).toHaveLength(4);
    expect(RECALC_APPROACH_KEYS).toEqual(expect.arrayContaining(['asset', 'opm', 'income', 'market']));
  });

  it('every approach has an engineKey and a weightKey', () => {
    for (const key of RECALC_APPROACH_KEYS) {
      const entry = RECALC_APPROACHES[key];
      expect(entry.engineKey).toBeTruthy();
      expect(entry.weightKey).toMatch(/^weight_/);
    }
  });

  it('maps opm to opm_backsolve on the engine side', () => {
    expect(RECALC_APPROACHES.opm.engineKey).toBe('opm_backsolve');
  });

  it('maps each approach to a distinct weight key', () => {
    const weightKeys = RECALC_APPROACH_KEYS.map((k) => RECALC_APPROACHES[k].weightKey);
    expect(new Set(weightKeys).size).toBe(weightKeys.length);
  });

  it('maps each approach to a distinct engine key', () => {
    const engineKeys = RECALC_APPROACH_KEYS.map((k) => RECALC_APPROACHES[k].engineKey);
    expect(new Set(engineKeys).size).toBe(engineKeys.length);
  });

  it('RECALC_APPROACH_KEYS matches Object.keys of the map', () => {
    expect(RECALC_APPROACH_KEYS).toEqual(Object.keys(RECALC_APPROACHES));
  });
});
