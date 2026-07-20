import { describe, expect, it } from 'vitest';
import {
  evaluateTriggers,
  overallStatus,
  type MonitorSnapshot,
} from '../../src/domain/monitoring.js';

const baseline: MonitorSnapshot = {
  valuation_date: '2026-01-01',
  fmv_per_share: 1.5,
  annual_revenue: 1_000_000,
  fully_diluted_shares: 10_000_000,
  last_round_date: '2025-06-01',
};

// Same as baseline unless overridden.
const same: MonitorSnapshot = { ...baseline, valuation_date: null };

describe('monitoring', () => {
  it('fires nothing when nothing has changed and within the window', () => {
    const triggers = evaluateTriggers(baseline, same, new Date('2026-03-01T00:00:00Z'));
    expect(triggers).toHaveLength(0);
    expect(overallStatus(triggers)).toBe('green');
  });

  describe('expiry', () => {
    it('warns at 10 months', () => {
      const t = evaluateTriggers(baseline, same, new Date('2026-11-01T00:00:00Z'));
      const e = t.find((x) => x.type === 'expiry');
      expect(e?.level).toBe('yellow');
    });
    it('is red past 12 months', () => {
      const t = evaluateTriggers(baseline, same, new Date('2027-02-01T00:00:00Z'));
      const e = t.find((x) => x.type === 'expiry');
      expect(e?.level).toBe('red');
      expect(overallStatus(t)).toBe('red');
    });
  });

  describe('revenue change', () => {
    it('is red past the 25% materiality threshold', () => {
      const t = evaluateTriggers(baseline, { ...same, annual_revenue: 1_300_000 }, new Date('2026-03-01T00:00:00Z'));
      const r = t.find((x) => x.type === 'revenue_change');
      expect(r?.level).toBe('red');
    });
    it('is yellow between 15% and 25%', () => {
      const t = evaluateTriggers(baseline, { ...same, annual_revenue: 1_200_000 }, new Date('2026-03-01T00:00:00Z'));
      const r = t.find((x) => x.type === 'revenue_change');
      expect(r?.level).toBe('yellow');
    });
    it('ignores small moves', () => {
      const t = evaluateTriggers(baseline, { ...same, annual_revenue: 1_050_000 }, new Date('2026-03-01T00:00:00Z'));
      expect(t.find((x) => x.type === 'revenue_change')).toBeUndefined();
    });
  });

  describe('funding round', () => {
    it('fires red on a newer round date', () => {
      const t = evaluateTriggers(baseline, { ...same, last_round_date: '2026-02-15' }, new Date('2026-03-01T00:00:00Z'));
      const f = t.find((x) => x.type === 'funding_round');
      expect(f?.level).toBe('red');
    });
    it('does not fire on the same round', () => {
      const t = evaluateTriggers(baseline, { ...same, last_round_date: '2025-06-01' }, new Date('2026-03-01T00:00:00Z'));
      expect(t.find((x) => x.type === 'funding_round')).toBeUndefined();
    });
  });

  describe('cap table change', () => {
    it('is red on a large share change', () => {
      const t = evaluateTriggers(baseline, { ...same, fully_diluted_shares: 12_000_000 }, new Date('2026-03-01T00:00:00Z'));
      const c = t.find((x) => x.type === 'cap_table_change');
      expect(c?.level).toBe('red');
    });
    it('is yellow on a small share change', () => {
      const t = evaluateTriggers(baseline, { ...same, fully_diluted_shares: 10_200_000 }, new Date('2026-03-01T00:00:00Z'));
      const c = t.find((x) => x.type === 'cap_table_change');
      expect(c?.level).toBe('yellow');
    });
  });

  it('signatures are stable for dedupe', () => {
    const now = new Date('2027-02-01T00:00:00Z');
    const a = evaluateTriggers(baseline, same, now);
    const b = evaluateTriggers(baseline, same, now);
    expect(a.map((t) => t.signature)).toEqual(b.map((t) => t.signature));
  });
});
