import { describe, expect, it } from 'vitest';
import { selectValuationKinds } from '../../src/domain/valuationSelector.js';

describe('selectValuationKinds', () => {
  it('recommends a 409A (with 718 as the follow-on) for US option grants', () => {
    const result = selectValuationKinds({ purpose: 'issue_options', jurisdiction: 'us' });
    expect(result.primary?.kind).toBe('409a');
    expect(result.recommendations.map((r) => r.kind)).toContain('718');
    expect(result.primary?.reasons.join(' ')).toMatch(/409A/);
  });

  it('splits the UK grant path on the EMI employee limit', () => {
    const small = selectValuationKinds({
      purpose: 'issue_options',
      jurisdiction: 'uk',
      employee_count: 40,
    });
    expect(small.primary?.kind).toBe('emi');

    const large = selectValuationKinds({
      purpose: 'issue_options',
      jurisdiction: 'uk',
      employee_count: 900,
    });
    expect(large.primary?.kind).toBe('csop');
  });

  it('routes financial reporting by accounting standard', () => {
    expect(
      selectValuationKinds({ purpose: 'financial_reporting', accounting_standard: 'ifrs' }).primary?.kind,
    ).toBe('ifrs2');
    expect(
      selectValuationKinds({ purpose: 'financial_reporting', accounting_standard: 'us_gaap' }).primary?.kind,
    ).toBe('718');
    expect(
      selectValuationKinds({ purpose: 'financial_reporting', subject: 'fund_positions' }).primary?.kind,
    ).toBe('820');
  });

  it('recognises event triggers: acquisition, impairment, transfer, QSBS, ESOP', () => {
    expect(selectValuationKinds({ trigger: 'closing_acquisition' }).primary?.kind).toBe('ppa');
    expect(selectValuationKinds({ trigger: 'impairment_indicator' }).primary?.kind).toBe('goodwill');
    expect(selectValuationKinds({ trigger: 'gift_or_estate_transfer' }).primary?.kind).toBe('gifts');
    expect(selectValuationKinds({ trigger: 'qsbs_exit_or_diligence' }).primary?.kind).toBe('qsbs');
    expect(selectValuationKinds({ has_esop: true }).primary?.kind).toBe('esop');
  });

  it('covers the subject-led paths: SMB sale, IP, debt', () => {
    expect(selectValuationKinds({ purpose: 'sale_or_loan', subject: 'small_business' }).primary?.kind).toBe(
      'fmv',
    );
    expect(selectValuationKinds({ subject: 'intangible_asset' }).primary?.kind).toBe('ip');
    expect(selectValuationKinds({ subject: 'debt_instrument' }).primary?.kind).toBe('debt');
  });

  it('returns nothing rather than guessing when the answers say nothing', () => {
    const result = selectValuationKinds({});
    expect(result.recommendations).toEqual([]);
    expect(result.primary).toBeNull();
  });

  it('caps the list at five, deduplicates reasons, and keeps every reason non-empty', () => {
    const result = selectValuationKinds({
      purpose: 'acquisition',
      trigger: 'closing_acquisition',
      subject: 'small_business',
      has_esop: true,
      grants_options: true,
    });
    expect(result.recommendations.length).toBeLessThanOrEqual(5);
    for (const rec of result.recommendations) {
      expect(rec.reasons.length).toBeGreaterThan(0);
      expect(new Set(rec.reasons).size).toBe(rec.reasons.length);
      expect(rec.label).toBeTruthy();
    }
    // The doubled acquisition signal must not double the reason text.
    const ppa = result.recommendations.find((r) => r.kind === 'ppa')!;
    expect(ppa.reasons).toHaveLength(1);
  });
});
