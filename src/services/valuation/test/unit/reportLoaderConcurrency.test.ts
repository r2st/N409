import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { summaryFor } from '../../src/routes/reports.js';
import { buildCalculationInputs } from '../../src/routes/calculations.js';
import type { ValuationRow } from '../../src/repos/valuations.js';
import type { ValuationParamsRow } from '../../src/repos/params.js';

/**
 * Rendering a report and assembling a calculation both fan out across a dozen
 * tables. Every one of those loaders is keyed on the same valuation and not one
 * is derived from another — but written as a column of `await`s they run
 * strictly one at a time, so the wall clock is the *sum* of a dozen round trips
 * instead of the slowest of them. On a remote database that is the difference
 * between a report that renders promptly and one that appears to hang.
 *
 * That property is invisible in a functional test: sequential and concurrent
 * code return exactly the same document. So it is asserted directly, by
 * instrumenting the pool and watching how many queries are in flight at once.
 * A future edit that reintroduces a sequential await will fail here rather than
 * quietly costing every render a round trip.
 */

interface Probe {
  pool: pg.Pool;
  /** The most queries that were ever in flight simultaneously. */
  peakConcurrency: () => number;
  count: () => number;
}

/**
 * A pool that answers every query with no rows, after yielding to the event
 * loop. The yield is what makes concurrency observable: a query that resolves
 * synchronously would never overlap with anything.
 */
function probePool(): Probe {
  let inFlight = 0;
  let peak = 0;
  let total = 0;
  const query = async () => {
    inFlight += 1;
    total += 1;
    peak = Math.max(peak, inFlight);
    // Two turns, so an overlapping caller has a chance to start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    return { rows: [], rowCount: 0, command: 'SELECT', fields: [], oid: 0 };
  };
  return {
    pool: { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool,
    peakConcurrency: () => peak,
    count: () => total,
  };
}

const valuation = {
  id: '01N409VALREPORT0000000000A',
  kind: '409a',
  state: 'completed',
  company_name: 'Acme Robotics',
  currency: 'USD',
  user_id: '01N409USER0000000000000AAA',
  partner_id: null,
} as unknown as ValuationRow;

const paramsRow = {
  valuation_id: valuation.id,
  market_method: 'revenue',
  market_horizon: 'ltm',
  engine_inputs: null,
  wacc_inputs: null,
  auto_wacc: false,
  development_stage: null,
  required_return_table: null,
} as unknown as ValuationParamsRow;

describe('report and calculation loaders run concurrently', () => {
  it('fans the report loaders out instead of queueing them', async () => {
    const probe = probePool();
    const result = await summaryFor(probe.pool, valuation);

    // Sanity: it really did do the work, and on an empty database it renders
    // the "nothing concluded yet" shape rather than throwing.
    expect(probe.count()).toBeGreaterThan(5);
    expect(result.summary).toBeUndefined();
    expect(result.valuationDate).toBeNull();

    // The peer set, params, workbook, volatility, projection, HMRC form, fund
    // and debt schedules and the research bibliography are all independent —
    // nine loaders in one wave. If this drops toward 1, they have been
    // serialised again.
    expect(probe.peakConcurrency()).toBeGreaterThanOrEqual(5);
  });

  it('fetches the extraction job and the screened peer set together', async () => {
    const probe = probePool();
    await buildCalculationInputs(probe.pool, valuation.id, paramsRow);

    expect(probe.count()).toBeGreaterThan(1);
    expect(probe.peakConcurrency()).toBeGreaterThan(1);
  });

  it('still lets the caller’s explicit overrides win', async () => {
    // Guards the refactor: reordering the fetches must not reorder the merge.
    const probe = probePool();
    const inputs = await buildCalculationInputs(probe.pool, valuation.id, paramsRow, {
      income: { discount_rate: 0.19 },
    });
    expect(inputs).toEqual({ income: { discount_rate: 0.19 } });
  });
});
