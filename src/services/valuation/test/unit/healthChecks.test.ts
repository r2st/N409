import { describe, expect, it } from 'vitest';
import { runHealthChecks, worstSeverity, type HealthCategory } from '../../src/domain/healthChecks.js';

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
    expect(report.severity === 'ok' || report.severity === 'info' || report.severity === 'warning').toBe(
      true,
    );
  });

  it('covers all five categories', () => {
    const report = runHealthChecks(healthy());
    const cats = new Set<HealthCategory>(report.checks.map((c) => c.category));
    expect(cats).toEqual(new Set(['methodology', 'assumptions', 'completeness', 'mathematical', 'temporal']));
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
    // Cap-table common (8M) exceeds a lowered common share count.
    h.calculation.inputs.inputs.shares_outstanding_common = 5_000_000;
    const report = runHealthChecks(h);
    const check = byKey(report, 'cap_table_reconciles');
    expect(check?.severity).toBe('warning');
    // Named for what the field is. `shares_outstanding_common` is common only —
    // the engine adds `options_outstanding` to it — and calling it "the fully
    // diluted common count" here borrowed the name of the engine's *output*,
    // which is the pairing that invites an analyst to enter a figure with the
    // pool already in it and then enter the pool again beside it.
    expect(check?.detail).toBe(
      'Cap-table common (8,000,000) exceeds the common shares outstanding (5,000,000) — ' +
        'that count is common only, with the option pool entered separately',
    );
  });

  /*
   * The other way the reconciliation fails, which was reported as this one.
   *
   * `reconciles` requires the cap table's common to be both above zero and at
   * or below the common share count, and a table carrying no common class at
   * all — preferred and options entered, the founders' rows still to come, the
   * state an import sits in for as long as it takes to finish it — fails the
   * first arm. It was then described with the sentence written for the second:
   * "Cap-table common (0) exceeds the common shares outstanding (8,000,000)",
   * which is not a near-miss, it is the opposite of the arithmetic it quotes.
   * The analyst it is addressed to went looking for shares to remove from a
   * table whose actual problem was shares missing from it.
   */
  it('says the common class is absent rather than that zero exceeds the count', () => {
    const h = healthy();
    h.calculation.inputs.inputs.share_classes = [
      { kind: 'preferred', name: 'A', shares: 2_000_000, preference: 5e6 },
    ] as (typeof h.calculation.inputs.inputs.share_classes)[number][];
    const check = byKey(runHealthChecks(h), 'cap_table_reconciles');
    expect(check?.severity).toBe('warning');
    expect(check?.detail).toBe(
      'The cap table has no common class to reconcile against the common shares outstanding (8,000,000)',
    );
    expect(check?.detail).not.toContain('exceeds');
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

  /**
   * `share_counts_match` grades the count the engine divided by, and the two
   * allocation families divide by different ones: the cap-table waterfall by
   * the common classes alone (the option pool is a separate class holding its
   * own value), the aggregate models by common + options. Checking every run
   * against common + options graded a correct waterfall run as a mismatch —
   * and passed a run whose disclosed count was not the one that produced its
   * own headline FMV.
   */
  describe('share count reconciliation follows the allocation basis', () => {
    it('accepts a waterfall run disclosing the cap table´s common shares', () => {
      const h = healthy();
      h.calculation.results = {
        fully_diluted_common: 8_000_000, // common classes only
        fully_diluted_basis: 'cap_table_common',
      };
      const check = byKey(runHealthChecks(h), 'share_counts_match');
      expect(check?.severity).toBe('ok');
      expect(check?.detail).toContain("the cap table's common shares");
    });

    it('warns when a waterfall run discloses the fully diluted count instead', () => {
      const h = healthy();
      h.calculation.results = {
        fully_diluted_common: 9_000_000, // common + options: not what it divided by
        fully_diluted_basis: 'cap_table_common',
      };
      expect(byKey(runHealthChecks(h), 'share_counts_match')?.severity).toBe('warning');
    });

    it('still holds the aggregate models to common + options', () => {
      const h = healthy();
      h.calculation.results = {
        fully_diluted_common: 9_000_000,
        fully_diluted_basis: 'common_plus_options',
      };
      expect(byKey(runHealthChecks(h), 'share_counts_match')?.severity).toBe('ok');

      h.calculation.results.fully_diluted_common = 8_000_000;
      expect(byKey(runHealthChecks(h), 'share_counts_match')?.severity).toBe('warning');
    });

    it('reads a calculation stored before the basis existed as the aggregate one', () => {
      const h = healthy();
      h.calculation.results = { fully_diluted_common: 9_000_000 };
      expect(byKey(runHealthChecks(h), 'share_counts_match')?.severity).toBe('ok');
    });

    it('skips the check rather than inventing a basis when neither count is known', () => {
      const h = healthy();
      h.calculation.results = { fully_diluted_common: 9_000_000, fully_diluted_basis: 'cap_table_common' };
      h.calculation.inputs.inputs.share_classes = [];
      expect(byKey(runHealthChecks(h), 'share_counts_match')).toBeUndefined();
    });
  });
});

