import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildCalculationInputs } from '../../src/routes/calculations.js';
import type { ValuationParamsRow } from '../../src/repos/params.js';

/**
 * The extraction job's result is read twice by two different kinds of caller:
 * the *apply* paths, which store the figures in `engine_inputs`, and
 * `buildCalculationInputs`, which assembles the document the engine prices the
 * company from. Only the first pair filtered the model's numbers through the
 * bounds hand-entry enforces.
 *
 * That asymmetry is invisible in the stored state and decisive in the computed
 * one: a field the apply path refuses is precisely a field params has no value
 * for, so nothing overrode the refused figure when the calculation read the
 * job result directly — the rejected number was the only one the engine saw.
 */
function stubPool(job: Record<string, unknown> | null): pg.Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM ai_jobs')) {
        return {
          rows: job ? [{ id: 'job-1', status: 'succeeded', result: job, completed_at: new Date() }] : [],
        };
      }
      if (sql.includes('FROM comparable_items')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

const PARAMS = {
  engine_inputs: null,
  market_method: 'revenue',
  market_horizon: 'ltm',
} as unknown as ValuationParamsRow;

describe('buildCalculationInputs holds the extraction to the hand-entry bounds', () => {
  it('drops the figures the apply path refuses instead of pricing on them', async () => {
    const inputs = await buildCalculationInputs(
      stubPool({
        engine_inputs: {
          shares_outstanding_common: 8_000_000,
          cash: 1_200_000,
          // "volatility of 65%" read off the page as 65 — a 6,500% vol the OPM
          // would happily price.
          volatility: 65,
          risk_free_rate: 4.2,
          debt: -50_000,
          made_up_field: 42,
        },
      }),
      'val-1',
      PARAMS,
    );

    expect(inputs).toEqual({ shares_outstanding_common: 8_000_000, cash: 1_200_000 });
  });

  it('still carries a sound extraction through unchanged', async () => {
    const inputs = await buildCalculationInputs(
      stubPool({
        engine_inputs: { shares_outstanding_common: 5_000_000, volatility: 0.65, ebitda_ltm: -450_000 },
      }),
      'val-1',
      PARAMS,
    );
    expect(inputs).toEqual({
      shares_outstanding_common: 5_000_000,
      volatility: 0.65,
      ebitda_ltm: -450_000,
    });
  });

  it('lets the analyst-applied document override the extraction, as before', async () => {
    const inputs = await buildCalculationInputs(
      stubPool({ engine_inputs: { shares_outstanding_common: 8_000_000, volatility: 65 } }),
      'val-1',
      {
        ...PARAMS,
        engine_inputs: { shares_outstanding_common: 9_000_000, volatility: 0.5 },
      } as unknown as ValuationParamsRow,
    );
    expect(inputs).toEqual({ shares_outstanding_common: 9_000_000, volatility: 0.5 });
  });

  it('tolerates a job whose result carries no engine inputs at all', async () => {
    expect(await buildCalculationInputs(stubPool({}), 'val-1', PARAMS)).toEqual({});
    expect(await buildCalculationInputs(stubPool(null), 'val-1', PARAMS)).toEqual({});
  });
});
