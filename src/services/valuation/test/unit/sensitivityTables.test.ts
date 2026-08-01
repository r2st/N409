import { describe, expect, it } from 'vitest';
import { opmFmvPerShareCents, sensitivityTables, type OpmInputs } from '../../src/domain/sensitivity.js';

const BASE: OpmInputs = {
  equityValueCents: 2_000_000_000, // $20M
  strikeCents: 500_000_000, // $5M preference
  volatility: 0.6,
  termYears: 3,
  riskFreeRate: 0.04,
  commonShares: 8_000_000,
  dlom: 0.3,
};

describe('three-table sensitivity dashboard (remaining-gaps §2)', () => {
  it('produces Term×Vol, RFR×Vol and RFR×Term tables with default 5×5 shape', () => {
    const { base, tables } = sensitivityTables(BASE);
    expect(base.fmvPerShareCents).toBe(Math.round(opmFmvPerShareCents(BASE)));
    expect(base.riskFreeRate).toBe(0.04);

    expect(tables.term_vol.rowAxis).toBe('termYears');
    expect(tables.term_vol.colAxis).toBe('volatility');
    expect(tables.rfr_vol.rowAxis).toBe('riskFreeRate');
    expect(tables.rfr_term.colAxis).toBe('termYears');

    for (const table of Object.values(tables)) {
      expect(table.rowValues).toHaveLength(5);
      expect(table.colValues).toHaveLength(5);
      expect(table.rows).toHaveLength(5);
      expect(table.rows[0]).toHaveLength(5);
    }
    // Default RFR steps: ±2%, ±1%, 0 around the base rate.
    expect(tables.rfr_vol.rowValues).toEqual([0.02, 0.03, 0.04, 0.05, 0.06]);
  });

  it('center cell of every table is the base case with zero delta', () => {
    const { base, tables } = sensitivityTables(BASE);
    for (const table of Object.values(tables)) {
      const center = table.rows[2]![2]!;
      expect(center.fmvPerShareCents).toBe(base.fmvPerShareCents);
      expect(center.deltaFromBase).toBe(0);
    }
  });

  it('cells match a direct OPM computation on their axis values', () => {
    const { tables } = sensitivityTables(BASE);
    const t = tables.rfr_term;
    const cell = t.rows[0]![4]!; // lowest rfr × longest term
    const expected = opmFmvPerShareCents({
      ...BASE,
      riskFreeRate: t.rowValues[0]!,
      termYears: t.colValues[4]!,
    });
    expect(cell.fmvPerShareCents).toBe(Math.round(expected));
  });

  it('a higher risk-free rate raises the OPM call value (positive rho)', () => {
    const { tables } = sensitivityTables(BASE);
    const col = 2; // base volatility column
    const values = tables.rfr_vol.rows.map((row) => row[col]!.fmvPerShareCents);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
  });

  it('clamps the rfr axis at zero and honors custom steps', () => {
    const { tables } = sensitivityTables(BASE, { rfrSteps: [-0.1, 0, 0.01] });
    expect(tables.rfr_vol.rowValues).toEqual([0, 0.04, 0.05]);
  });
});