/**
 * The rules above are exercised through a fully-populated fixture, which means
 * every `??` fallback and every "the other side supplied it" path was carrying
 * a valuation nobody had graded. These build the argument from the bottom up
 * instead, one sparse shape per rule.
 */
describe('runHealthChecks on sparse and degenerate inputs', () => {
  const run = (args: {
    params?: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    engineParams?: Record<string, unknown>;
    results?: Record<string, unknown> | null;
    equity?: string | number | null;
    fmv?: string | number | null;
    createdAt?: Date | string;
  }) =>
    runHealthChecks({
      calculation: {
        inputs: { params: args.engineParams ?? {}, inputs: args.inputs ?? {} },
        results: args.results === undefined ? {} : args.results,
        equity_value: args.equity === undefined ? 1_000_000 : args.equity,
        fmv_per_share: args.fmv === undefined ? 1 : args.fmv,
        created_at: args.createdAt ?? '2026-07-01T00:00:00Z',
      },
      params: args.params ?? null,
    });

  it('grades a calculation with no params row at all', () => {
    const report = run({ engineParams: { weight_opm: 1 }, inputs: { volatility: 0.5 } });
    // Defaults to OPM allocation, so it is the OPM rule that gets asked.
    expect(byKey(report, 'opm_volatility_present')?.severity).toBe('ok');
    expect(byKey(report, 'pwerm_scenarios_present')).toBeUndefined();
    // No params row means no staleness signal — the check is skipped, not failed.
    expect(byKey(report, 'params_freshness')).toBeUndefined();
  });

  it('takes the allocation method from the params row over the stored engine payload', () => {
    const report = run({
      params: { allocation_method: 'pwerm' },
      engineParams: { allocation_method: 'opm', weight_opm: 1 },
      inputs: { pwerm: { scenarios: [{ exit_value: 5e7, probability: 1 }] } },
    });
    expect(byKey(report, 'pwerm_scenarios_present')?.severity).toBe('ok');
    expect(byKey(report, 'pwerm_scenarios_present')?.detail).toContain('1 exit scenarios');
  });

  it('does not ask the OPM for a volatility it is not weighted for', () => {
    const report = run({ engineParams: { weight_asset: 1 }, inputs: {} });
    expect(byKey(report, 'opm_volatility_present')).toBeUndefined();
  });

  it('errors when the market approach is weighted with no comparables', () => {
    const report = run({ engineParams: { weight_market: 1 }, inputs: { market: {} } });
    const check = byKey(report, 'market_comparables_present');
    expect(check?.severity).toBe('error');
    expect(check?.detail).toContain('no comparable multiples');
    expect(report.blocking).toBe(true);
  });

  it('errors when the income approach is weighted with no projection', () => {
    const report = run({ engineParams: { weight_income: 1 }, inputs: { income: {} } });
    const check = byKey(report, 'income_projections_present');
    expect(check?.severity).toBe('error');
    expect(check?.detail).toContain('no free-cash-flow projection');
  });

  it('takes the DLOM method from the params row when the payload predates it', () => {
    // A model DLOM with no volatility contributes silently nothing to the
    // concluded discount, so the failure looks like a plausible number.
    const report = run({ params: { dlom_method: 'chaffee' }, engineParams: {}, inputs: {} });
    const check = byKey(report, 'dlom_model_needs_volatility');
    expect(check?.severity).toBe('error');
    expect(check?.detail).toContain('needs a volatility input');
  });

  it('reads a weighted DLOM blend off the params row', () => {
    const report = run({
      params: { dlom_methods: [{ method: 'finnerty', weight: 1 }] },
      inputs: { volatility: 0.55 },
    });
    expect(byKey(report, 'dlom_model_needs_volatility')?.severity).toBe('ok');
  });

  describe('assumption benchmarks', () => {
    it('errors on a non-positive volatility and warns outside the observed band', () => {
      expect(byKey(run({ inputs: { volatility: 0 } }), 'volatility_benchmarked')?.severity).toBe('error');
      expect(byKey(run({ inputs: { volatility: 0.05 } }), 'volatility_benchmarked')?.severity).toBe(
        'warning',
      );
      expect(byKey(run({ inputs: { volatility: 1.8 } }), 'volatility_benchmarked')?.severity).toBe('warning');
      const outlier = byKey(run({ inputs: { volatility: 1.8 } }), 'volatility_benchmarked');
      expect(outlier?.detail).toContain('180.0%');
      expect(outlier?.detail).toContain('outlier');
    });

    it('warns on a discount rate outside venture norms and passes one inside', () => {
      const low = byKey(run({ inputs: { income: { discount_rate: 0.05 } } }), 'discount_rate_range');
      expect(low?.severity).toBe('warning');
      expect(low?.detail).toContain('outside');
      expect(
        byKey(run({ inputs: { income: { discount_rate: 0.75 } } }), 'discount_rate_range')?.severity,
      ).toBe('warning');
      expect(
        byKey(run({ inputs: { income: { discount_rate: 0.3 } } }), 'discount_rate_range')?.severity,
      ).toBe('ok');
    });

    it('warns on a terminal growth rate outside the long-run norm', () => {
      expect(
        byKey(run({ inputs: { income: { terminal_growth: 0.09 } } }), 'terminal_growth_range')?.severity,
      ).toBe('warning');
      expect(
        byKey(run({ inputs: { income: { terminal_growth: -0.01 } } }), 'terminal_growth_range')?.severity,
      ).toBe('warning');
      expect(
        byKey(run({ inputs: { income: { terminal_growth: 0.025 } } }), 'terminal_growth_range')?.severity,
      ).toBe('ok');
    });

    it('reads the DLOM off the params row when the stored payload has none', () => {
      const check = byKey(run({ params: { dlom: 0.5 }, engineParams: {} }), 'dlom_range');
      expect(check?.severity).toBe('warning');
      expect(check?.detail).toContain('50.0%');
    });

    it('says nothing about an assumption that was never set', () => {
      const report = run({});
      for (const key of [
        'volatility_benchmarked',
        'discount_rate_range',
        'dlom_range',
        'terminal_growth_range',
      ])
        expect(byKey(report, key)).toBeUndefined();
    });
  });

  it('errors when no approach weight is set at all', () => {
    const report = run({ engineParams: {} });
    expect(byKey(report, 'weights_present')?.severity).toBe('error');
    expect(byKey(report, 'weights_present')?.detail).toBe('No approach weights are set');
    // With no weights there is nothing to sum, so that rule is skipped rather
    // than reported as summing to 0%.
    expect(byKey(report, 'weights_sum')).toBeUndefined();
  });

  it('errors on a non-positive equity value and FMV', () => {
    const report = run({ equity: 0, fmv: -0.5 });
    expect(byKey(report, 'equity_positive')?.severity).toBe('error');
    expect(byKey(report, 'equity_positive')?.detail).toContain('is not positive');
    expect(byKey(report, 'fmv_positive')?.severity).toBe('error');
    // The cross-check between the two is meaningless once either is invalid.
    expect(byKey(report, 'fmv_below_equity')).toBeUndefined();
  });

  it('skips the arithmetic checks when the figures are not numbers at all', () => {
    const report = run({ equity: 'unavailable', fmv: null });
    expect(byKey(report, 'equity_positive')).toBeUndefined();
    expect(byKey(report, 'fmv_positive')).toBeUndefined();
  });

  it('reconciles against common alone when no options are recorded', () => {
    const report = run({
      inputs: { shares_outstanding_common: 8_000_000 },
      results: { fully_diluted_common: 8_000_000 },
    });
    expect(byKey(report, 'share_counts_match')?.severity).toBe('ok');
  });

  it('counts a cap-table class that states no share count as zero', () => {
    const report = run({
      inputs: {
        shares_outstanding_common: 8_000_000,
        share_classes: [
          { kind: 'common', name: 'Common' },
          { kind: 'common', shares: 8_000_000 },
        ],
      },
      results: { fully_diluted_common: 8_000_000, fully_diluted_basis: 'cap_table_common' },
    });
    expect(byKey(report, 'cap_table_reconciles')?.severity).toBe('ok');
    expect(byKey(report, 'share_counts_match')?.severity).toBe('ok');
  });

  it('skips the share-count check when the engine reported no basis count', () => {
    const report = run({ inputs: { shares_outstanding_common: 8_000_000 }, results: {} });
    expect(byKey(report, 'share_counts_match')).toBeUndefined();
  });

  it('grades a calculation whose engine results are absent entirely', () => {
    const report = run({ results: null, inputs: { shares_outstanding_common: 1000 } });
    expect(byKey(report, 'share_counts_match')).toBeUndefined();
    expect(byKey(report, 'common_shares_present')?.severity).toBe('ok');
  });

  describe('temporal ordering', () => {
    it('warns when the financials or the last round postdate the valuation date', () => {
      const report = run({
        inputs: { valuation_date: '2026-06-30' },
        params: { fiscal_year_end: '2026-12-31', last_round_date: '2026-09-01' },
      });
      expect(byKey(report, 'fiscal_before_valuation')?.severity).toBe('warning');
      expect(byKey(report, 'fiscal_before_valuation')?.detail).toContain('forward of the measurement date');
      expect(byKey(report, 'last_round_before_valuation')?.severity).toBe('warning');
    });

    it('accepts a valuation date that arrives from pg as a Date', () => {
      const report = run({
        inputs: { valuation_date: new Date('2026-06-30T00:00:00Z') },
        params: { fiscal_year_end: '2025-12-31', exit_timeline: '2029-06-30' },
      });
      expect(byKey(report, 'fiscal_before_valuation')?.severity).toBe('ok');
      expect(byKey(report, 'exit_after_valuation')?.severity).toBe('ok');
    });

    /**
     * One horizon, two stores, and only one of them is read by anything that
     * computes.
     *
     * `params.exit_timeline` is a date on the parameters tab and the engine
     * reads nothing from it. `engine_inputs.time_to_exit_years` is the term the
     * OPM strikes on and the figure Exhibit F-1, the ASC 718 assumptions table
     * and the summary's "T 4.50y" all print. A horizon revised on one and not
     * the other computes cleanly and prints cleanly, and the report then tells
     * a reader two different things about when this company expects to exit.
     */
    it('reconciles the dated exit against the term the allocation ran on', () => {
      const agreeing = run({
        inputs: { valuation_date: '2026-06-30', time_to_exit_years: 4 },
        params: { exit_timeline: '2030-06-30' },
      });
      expect(byKey(agreeing, 'exit_horizon_agrees')?.severity).toBe('ok');
      expect(byKey(agreeing, 'exit_horizon_agrees')?.category).toBe('temporal');

      const revisedOnOneField = run({
        inputs: { valuation_date: '2026-06-30', time_to_exit_years: 4 },
        params: { exit_timeline: '2028-06-30' },
      });
      expect(byKey(revisedOnOneField, 'exit_horizon_agrees')?.severity).toBe('warning');
      expect(byKey(revisedOnOneField, 'exit_horizon_agrees')?.detail).toContain('2.00 years');
      expect(byKey(revisedOnOneField, 'exit_horizon_agrees')?.detail).toContain('4.00 years');
    });

    it('allows a whole quarter between a rounded date and a stated term', () => {
      // An exit stated as a quarter-end against a term stated to two decimals
      // differs by up to a full quarter without anybody having changed their
      // mind — 4.00 years against the quarter-end 4.25 years out is the
      // commonest such pair — and a check that fires on that is one nobody
      // reads.
      const report = run({
        inputs: { valuation_date: '2026-06-30', time_to_exit_years: 4 },
        params: { exit_timeline: '2030-09-30' },
      });
      expect(byKey(report, 'exit_horizon_agrees')?.severity).toBe('ok');
    });

    it('says nothing about the horizon when only one of the two is recorded', () => {
      const noTerm = run({
        inputs: { valuation_date: '2026-06-30' },
        params: { exit_timeline: '2030-06-30' },
      });
      expect(byKey(noTerm, 'exit_horizon_agrees')).toBeUndefined();

      const noDate = run({
        inputs: { valuation_date: '2026-06-30', time_to_exit_years: 4 },
        params: { exit_timeline: null },
      });
      expect(byKey(noDate, 'exit_horizon_agrees')).toBeUndefined();
    });

    it('skips every ordering rule when the valuation date is missing or unparseable', () => {
      for (const valuation_date of [undefined, '', 'not a date']) {
        const report = run({
          inputs: { valuation_date },
          params: {
            fiscal_year_end: '2026-12-31',
            last_round_date: '2026-09-01',
            exit_timeline: '2020-01-01',
          },
        });
        expect(byKey(report, 'fiscal_before_valuation')).toBeUndefined();
        expect(byKey(report, 'last_round_before_valuation')).toBeUndefined();
        expect(byKey(report, 'exit_after_valuation')).toBeUndefined();
      }
    });

    it('confirms freshness when the params predate the calculation', () => {
      const report = run({
        params: { updated_at: new Date('2026-06-01T00:00:00Z') },
        createdAt: new Date('2026-07-01T00:00:00Z'),
      });
      const check = byKey(report, 'params_freshness');
      expect(check?.severity).toBe('ok');
      expect(check?.detail).toContain('No parameter changes');
    });
  });

  it('counts every severity it emitted', () => {
    const report = run({ engineParams: { weight_market: 1 }, inputs: { market: {} }, equity: -1 });
    const counted = report.counts.ok + report.counts.info + report.counts.warning + report.counts.error;
    expect(counted).toBe(report.checks.length);
    expect(report.counts.error).toBeGreaterThan(0);
    expect(report.severity).toBe('error');
    expect(report.blocking).toBe(true);
  });
});

