import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import {
  findCurrentVolatilityEstimate,
  insertVolatilityEstimate,
  listVolatilityEstimates,
  markVolatilityEstimateApplied,
  VOLATILITY_ESTIMATE_PAGE_LIMIT,
} from '../../src/repos/volatilityEstimates.js';
import {
  findCurrentProjection,
  insertProjection,
  markProjectionApplied,
} from '../../src/repos/projections.js';
import {
  findAppliedRollforwardRun,
  insertRollforwardRun,
  markRollforwardRunApplied,
} from '../../src/repos/rollforwardRuns.js';
import { createValuation, clearValuationCache } from '../../src/repos/valuations.js';
import { createUser } from '../../src/repos/users.js';
import { hashPassword } from '../../src/auth/password.js';
import { isDbAvailable, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * "The run that counts" is the one adopted last, not the one measured last.
 *
 * Both `findCurrentVolatilityEstimate` and `findCurrentProjection` answer the
 * question the report exhibits rest on: which derivation is the calculation
 * carrying? Both answered it by creation order among the adopted rows, which is
 * a different question, and the two only agree while nobody goes back.
 *
 * Going back is ordinary work. `POST /volatility/:estimateId/apply` and `POST
 * /projection/:projectionId/apply` look their row up by id and neither asks
 * whether a newer run exists, so measuring a second time and then returning to
 * the first is two adoptions in reverse order of creation — and after it the
 * engagement's `engine_inputs` hold the *first* run's figures while these
 * lookups returned the second's.
 *
 * The exhibits are what make that consequential rather than cosmetic. Both read
 * the applied figure off the calculation's own inputs and compare it to the run
 * they were handed, so a superseded run does not merely print the wrong window
 * — it prints an unexplained *departure* between the two, which is the sentence
 * a reviewer is meant to be able to trust ("the basis for the departure is
 * stated in the body of this report"). There was no departure.
 *
 * `findAppliedRollforwardRun` orders by `applied_at` and always did; these two
 * now agree with it.
 */
describe.skipIf(!dbUp)('the adopted run a report describes', () => {
  let db: TestDb;
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    const user = await createUser(pool, {
      email: `adopted-${newUlid().toLowerCase()}@test.example.com`,
      passwordDigest: await hashPassword('test-password-123'),
      roles: ['reviewer'],
      partnerId: null,
    });
    userId = user.id;
  });
  afterAll(async () => {
    clearValuationCache();
    await db?.teardown();
  });

  async function newValuation(name: string): Promise<string> {
    const row = await createValuation(
      pool,
      { kind: '409a', companyName: name, userId },
      { actorType: 'human', actorId: userId, source: 'test' },
    );
    return row.id;
  }

  /** `now()` is transaction start; two adoptions need two distinguishable ones. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  async function newEstimate(valuationId: string, recommended: number) {
    return insertVolatilityEstimate(pool, {
      valuationId,
      method: 'historical',
      periodsPerYear: 252,
      windowStart: '2024-01-01',
      windowEnd: '2024-12-31',
      timeToExitYears: null,
      recommended,
      medianVol: recommended,
      meanVol: recommended,
      minVol: recommended,
      maxVol: recommended,
      coefficientOfVariation: null,
      confidence: 'medium',
      manualOverride: null,
      companies: [{ ticker: 'AAA', volatility: recommended, used: true }],
      excluded: [],
      createdBy: userId,
    });
  }

  it('names the estimate adopted last, not the one measured last', async () => {
    const valuationId = await newValuation('Sigma Reversal Ltd');
    const wide = await newEstimate(valuationId, 0.71);
    const narrow = await newEstimate(valuationId, 0.64);

    // The analyst adopts the narrower window, then thinks better of it and goes
    // back to the wide one. `engine_inputs.volatility` now holds 0.71.
    await markVolatilityEstimateApplied(pool, valuationId, narrow.id, userId);
    await tick();
    await markVolatilityEstimateApplied(pool, valuationId, wide.id, userId);

    const current = await findCurrentVolatilityEstimate(pool, valuationId);
    expect(current?.id).toBe(wide.id);
    expect(current?.recommended).toBe(0.71);
  });

  it('still falls back to the newest run of any kind when none was adopted', async () => {
    const valuationId = await newValuation('Nobody Adopted Anything Inc');
    await newEstimate(valuationId, 0.5);
    const newest = await newEstimate(valuationId, 0.55);

    const current = await findCurrentVolatilityEstimate(pool, valuationId);
    expect(current?.id).toBe(newest.id);
    expect(current?.applied_at).toBeNull();
  });

  it('prefers an adopted run over a newer unadopted one', async () => {
    const valuationId = await newValuation('Adopted Then Superseded Inc');
    const adopted = await newEstimate(valuationId, 0.6);
    await newEstimate(valuationId, 0.9);
    await markVolatilityEstimateApplied(pool, valuationId, adopted.id, userId);

    const current = await findCurrentVolatilityEstimate(pool, valuationId);
    expect(current?.id).toBe(adopted.id);
  });

  /**
   * The other half of the same question: the panel that answers "where did the
   * applied figure come from" is a page, and the run it names can be anywhere
   * in the history — so the page has to say when it stopped short.
   *
   * Twenty was a default argument rather than a number in the SQL, which is why
   * `silentCapCensus` never saw it: the statement reads `LIMIT $2` and the one
   * caller passed nothing.
   */
  it('says when the derivation history stopped short', async () => {
    const valuationId = await newValuation('Twenty-One Runs Ltd');
    for (let i = 0; i < VOLATILITY_ESTIMATE_PAGE_LIMIT + 1; i++) {
      await newEstimate(valuationId, 0.3 + i / 100);
    }
    const page = await listVolatilityEstimates(pool, valuationId);
    expect(page.estimates).toHaveLength(VOLATILITY_ESTIMATE_PAGE_LIMIT);
    expect(page.truncated).toBe(true);
  });

  it('does not claim truncation on a history that fits', async () => {
    const valuationId = await newValuation('Two Runs Ltd');
    await newEstimate(valuationId, 0.4);
    await newEstimate(valuationId, 0.5);
    const page = await listVolatilityEstimates(pool, valuationId);
    expect(page.estimates).toHaveLength(2);
    expect(page.truncated).toBe(false);
  });

  async function newForecast(valuationId: string, flows: number[]) {
    return insertProjection(pool, {
      valuationId,
      method: 'growth',
      years: flows.length,
      taxRate: 0.21,
      inputs: { base_revenue: 1_000_000 },
      projections: flows.map((fcff, i) => ({ year: i + 1, fcff }) as never),
      freeCashFlows: flows,
      terminalMethod: null,
      terminalValue: null,
      createdBy: userId,
    });
  }

  it('names the forecast adopted last, not the one built last', async () => {
    const valuationId = await newValuation('Forecast Reversal Ltd');
    const conservative = await newForecast(valuationId, [100, 110, 120]);
    const aggressive = await newForecast(valuationId, [200, 260, 340]);

    await markProjectionApplied(pool, valuationId, aggressive.id, userId);
    await tick();
    await markProjectionApplied(pool, valuationId, conservative.id, userId);

    const current = await findCurrentProjection(pool, valuationId);
    expect(current?.id).toBe(conservative.id);
    expect(current?.free_cash_flows).toEqual([100, 110, 120]);
  });
  /**
   * Going back to a run that was already adopted once (R388, M3).
   *
   * The R304 cases above each adopt a *fresh* row second, which is the only
   * shape in which "keep the first adoption's timestamp" and "the run that
   * counts is the one adopted last" agree. Add one more click — the analyst
   * returns to the run they started on — and they do not: `markApplied`'s
   * `WHERE applied_at IS NULL` made that call a no-op, so the override and
   * `engine_inputs` moved back to the first run while its timestamp stayed
   * behind the run it had just superseded. The lookup then names the run the
   * calculation is not carrying, which is the state R304 exists to prevent.
   */
  it('follows the analyst back to an estimate adopted once already', async () => {
    const valuationId = await newValuation('Sigma Round Trip Ltd');
    const wide = await newEstimate(valuationId, 0.71);
    const narrow = await newEstimate(valuationId, 0.64);

    await markVolatilityEstimateApplied(pool, valuationId, wide.id, userId);
    await tick();
    await markVolatilityEstimateApplied(pool, valuationId, narrow.id, userId);
    await tick();
    // Thinks better of the narrow window and returns to the one they started
    // on. `engine_inputs.volatility` is 0.71 again.
    await markVolatilityEstimateApplied(pool, valuationId, wide.id, userId);

    const current = await findCurrentVolatilityEstimate(pool, valuationId);
    expect(current?.id).toBe(wide.id);
    expect(current?.recommended).toBe(0.71);
  });

  it('follows the analyst back to a forecast adopted once already', async () => {
    const valuationId = await newValuation('Forecast Round Trip Ltd');
    const conservative = await newForecast(valuationId, [100, 110, 120]);
    const aggressive = await newForecast(valuationId, [200, 260, 340]);

    await markProjectionApplied(pool, valuationId, conservative.id, userId);
    await tick();
    await markProjectionApplied(pool, valuationId, aggressive.id, userId);
    await tick();
    await markProjectionApplied(pool, valuationId, conservative.id, userId);

    const current = await findCurrentProjection(pool, valuationId);
    expect(current?.id).toBe(conservative.id);
    expect(current?.free_cash_flows).toEqual([100, 110, 120]);
  });

  /**
   * The third member of the family. It has always ordered by adoption and
   * filtered on it, so R304 left it alone — and it carried the same no-op,
   * which is what makes this the round-trip case rather than the ordering one.
   * Exhibit B-2 prints the run this returns.
   */
  it('follows the analyst back to a bridge adopted once already', async () => {
    const priorId = await newValuation('Anchor Round Trip Ltd (prior)');
    const valuationId = await newValuation('Anchor Round Trip Ltd');
    const first = await newBridge(valuationId, priorId, 12_000_000);
    const second = await newBridge(valuationId, priorId, 15_000_000);

    await markRollforwardRunApplied(pool, valuationId, first.id, userId);
    await tick();
    await markRollforwardRunApplied(pool, valuationId, second.id, userId);
    await tick();
    await markRollforwardRunApplied(pool, valuationId, first.id, userId);

    const current = await findAppliedRollforwardRun(pool, valuationId);
    expect(current?.id).toBe(first.id);
    expect(current?.rolled_equity_value).toBe(12_000_000);
  });

  /**
   * The idempotence the old `WHERE` clause was there for. A double-clicked
   * Adopt is two adoptions of the same run and no other run is in play, so the
   * timestamp moving costs nothing — but the row must still come back adopted,
   * and still be the one that counts.
   */
  it('is still idempotent when the same run is adopted twice running', async () => {
    const valuationId = await newValuation('Double Click Ltd');
    const only = await newEstimate(valuationId, 0.55);

    const first = await markVolatilityEstimateApplied(pool, valuationId, only.id, userId);
    await tick();
    const second = await markVolatilityEstimateApplied(pool, valuationId, only.id, userId);

    expect(first?.applied_at).not.toBeNull();
    expect(second?.applied_at).not.toBeNull();
    expect(second?.applied_by).toBe(userId);
    const current = await findCurrentVolatilityEstimate(pool, valuationId);
    expect(current?.id).toBe(only.id);
  });

  async function newBridge(valuationId: string, priorValuationId: string, rolled: number) {
    return insertRollforwardRun(pool, {
      valuationId,
      priorValuationId,
      priorCalculationId: null,
      priorValuationNumber: 'V-1',
      priorValuationDate: '2023-06-30',
      newValuationDate: '2024-06-30',
      yearsElapsed: 1,
      priorEquityValue: 10_000_000,
      rolledEquityValue: rolled,
      annualAccretion: 0.2,
      newRoundPostMoney: null,
      calibrationSteps: [{ step: 'prior_equity_value', value: 10_000_000 }],
      materialChanges: [],
      requiresFullRevaluation: false,
      prePopulatedInputs: {},
      createdBy: userId,
    });
  }
});
