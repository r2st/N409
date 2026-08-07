import { describe, expect, it } from 'vitest';
import { runQaChecks, worstStatus, type QaCalculation } from '../../src/domain/qaChecks.js';

function calc(overrides: {
  params?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  results?: Record<string, unknown> | null;
  equity?: number | string | null;
  fmv?: number | string | null;
  createdAt?: string;
}): QaCalculation {
  return {
    inputs: { params: overrides.params ?? {}, inputs: overrides.inputs ?? {} },
    ...(overrides.results !== undefined ? { results: overrides.results } : {}),
    equity_value: overrides.equity ?? '20000000',
    fmv_per_share: overrides.fmv ?? '2',
    created_at: overrides.createdAt ?? '2026-07-01T00:00:00Z',
  };
}

const byKey = (result: ReturnType<typeof runQaChecks>, key: string) =>
  result.checks.find((c) => c.key === key);

describe('worstStatus', () => {
  it('orders pass < warn < fail', () => {
    expect(worstStatus([])).toBe('pass');
    expect(worstStatus(['pass', 'warn', 'pass'])).toBe('warn');
    expect(worstStatus(['warn', 'fail', 'pass'])).toBe('fail');
  });
});

describe('deterministic QA checks', () => {
  it('passes a healthy calculation', () => {
    const result = runQaChecks({
      calculation: calc({
        params: {
          weight_income: 0.6,
          weight_market: 0.4,
          weight_asset: 0,
          weight_opm: 0,
          dlom: 0.3,
          dloc: 0.1,
        },
        inputs: {
          volatility: 0.6,
          income: { discount_rate: 0.25, terminal_growth: 0.03 },
          last_round_price_per_share: 3.5,
        },
      }),
    });
    expect(result.status).toBe('pass');
    expect(result.checks.length).toBeGreaterThanOrEqual(8);
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails on non-positive outputs', () => {
    const result = runQaChecks({ calculation: calc({ equity: -5, fmv: 0 }) });
    expect(result.status).toBe('fail');
    expect(byKey(result, 'equity_positive')?.status).toBe('fail');
    expect(byKey(result, 'fmv_positive')?.status).toBe('fail');
  });

  it('fails when FMV per share exceeds the entire equity value', () => {
    const result = runQaChecks({ calculation: calc({ equity: 100, fmv: 500 }) });
    expect(byKey(result, 'fmv_vs_equity')?.status).toBe('fail');
  });

  it('fails weights that do not sum to 100%', () => {
    const result = runQaChecks({
      calculation: calc({
        params: { weight_income: 0.5, weight_market: 0.4, weight_asset: 0, weight_opm: 0 },
      }),
    });
    expect(byKey(result, 'weights_sum')?.status).toBe('fail');
    expect(byKey(result, 'weights_sum')?.detail).toContain('90.0%');
  });

  it('skips the weights check when no weights are set', () => {
    const result = runQaChecks({ calculation: calc({}) });
    expect(byKey(result, 'weights_sum')).toBeUndefined();
  });

  it('grades DLOM: pass ≤35%, warn >35%, fail >60%', () => {
    expect(byKey(runQaChecks({ calculation: calc({ params: { dlom: 0.3 } }) }), 'dlom_range')?.status).toBe(
      'pass',
    );
    expect(byKey(runQaChecks({ calculation: calc({ params: { dlom: 0.45 } }) }), 'dlom_range')?.status).toBe(
      'warn',
    );
    expect(byKey(runQaChecks({ calculation: calc({ params: { dlom: 0.7 } }) }), 'dlom_range')?.status).toBe(
      'fail',
    );
  });

  /**
   * The gate has to grade the discount the engine applied, not the one the
   * analyst typed — the two are different numbers under a model DLOM, and this
   * check is what stands between a run and `published`.
   */
  describe('grades the discount the run applied, not the param', () => {
    const modelRun = (dlom: number) => ({
      params: { dlom_method: 'chaffee', dlom: null },
      results: { discounts: { dloc: 0, dlom, dlom_method: 'chaffee' } },
    });

    it('grades a Chaffee DLOM that no param records', () => {
      // The normal shape for a model DLOM: params.dlom is null because the
      // engine derives it. This used to skip the check entirely.
      const result = runQaChecks({ calculation: calc(modelRun(0.45)) });
      const check = byKey(result, 'dlom_range');
      expect(check?.status).toBe('warn');
      expect(check?.detail).toContain('45.0%');
      expect(check?.detail).toContain('chaffee model');
      expect(result.status).toBe('warn');
    });

    it('fails a model DLOM outside any defensible range', () => {
      expect(byKey(runQaChecks({ calculation: calc(modelRun(0.72)) }), 'dlom_range')?.status).toBe('fail');
    });

    it('passes a model DLOM inside the band', () => {
      expect(byKey(runQaChecks({ calculation: calc(modelRun(0.28)) }), 'dlom_range')?.status).toBe('pass');
    });

    it('prefers the applied DLOM over a stale param left on the row', () => {
      // The analyst set 20% by hand, then switched to Finnerty; the param is
      // now decorative and the run applied 52%. Grading the param passed the
      // gate on a figure the deliverable does not contain.
      const result = runQaChecks({
        calculation: calc({
          params: { dlom: 0.2, dlom_method: 'finnerty' },
          results: { discounts: { dloc: 0, dlom: 0.52, dlom_method: 'finnerty' } },
        }),
      });
      const check = byKey(result, 'dlom_range');
      expect(check?.status).toBe('warn');
      expect(check?.detail).toContain('52.0%');
      expect(check?.detail).not.toContain('20.0%');
    });

    it('grades the applied DLOC the same way', () => {
      const result = runQaChecks({
        calculation: calc({ params: { dloc: 0.05 }, results: { discounts: { dloc: 0.45, dlom: 0.2 } } }),
      });
      expect(byKey(result, 'dloc_range')?.status).toBe('warn');
      expect(byKey(result, 'dloc_range')?.detail).toContain('45.0%');
    });

    it('falls back to the param when the run reports no discounts', () => {
      // Calculations stored before the engine emitted `discounts`, and the
      // qualitative/explicit methods where the param *is* what was applied.
      const result = runQaChecks({ calculation: calc({ params: { dlom: 0.7 }, results: {} }) });
      expect(byKey(result, 'dlom_range')?.status).toBe('fail');
      expect(byKey(result, 'dlom_range')?.detail).not.toContain('model');
    });

    it('leaves the check off entirely when neither side reports a discount', () => {
      expect(byKey(runQaChecks({ calculation: calc({ results: {} }) }), 'dlom_range')).toBeUndefined();
      expect(byKey(runQaChecks({ calculation: calc({ results: {} }) }), 'dloc_range')).toBeUndefined();
    });
  });

  it('warns on volatility outliers and fails non-positive volatility', () => {
    expect(
      byKey(runQaChecks({ calculation: calc({ inputs: { volatility: 2.5 } }) }), 'volatility_range')?.status,
    ).toBe('warn');
    expect(
      byKey(runQaChecks({ calculation: calc({ inputs: { volatility: 0.05 } }) }), 'volatility_range')?.status,
    ).toBe('warn');
    expect(
      byKey(runQaChecks({ calculation: calc({ inputs: { volatility: 0 } }) }), 'volatility_range')?.status,
    ).toBe('fail');
    expect(
      byKey(runQaChecks({ calculation: calc({ inputs: { volatility: -1 } }) }), 'volatility_range')?.status,
    ).toBe('fail');
  });

  it('fails when the discount rate does not exceed terminal growth', () => {
    const result = runQaChecks({
      calculation: calc({ inputs: { income: { discount_rate: 0.03, terminal_growth: 0.05 } } }),
    });
    expect(byKey(result, 'discount_vs_growth')?.status).toBe('fail');
  });

  it('warns when common FMV reaches the last preferred round price', () => {
    const result = runQaChecks({
      calculation: calc({ fmv: 4, inputs: { last_round_price_per_share: 3.5 } }),
    });
    expect(byKey(result, 'fmv_vs_last_round')?.status).toBe('warn');
  });

  it('warns when params changed after the calculation', () => {
    const stale = runQaChecks({
      calculation: calc({ createdAt: '2026-07-01T00:00:00Z' }),
      params: { updated_at: '2026-07-02T00:00:00Z' },
    });
    expect(byKey(stale, 'params_freshness')?.status).toBe('warn');

    const fresh = runQaChecks({
      calculation: calc({ createdAt: '2026-07-02T00:00:00Z' }),
      params: { updated_at: '2026-07-01T00:00:00Z' },
    });
    expect(byKey(fresh, 'params_freshness')?.status).toBe('pass');
  });

  it('tolerates numeric-as-string values from postgres', () => {
    const result = runQaChecks({
      calculation: {
        inputs: { params: { dlom: '0.30' }, inputs: {} },
        equity_value: '20000000.00',
        fmv_per_share: '2.0000',
        created_at: new Date(),
      },
    });
    expect(result.status).toBe('pass');
  });
});
