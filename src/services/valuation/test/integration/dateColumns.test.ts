import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { upsertResolution } from '../../src/repos/boardApprovals.js';
import { upsertCompanyProfile, findCompanyProfile } from '../../src/repos/companyProfiles.js';
import { createInstrument, createValuation, listValuations } from '../../src/repos/debtInstruments.js';
import { createFund, createMark, createPosition, latestMarks, listMarks } from '../../src/repos/funds.js';
import { findResolutionByValuation } from '../../src/repos/boardApprovals.js';
import { insertVolatilityEstimate } from '../../src/repos/volatilityEstimates.js';
import { insertRollforwardRun } from '../../src/repos/rollforwardRuns.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { createGrant, listGrants } from '../../src/repos/grants.js';

/**
 * Every `date` column, as the day it holds — across the API, not just in one
 * helper.
 *
 * The other half of the fix in a700f4a. That commit corrected the places that
 * *formatted* a `date`; this covers the places that never formatted one at all,
 * because the row interface said `string` and the route sent the row. A Date
 * reaching `JSON.stringify` goes through `toJSON` → `toISOString()`, so a
 * column holding 2029-06-30 leaves as `2029-06-29T15:00:00.000Z`: an instant,
 * on the previous day, for a value that was never an instant.
 *
 * ## Why the zone is the whole test
 *
 * East of UTC, local midnight is the previous UTC day — at Asia/Tokyo (UTC+9,
 * no DST) by fifteen hours, the largest and simplest version of it. On a UTC
 * host the broken and the correct expression agree on every input and every
 * assertion below passes against unfixed code. Setting `process.env.TZ` moves
 * the process's zone for real: Node re-reads it, and so does node-postgres when
 * it parses OID 1082 into a Date. Restored afterwards because vitest may reuse
 * this worker for another file, and a leaked TZ would silently re-judge its
 * date assertions.
 *
 * The premise is asserted first, so a host or a driver that stops behaving this
 * way fails loudly here rather than turning the rest of the file into decoration.
 */
const REAL_TZ = process.env.TZ;
process.env.TZ = 'Asia/Tokyo';

const dbUp = await isDbAvailable();

/**
 * The `date` columns in the schema, and where each one is turned into its day.
 *
 * Kept as a list, and checked against `information_schema` below, because the
 * bug is not that these fifteen were wrong — they have been fixed — but that a
 * sixteenth can be added without anyone deciding how it serializes. A new
 * `date` column fails the census until it is listed here with an answer.
 */
const DATE_COLUMNS: Record<string, string> = {
  'funding_rounds.closed_on': 'repos/transactions.ts round()',
  'valuation_transactions.occurred_on': 'repos/transactions.ts txn()',
  'valuation_params.inception_date': 'repos/params.ts hydrated()',
  'valuation_params.fiscal_year_end': 'repos/params.ts hydrated()',
  'valuation_params.exit_timeline': 'repos/params.ts hydrated()',
  'valuation_params.last_round_date': 'repos/params.ts hydrated()',
  'company_profiles.founded_on': 'repos/companyProfiles.ts — cast in the SELECT',
  'option_grants.grant_date': 'repos/grants.ts hydrated()',
  'option_grants.vesting_start_date': 'repos/grants.ts hydrated()',
  'fund_marks.measurement_date': 'repos/funds.ts mark()',
  'board_resolutions.valuation_date': 'repos/boardApprovals.ts resolution()',
  'debt_valuations.valuation_date': 'repos/debtInstruments.ts debtValuation()',
  'volatility_estimates.window_start': 'routes/volatility.ts present() → isoDate',
  'volatility_estimates.window_end': 'routes/volatility.ts present() → isoDate',
  'rollforward_runs.prior_valuation_date': 'routes/rollforward.ts present() → calendarDate',
  'rollforward_runs.new_valuation_date': 'routes/rollforward.ts present() → calendarDate',
};

/**
 * A day chosen to be unambiguous in the failure: the last of a month, so an
 * off-by-one crosses into a different month as well as a different day, and far
 * enough out that no fixture or default could produce it by accident.
 */
const DAY = '2029-06-30';
const DAY_BEFORE = '2029-06-29';

/** The `YYYY-MM-DD` a caller reads by taking the first ten characters. */
const sliced = (v: unknown): string => String(v).slice(0, 10);

