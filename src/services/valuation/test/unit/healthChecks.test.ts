import { describe, expect, it } from 'vitest';
import {
  runHealthChecks,
  worstSeverity,
  type HealthCategory,
} from '../../src/domain/healthChecks.js';

/** A clean, fully-populated valuation that should pass every check. */
function healthy() {
  return {
    calculation: {
      inputs: {
        params: {
          weight_asset: 0,
          weight_opm: 0.5,
          weight_income: 0.25,
          weight_market: 0.25,
          dlom: 0.2,
          dloc: 0.05,
          dlom_method: 'finnerty',
          allocation_method: 'opm',
        },
        inputs: {
          valuation_date: '2026-06-30',
          shares_outstanding_common: 8_000_000,
          options_outstanding: 1_000_000,
          volatility: 0.6,
          income: { free_cash_flows: [1e6, 2e6, 3e6], discount_rate: 0.3, terminal_growth: 0.03 },
          market: { metric: 4e6, multiples: [4, 6] },
          share_classes: [
            { kind: 'common', name: 'Common', shares: 8_000_000 },
            { kind: 'preferred', name: 'A', shares: 2_000_000, preference: 5e6 },
          ],
        },
      },
      results: { fully_diluted_common: 9_000_000 },
      equity_value: 20_000_000,
      fmv_per_share: 1.5,
      created_at: '2026-07-01T00:00:00Z',
    },
    params: {
      weight_opm: 0.5,
      dlom: 0.2,
      dlom_method: 'finnerty',
      allocation_method: 'opm',
      fiscal_year_end: '2025-12-31',
      last_round_date: '2026-01-15',
      exit_timeline: '2029-06-30',
      updated_at: '2026-06-30T00:00:00Z',
    },
    valuation: { currency: 'USD' },
  };
}

const byKey = (report: ReturnType<typeof runHealthChecks>, key: string) =>
  report.checks.find((c) => c.key === key);

describe('worstSeverity', () => {
  it('escalates ok < info < warning < error', () => {
    expect(worstSeverity(['ok', 'info', 'ok'])).toBe('info');
    expect(worstSeverity(['ok', 'warning', 'info'])).toBe('warning');
    expect(worstSeverity(['warning', 'error'])).toBe('error');
    expect(worstSeverity([])).toBe('ok');
  });
});

describe('runHealthChecks', () => {
  it('passes a clean valuation with no blocking findings', () => {
    const report = runHealthChecks(healthy());
    expect(report.blocking).toBe(false);
    expect(report.counts.error).toBe(0);
    expect(report.severity === 'ok' || report.severity === 'info' || report.severity === 'warning').toBe(true);
  });

  it('covers all five categories', () => {
    const report = runHealthChecks(healthy());
    const cats = new Set<HealthCategory>(report.checks.map((c) => c.category));
    expect(cats).toEqual(
      new Set(['methodology', 'assumptions', 'completeness', 'mathematical', 'temporal']),
    );
  });

  it('flags weights that do not sum to 100% as a blocking error', () => {
    const h = healthy();
    h.calculation.inputs.params.weight_market = 0.5; // now sums to 1.25
    const report = runHealthChecks(h);
    const check = byKey(report, 'weights_sum');
    expect(check?.severity).toBe('error');
    expect(check?.category).toBe('mathematical');
    expect(report.blocking).toBe(true);
  });

  it('errors when the OPM is weighted but volatility is missing', () => {
    const h = healthy();
    delete (h.calculation.inputs.inputs as Record<string, unknown>).volatility;
    const report = runHealthChecks(h);
    expect(byKey(report, 'opm_volatility_present')?.severity).toBe('error');
    expect(report.blocking).toBe(true);
  });

  it('errors when PWERM is selected without scenarios', () => {
    const h = healthy();
    h.calculation.inputs.params.allocation_method = 'pwerm';
    h.params.allocation_method = 'pwerm';
    const report = runHealthChecks(h);
    expect(byKey(report, 'pwerm_scenarios_present')?.severity).toBe('error');
  });

  it('warns on an out-of-band DLOM and errors on an absurd one', () => {
    const warn = healthy();
    warn.calculation.inputs.params.dlom = 0.45;
    warn.params.dlom = 0.45;
    expect(byKey(runHealthChecks(warn), 'dlom_range')?.severity).toBe('warning');

    const err = healthy();
    err.calculation.inputs.params.dlom = 0.8;
    err.params.dlom = 0.8;
    expect(byKey(runHealthChecks(err), 'dlom_range')?.severity).toBe('error');
  });

  it('errors when common shares are missing (completeness)', () => {
    const h = healthy();
    delete (h.calculation.inputs.inputs as Record<string, unknown>).shares_outstanding_common;
    const report = runHealthChecks(h);
    const check = byKey(report, 'common_shares_present');
    expect(check?.severity).toBe('error');
    expect(check?.category).toBe('completeness');
  });

  it('warns when the cap table does not reconcile with common shares', () => {
    const h = healthy();
    // Cap-table common (8M) exceeds a lowered fully diluted common count.
    h.calculation.inputs.inputs.shares_outstanding_common = 5_000_000;
    const report = runHealthChecks(h);
    expect(byKey(report, 'cap_table_reconciles')?.severity).toBe('warning');
  });

  it('errors when the expected exit precedes the valuation date (temporal)', () => {
    const h = healthy();
    h.params.exit_timeline = '2026-01-01'; // before the 2026-06-30 valuation date
    const report = runHealthChecks(h);
    const check = byKey(report, 'exit_after_valuation');
    expect(check?.severity).toBe('error');
    expect(check?.category).toBe('temporal');
  });

  it('warns when parameters changed after the calculation (staleness)', () => {
    const h = healthy();
    h.params.updated_at = '2026-07-05T00:00:00Z'; // after the 2026-07-01 calc
    const report = runHealthChecks(h);
    expect(byKey(report, 'params_freshness')?.severity).toBe('warning');
  });

  it('errors when FMV per share exceeds total equity value', () => {
    const h = healthy();
    h.calculation.fmv_per_share = 30_000_000;
    const report = runHealthChecks(h);
    expect(byKey(report, 'fmv_below_equity')?.severity).toBe('error');
  });
});