/**
 * A specialty run graded by rules written for the 409A model.
 *
 * A specialty calculation (`routes/specialty.ts`) persists
 * `results = { kind, specialty }` and writes its own headline into the typed
 * `equity_value` / `fmv_per_share` columns, because those are the columns the
 * row has. Everything else this file grades — approach weights, an allocation
 * method, a fully diluted common count — belongs to an engine that never ran,
 * and most rules dropped out on their own by finding no field to read.
 *
 * Two did not. `common_shares_present` and `weights_present` were
 * unconditional `error`s, so every specialty run came back `blocking: true`
 * asserting that its "fully diluted common share count is missing" and that no
 * approach weights were set — findings about figures the deliverable does not
 * contain, on a gate (`routes/healthChecks.ts` → `gate.satisfied`) that an
 * analyst could then never clear.
 *
 * And the three checks that *do* apply named the columns rather than the
 * figures: "Equity value is positive" over an IFRS 2 total share-based-payment
 * expense, "FMV per share is positive" over an EMI *actual* market value —
 * which is the restricted figure, not the FMV, and not what HMRC's limits are
 * tested against.
 */
describe('runHealthChecks on a specialty run', () => {
  /** An IFRS 2 run exactly as routes/specialty.ts persists one. */
  const ifrs2 = {
    calculation: {
      inputs: {
        endpoint: '/engine/v1/ifrs2',
        params: { vesting_condition: 'service' },
        inputs: { grant_date_fair_value: 4.2, awards_granted: 100_000 },
      },
      results: { kind: 'ifrs2', specialty: { total_expense: 420_000 } },
      equity_value: 420_000,
      fmv_per_share: null,
      created_at: '2026-07-01T00:00:00Z',
    },
    params: null,
    valuation: { currency: 'GBP' },
  };

  it('does not block on 409A inputs the kind never has', () => {
    const report = runHealthChecks(ifrs2);
    expect(byKey(report, 'common_shares_present')).toBeUndefined();
    expect(byKey(report, 'weights_present')).toBeUndefined();
    expect(report.blocking).toBe(false);
    expect(report.counts.error).toBe(0);
  });

  it('names the figure the column actually holds', () => {
    const check = byKey(runHealthChecks(ifrs2), 'equity_positive');
    expect(check?.label).toBe('Total expense is positive');
    expect(check?.detail).toBe('Total expense 420,000');
    expect(check?.severity).toBe('ok');
  });

  it('calls an EMI per-share conclusion the actual market value, not the FMV', () => {
    const report = runHealthChecks({
      calculation: {
        inputs: { endpoint: '/engine/v1/emi', params: { equity_value: 6_000_000 }, inputs: {} },
        results: { kind: 'emi', specialty: { amv_per_share: 0.8, umv_per_share: 1.2 } },
        equity_value: 6_000_000,
        fmv_per_share: 0.8,
        created_at: '2026-07-01T00:00:00Z',
      },
      params: null,
      valuation: { currency: 'GBP' },
    });
    expect(byKey(report, 'fmv_positive')?.label).toBe('Actual market value (AMV) per share is positive');
    expect(byKey(report, 'fmv_positive')?.detail).toBe('Actual market value (AMV) per share 0.8');
    expect(byKey(report, 'fmv_below_equity')?.label).toBe(
      'Actual market value (AMV) per share below concluded equity value',
    );
    expect(report.blocking).toBe(false);
    // The whole report must not say "FMV per share" anywhere about this run.
    expect(report.checks.map((c) => `${c.label}|${c.detail}`).join(' ')).not.toContain('FMV');
  });

  it('says why the report is short instead of reading as an all-clear', () => {
    // A QSBS attestation concludes neither typed column, so without this the
    // report would be an empty list at severity 'ok' — an examination that
    // never applied, presented as one that found nothing.
    const report = runHealthChecks({
      calculation: {
        inputs: { endpoint: '/engine/v1/qsbs', params: {}, inputs: {} },
        results: { kind: 'qsbs', specialty: { qualified: true } },
        equity_value: null,
        fmv_per_share: null,
        created_at: '2026-07-01T00:00:00Z',
      },
      params: null,
      valuation: { currency: 'USD' },
    });
    expect(byKey(report, 'equity_positive')).toBeUndefined();
    const scope = byKey(report, 'specialty_engine');
    expect(scope?.severity).toBe('info');
    expect(scope?.detail).toContain('QSBS attestation (IRC §1202)');
    expect(scope?.detail).toContain('do not apply');
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.blocking).toBe(false);
  });

  it('leaves a 409A run reading exactly as it did', () => {
    const report = runHealthChecks(healthy());
    expect(byKey(report, 'specialty_engine')).toBeUndefined();
    expect(byKey(report, 'common_shares_present')?.severity).toBe('ok');
    expect(byKey(report, 'weights_present')?.severity).toBe('ok');
    expect(byKey(report, 'equity_positive')?.label).toBe('Equity value is positive');
    expect(byKey(report, 'equity_positive')?.detail).toBe('Equity value 20,000,000');
    expect(byKey(report, 'fmv_positive')?.label).toBe('FMV per share is positive');
    expect(byKey(report, 'fmv_positive')?.detail).toBe('FMV/share 1.5');
    expect(byKey(report, 'fmv_below_equity')?.label).toBe('FMV per share below total equity value');
    expect(byKey(report, 'fmv_below_equity')?.detail).toBe(
      'Per-share value is consistent with total equity value',
    );
  });

  it('still grades a specialty headline that is not positive', () => {
    // The rule is not waived, only renamed: an IFRS 2 run that concluded a
    // negative total expense is still an error, stated as one about an expense.
    const report = runHealthChecks({
      ...ifrs2,
      calculation: { ...ifrs2.calculation, equity_value: -1_000 },
    });
    const check = byKey(report, 'equity_positive');
    expect(check?.severity).toBe('error');
    expect(check?.detail).toBe('Total expense -1000 is not positive');
    expect(report.blocking).toBe(true);
  });
});