describe.skipIf(!dbUp)('`date` columns leave the API as days, not instants', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer', 'ops_admin'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'DateColumnCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (REAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = REAL_TZ;
  });

  it('is running east of UTC, where the bug exists at all', () => {
    // Not an assertion about our code — about the premise. `new Date(y, m, d)`
    // is what pg-types builds for a `date`, and its UTC day is the day before.
    expect(new Date(2029, 5, 30).toISOString().slice(0, 10)).toBe(DAY_BEFORE);
    expect(new Date().getTimezoneOffset()).toBeLessThan(0);
  });

  it('has an answer on file for every `date` column in the schema', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'date'
        ORDER BY table_name, column_name`,
    );
    const found = rows.map((r) => `${r.table_name}.${r.column_name}`);
    // Both directions: an unlisted column is one nobody decided about, and a
    // listed column that no longer exists is a stale entry pretending to cover
    // something.
    expect(found.sort()).toEqual(Object.keys(DATE_COLUMNS).sort());
  });

  it('a transaction round-trips its `occurred_on`', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/transactions`,
      headers: authHeader(ops.token),
      payload: { kind: 'secondary_sale', occurred_on: DAY, shares: 100 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().transaction.occurred_on).toBe(DAY);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/transactions`,
      headers: authHeader(ops.token),
    });
    expect(listed.json().transactions[0].occurred_on).toBe(DAY);
  });

  it('a funding round round-trips its `closed_on`, on create, update and list', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/rounds`,
      headers: authHeader(ops.token),
      payload: { name: 'Series B', closed_on: DAY },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().round.closed_on).toBe(DAY);
    const roundId = created.json().round.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/rounds/${roundId}`,
      headers: authHeader(ops.token),
      payload: { closed_on: DAY },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().round.closed_on).toBe(DAY);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/rounds`,
      headers: authHeader(ops.token),
    });
    expect(listed.json().rounds[0].closed_on).toBe(DAY);
  });

  it('a grant round-trips both of its dates', async () => {
    // Written through the repo rather than POST /grants, which refuses until
    // the board has approved the 409A — a precondition this file has no
    // interest in and the resolution below does not satisfy on its own.
    const created = await createGrant(
      pool,
      {
        valuationId,
        granteeName: 'A. Grantee',
        grantDate: DAY,
        optionsCount: 1000,
        exercisePrice: 1.25,
        currency: 'USD',
        vestingTemplate: '4y_1y_cliff',
        vestingStartDate: DAY,
        vestingMonths: 48,
        cliffMonths: 12,
        frequencyMonths: 1,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    expect(created.grant_date).toBe(DAY);
    expect(created.vesting_start_date).toBe(DAY);

    const { grants } = await listGrants(pool, valuationId);
    expect(grants[0]?.grant_date).toBe(DAY);
    expect(grants[0]?.vesting_start_date).toBe(DAY);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
    });
    expect(listed.statusCode).toBe(200);
    expect(sliced(listed.json().grants[0].grant_date)).toBe(DAY);
    expect(sliced(listed.json().grants[0].vesting_start_date)).toBe(DAY);
  });

  it('the params row round-trips all four of its dates', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: {
        inception_date: DAY,
        fiscal_year_end: DAY,
        exit_timeline: DAY,
        last_round_date: DAY,
      },
    });
    expect(patched.statusCode).toBe(200);
    for (const field of ['inception_date', 'fiscal_year_end', 'exit_timeline', 'last_round_date']) {
      expect(patched.json().params[field], field).toBe(DAY);
    }

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
    });
    for (const field of ['inception_date', 'fiscal_year_end', 'exit_timeline', 'last_round_date']) {
      expect(sliced(read.json().params[field]), field).toBe(DAY);
    }
  });

  /**
   * The same mismatch, in the audit trail rather than the response.
   *
   * `patchParams` diffs the stored row against the request body with `===`, and
   * no Date is ever equal to a `YYYY-MM-DD` string. Re-saving a form without
   * touching its dates therefore recorded four field changes that did not
   * happen — from an ISO instant, to the day it already held.
   */
  it('re-saving the same dates records no change', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/events`,
      headers: authHeader(ops.token),
    });
    const countBefore = before
      .json()
      .events.filter((e: { type: string }) => e.type === 'params_updated').length;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: {
        inception_date: DAY,
        fiscal_year_end: DAY,
        exit_timeline: DAY,
        last_round_date: DAY,
      },
    });

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/events`,
      headers: authHeader(ops.token),
    });
    const countAfter = after
      .json()
      .events.filter((e: { type: string }) => e.type === 'params_updated').length;
    expect(countAfter).toBe(countBefore);
  });

  it('a company profile round-trips its `founded_on`', async () => {
    await upsertCompanyProfile(
      pool,
      valuationId,
      { legal_name: 'DateColumnCo, Inc.', founded_on: DAY },
      { actorType: 'human', actorId: ops.id },
    );
    const profile = await findCompanyProfile(pool, valuationId);
    expect(profile?.founded_on).toBe(DAY);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/company-profile`,
      headers: authHeader(ops.token),
    });
    expect(sliced(res.json().profile.founded_on)).toBe(DAY);
  });

  it("a fund mark round-trips its `measurement_date`, on read and on the NAV roll-up's latest", async () => {
    const fund = await createFund(pool, {
      name: 'Date Fund I',
      fundType: 'vc',
      currency: 'USD',
      vintageYear: 2029,
      createdBy: ops.id,
    });
    const position = await createPosition(pool, {
      fundId: fund.id,
      companyName: 'Held Co',
      securityType: 'preferred',
      quantity: 100,
      costBasis: 1000,
      markMethod: 'market',
    });
    const created = await createMark(pool, {
      positionId: position.id,
      measurementDate: DAY,
      method: 'market',
      fairValue: 2000,
      level: 1,
      inputs: null,
      createdBy: ops.id,
    });
    expect(created.measurement_date).toBe(DAY);

    const marks = await listMarks(pool, position.id);
    expect(marks[0]?.measurement_date).toBe(DAY);
    expect((await latestMarks(pool, fund.id)).get(position.id)?.measurement_date).toBe(DAY);

    // The shape the two `reply.send({ mark })` sites in routes/funds.ts put on
    // the wire — the leak this test was written for.
    expect(JSON.parse(JSON.stringify(created)).measurement_date).toBe(DAY);
  });

  it('a debt valuation round-trips its `valuation_date`', async () => {
    const instrument = await createInstrument(pool, {
      name: 'Note 2029',
      instrumentType: 'bond',
      currency: 'USD',
      params: { face: 1000 },
      createdBy: ops.id,
    });
    const created = await createValuation(pool, {
      instrumentId: instrument.id,
      valuationDate: DAY,
      inputs: {},
      result: {},
      fairValue: 980.5,
      createdBy: ops.id,
    });
    expect(created.valuation_date).toBe(DAY);
    expect((await listValuations(pool, instrument.id))[0]?.valuation_date).toBe(DAY);
  });

  it('a board resolution round-trips its `valuation_date`', async () => {
    const created = await upsertResolution(
      pool,
      {
        valuationId,
        valuationDate: DAY,
        fmvConclusion: 3.5,
        currency: 'USD',
        methodologySummary: 'OPM',
        appraiserQualifications: 'ASA',
        bodyHtml: '<p>Resolved.</p>',
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    expect(created.valuation_date).toBe(DAY);
    expect((await findResolutionByValuation(pool, valuationId))?.valuation_date).toBe(DAY);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
    });
    expect(sliced(res.json().resolution.valuation_date)).toBe(DAY);
  });

  it('a volatility estimate presents both ends of its window', async () => {
    await insertVolatilityEstimate(pool, {
      valuationId,
      method: 'historical',
      periodsPerYear: 252,
      windowStart: '2028-06-30',
      windowEnd: DAY,
      timeToExitYears: 3,
      recommended: 0.55,
      medianVol: 0.55,
      meanVol: 0.55,
      minVol: 0.4,
      maxVol: 0.7,
      coefficientOfVariation: 0.1,
      confidence: 'medium',
      manualOverride: null,
      companies: [],
      excluded: [],
      createdBy: ops.id,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/volatility`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const estimate = res.json().estimates[0];
    expect(estimate.window_start).toBe('2028-06-30');
    expect(estimate.window_end).toBe(DAY);
  });

  it('a roll-forward run presents both of its valuation dates', async () => {
    const prior = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'DateColumnCo' },
    });
    const priorId = prior.json().valuation.id;
    const calculation = await createCalculation(
      pool,
      {
        valuationId: priorId,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3.5 },
        equityValue: 35_000_000,
        fmvPerShare: 3.5,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    await insertRollforwardRun(pool, {
      valuationId,
      priorValuationId: priorId,
      priorCalculationId: calculation.id,
      priorValuationNumber: null,
      priorValuationDate: '2028-06-30',
      newValuationDate: DAY,
      yearsElapsed: 1,
      priorEquityValue: 35_000_000,
      rolledEquityValue: 38_000_000,
      annualAccretion: 0.08,
      newRoundPostMoney: null,
      calibrationSteps: [],
      materialChanges: [],
      requiresFullRevaluation: false,
      prePopulatedInputs: {},
      createdBy: ops.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/rollforward`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const run = res.json().runs[0];
    expect(run.prior_valuation_date).toBe('2028-06-30');
    expect(run.new_valuation_date).toBe(DAY);
  });
});
