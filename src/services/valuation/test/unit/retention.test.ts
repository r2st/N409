import { describe, it, expect } from 'vitest';
import { ageInDays, isDueForArchival, isFrozen, isPurgeEligible } from '../../src/domain/retention.js';

const NOW = new Date();
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('retention policy logic (feature 10)', () => {
  it('computes age in days', () => {
    expect(ageInDays(days(10), NOW)).toBe(10);
  });

  it('archives only when enabled and past the archive age', () => {
    const p = { data_type: 'valuation', archive_after_days: 30, retention_days: 60, enabled: true };
    expect(isDueForArchival(p, days(45), NOW)).toBe(true);
    expect(isDueForArchival(p, days(10), NOW)).toBe(false);
    expect(isDueForArchival({ ...p, enabled: false }, days(45), NOW)).toBe(false);
    expect(isDueForArchival({ ...p, archive_after_days: null }, days(999), NOW)).toBe(false);
  });

  it('flags purge eligibility past the retention window', () => {
    const p = { data_type: 'valuation', archive_after_days: 30, retention_days: 60, enabled: true };
    expect(isPurgeEligible(p, days(90), NOW)).toBe(true);
    expect(isPurgeEligible(p, days(45), NOW)).toBe(false);
  });

  it('freezes a valuation under a matching hold', () => {
    const target = { valuationId: 'v1', userId: 'u1' };
    expect(isFrozen([{ scope: 'global', reference_id: null, active: true }], target)).toBe(true);
    expect(isFrozen([{ scope: 'valuation', reference_id: 'v1', active: true }], target)).toBe(true);
    expect(isFrozen([{ scope: 'user', reference_id: 'u1', active: true }], target)).toBe(true);
    expect(isFrozen([{ scope: 'valuation', reference_id: 'other', active: true }], target)).toBe(false);
    expect(isFrozen([{ scope: 'global', reference_id: null, active: false }], target)).toBe(false);
  });
});
