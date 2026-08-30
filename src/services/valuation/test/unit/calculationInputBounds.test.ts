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

  it('says which figures it refused, since the answer cannot', async () => {
    /*
     * The two apply paths report their rejections — one logs them, the other
     * returns them in its response — and this one answers with an input
     * document, where a refused field is simply a field that is not in it. An
     * extraction stored before this check existed is refused again on every
     * recalculation from then on, so without this line the only visible
     * consequence is a company priced without a figure that is still sitting
     * on the extraction screen.
     */
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = { warn: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg }) };

    await buildCalculationInputs(
      stubPool({ engine_inputs: { shares_outstanding_common: 8_000_000, volatility: 65 } }),
      'val-1',
      PARAMS,
      {},
      log as never,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toContain('outside the accepted range');
    expect(lines[0]!.obj).toMatchObject({ valuationId: 'val-1', jobId: 'job-1' });
    expect(lines[0]!.obj.rejected).toEqual([expect.objectContaining({ field: 'volatility', value: 65 })]);
  });

  it('says nothing when the extraction is sound', async () => {
    // A line per calculation on every well-formed engagement is a line nobody
    // reads, and the one that matters would be in among them.
    const lines: unknown[] = [];
    await buildCalculationInputs(
      stubPool({ engine_inputs: { shares_outstanding_common: 5_000_000, volatility: 0.65 } }),
      'val-1',
      PARAMS,
      {},
      { warn: (obj: unknown) => lines.push(obj) } as never,
    );
    expect(lines).toEqual([]);
  });

  it('tolerates a job whose result carries no engine inputs at all', async () => {
    expect(await buildCalculationInputs(stubPool({}), 'val-1', PARAMS)).toEqual({});
    expect(await buildCalculationInputs(stubPool(null), 'val-1', PARAMS)).toEqual({});
  });
});
