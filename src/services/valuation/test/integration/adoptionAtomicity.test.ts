import Fastify from 'fastify';
import { newUlid } from '@n409/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Adopting a derived figure is several writes, and they have to be one decision
 * (R404, methodology M5).
 *
 * `POST /volatility/:estimateId/apply` writes three things: the override
 * registry (`overwrites`), the engine input the calculation actually reads
 * (`valuation_params.engine_inputs.volatility`), and the estimate's own
 * `applied_at`, which is what `findVolatilityEstimate` reports as the adopted
 * run. Each was a statement on the pool in its own transaction.
 *
 * A failure between the first and the second is the exact state the route's own
 * doc-comment says the route exists to prevent — "adopting a derived sigma
 * moved a number on the volatility screen and moved nothing else… The screen
 * said 64.0% was applied; the allocation ran on 65.0%" — and the caller is
 * answered with an error that says the adoption did not happen.
 *
 * The failure driven here is the reachable one rather than an injected fault:
 * `applyEngineInputs` raises 404 when the engagement's params row is gone,
 * which is what a purge landing mid-request looks like. What is asserted is not
 * the status — that was always an error — but what the database holds
 * afterwards.
 */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/market-feed', async () => ({
    source: 'fallback',
    warning: 'yfinance is not installed; returning the caller fallback',
  }));
  // engine/projection.py, in the one mode these tests strike a run in.
  stub.post('/engine/v1/rollforward', async () => ({
    prior_valuation_date: '2025-06-30',
    new_valuation_date: '2026-06-30',
    years_elapsed: 1.0,
    prior_equity_value: 33_600_000,
    rolled_equity_value: 42_000_000,
    annual_accretion: 0.25,
    calibration_steps: [{ step: 'prior_equity_value', value: 33_600_000 }],
    material_changes: [],
    requires_full_revaluation: false,
    // No round price for the new date, so adoption supersedes the one on file —
    // which is the write this route makes that cannot be undone.
    pre_populated_inputs: { valuation_date: '2026-06-30', last_round_post_money: 42_000_000 },
  }));
  stub.post('/engine/v1/projection', async (req) => {
    const { inputs } = req.body as { inputs: Record<string, unknown> };
    const years = Number(inputs.years ?? 1);
    const base = Number(inputs.base_revenue);
    const projections = Array.from({ length: years }, (_, i) => {
      const revenue = base * 1.2 ** (i + 1);
      return {
        year: i + 1,
        revenue,
        cogs: revenue * 0.4,
        opex: revenue * 0.3,
        ebitda: revenue * 0.3,
        da: revenue * 0.05,
        ebit: revenue * 0.25,
        nopat: revenue * 0.25 * 0.79,
        capex: revenue * 0.06,
        delta_nwc: 0,
        fcff: revenue * 0.2,
      };
    });
    return {
      method: 'growth',
      years,
      tax_rate: 0.21,
      projections,
      free_cash_flows: projections.map((p) => p.fcff),
      terminal_method: null,
      terminal_value: null,
    };
  });
  stub.post('/engine/v1/volatility', async (req) => {
    const body = req.body as { manual_override?: number };
    return {
      method: 'manual',
      recommended_volatility: body.manual_override ?? 0.5,
      manual_override: body.manual_override ?? 0.5,
      confidence: 'manual',
      companies: [],
      excluded_companies: [],
    };
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('an adoption lands whole or not at all (R404)', () => {
  let ctx: TestApp;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    ops = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  async function newValuation(): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'SigmaCo' },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().valuation.id as string;
  }

  async function estimateFor(valuationId: string, override: number): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/estimate`,
      headers: authHeader(ops.token),
      payload: { manual_override: override },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().estimate.id as string;
  }

  const apply = (valuationId: string, estimateId: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/volatility/${estimateId}/apply`,
      headers: authHeader(ops.token),
      payload: {},
    });

  it('adopts all three of the writes on the ordinary path', async () => {
    const valuationId = await newValuation();
    const estimateId = await estimateFor(valuationId, 0.64);

    const res = await apply(valuationId, estimateId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().applied_volatility).toBeCloseTo(0.64, 10);
    // The estimate the response carries is the re-read one, so `applied_at`
    // being set is what says the third write landed on the same row.
    expect(res.json().estimate.applied_at).not.toBeNull();

    const { rows: overrides } = await ctx.pool.query(
      `SELECT value FROM overwrites WHERE valuation_id = $1 AND field_key = 'volatility'`,
      [valuationId],
    );
    expect(overrides).toHaveLength(1);
    expect(Number(overrides[0]!.value)).toBeCloseTo(0.64, 10);

    const { rows: params } = await ctx.pool.query<{ volatility: string | null }>(
      `SELECT engine_inputs->>'volatility' AS volatility FROM valuation_params WHERE valuation_id = $1`,
      [valuationId],
    );
    expect(Number(params[0]!.volatility)).toBeCloseTo(0.64, 10);
  });

  it('leaves no override behind when the engine-input half of the adoption cannot be written', async () => {
    const valuationId = await newValuation();
    const estimateId = await estimateFor(valuationId, 0.64);

    // The params row is what `applyEngineInputs` writes; without it that write
    // raises, which is the shape of a purge landing mid-request.
    await ctx.pool.query('DELETE FROM valuation_params WHERE valuation_id = $1', [valuationId]);

    const res = await apply(valuationId, estimateId);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    /*
     * The override registry is the surface the analyst reads as "this is the
     * figure imposed on this engagement", and the panel answers
     * `applied_volatility` from it. A row here after a refused adoption says a
     * sigma was adopted that the engine has never been told about, on an
     * engagement whose stored calculation was struck on the old one — and
     * nothing anywhere would say so, because the caller was told the adoption
     * failed.
     */
    const { rows: overrides } = await ctx.pool.query(
      `SELECT value FROM overwrites WHERE valuation_id = $1 AND field_key = 'volatility'`,
      [valuationId],
    );
    expect(overrides).toHaveLength(0);

    // And the estimate is still unadopted, so the history does not name a run
    // the engagement is not carrying.
    const { rows: estimates } = await ctx.pool.query<{ applied_at: Date | null }>(
      'SELECT applied_at FROM volatility_estimates WHERE id = $1',
      [estimateId],
    );
    expect(estimates[0]!.applied_at).toBeNull();

    // Nor is there an `overwrite_applied` event claiming the change: the event
    // is written inside the same transaction as the row it describes.
    const { rows: events } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM valuation_events
        WHERE valuation_id = $1 AND type = 'overwrite_applied'`,
      [valuationId],
    );
    expect(events[0]!.n).toBe('0');
  });

  /*
   * The projection adoption is the same shape one route over, with two writes
   * rather than three: `applyEngineInputs` carries the forecast into
   * `engine_inputs.income`, and `markProjectionApplied` is the only writer of
   * the column that says which run the engagement is carrying.
   *
   * The failure is injected here rather than driven, because there is no
   * reachable way to fail the second write on its own — the UPDATE names a row
   * the handler has just read and does not check its own row count. What is
   * being asserted is the same thing either way: the state the database is left
   * in when the caller is told the adoption did not happen.
   */
  describe('a projection adoption', () => {
    async function runProjection(valuationId: string): Promise<string> {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/projection/run`,
        headers: authHeader(ops.token),
        payload: {
          method: 'growth',
          years: 5,
          base_revenue: 1_000_000,
          revenue_growth: 0.2,
          cogs_pct: 0.4,
          opex_pct: 0.3,
          da_pct: 0.05,
          capex_pct: 0.06,
          nwc_pct: 0.1,
          tax_rate: 0.21,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().projection.id as string;
    }

    const adopt = (valuationId: string, projectionId: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/projection/${projectionId}/apply`,
        headers: authHeader(ops.token),
        payload: {},
      });

    const storedIncome = async (valuationId: string) => {
      const { rows } = await ctx.pool.query<{ income: string | null }>(
        `SELECT engine_inputs->'income' AS income FROM valuation_params WHERE valuation_id = $1`,
        [valuationId],
      );
      return rows[0]!.income;
    };

    it('carries the forecast and the applied stamp together on the ordinary path', async () => {
      const valuationId = await newValuation();
      const projectionId = await runProjection(valuationId);

      const res = await adopt(valuationId, projectionId);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().projection.applied_at).not.toBeNull();
      expect(await storedIncome(valuationId)).not.toBeNull();
    });

    it('leaves the engagement on its previous forecast when the applied stamp cannot be written', async () => {
      const valuationId = await newValuation();
      const projectionId = await runProjection(valuationId);
      const before = await storedIncome(valuationId);

      const restore = interceptPoolQueries(ctx.pool, (sql) => {
        if (sql.includes('UPDATE valuation_projections')) {
          throw new Error('staged failure on the applied stamp');
        }
        return undefined;
      });
      try {
        const res = await adopt(valuationId, projectionId);
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        restore();
      }

      // `engine_inputs.income` is what the DCF reads. Carrying this run's cash
      // flows while `applied_at` names no run — after a response that said the
      // adoption failed — is a forecast in the valuation that no history
      // accounts for.
      expect(await storedIncome(valuationId)).toEqual(before);
      const { rows } = await ctx.pool.query<{ applied_at: Date | null }>(
        'SELECT applied_at FROM valuation_projections WHERE id = $1',
        [projectionId],
      );
      expect(rows[0]!.applied_at).toBeNull();
    });
  });

  /*
   * The roll-forward adoption is the widest of the three: it moves the
   * engagement's backsolve anchor, *deletes* the round price, share class and
   * market-movement adjustment the rolled value supersedes, sets
   * `rolling_forward`, and stamps the run's `applied_at`. Four writes over
   * three rows, and `applied_at` is what Exhibit B-2 states the bridge from.
   */
  describe('a roll-forward adoption', () => {
    const PRIOR_INPUTS = {
      valuation_date: '2026-06-30',
      revenue: 6_240_000,
      last_round_post_money: 30_000_000,
      last_round_price_per_share: 1.25,
      last_round_class: 'Series A',
      market_movement: { index_start: 100, index_end: 120 },
    };

    /** This year's engagement with last year's on file behind it. */
    async function pair(): Promise<{ currentId: string; runId: string }> {
      const priorId = await newValuation();
      await ctx.pool.query(
        `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, results)
         VALUES ($1, $2, 'test', 'succeeded', $3::jsonb, $4::jsonb)`,
        [
          newUlid(),
          priorId,
          JSON.stringify({ params: {}, inputs: { valuation_date: '2025-06-30', revenue: 6_000_000 } }),
          JSON.stringify({ equity_value: 33_600_000 }),
        ],
      );
      const currentId = await newValuation();
      await ctx.pool.query(
        'UPDATE valuation_params SET engine_inputs = $2::jsonb WHERE valuation_id = $1',
        [currentId, JSON.stringify(PRIOR_INPUTS)],
      );
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${currentId}/rollforward`,
        headers: authHeader(ops.token),
        payload: { prior_valuation_id: priorId },
      });
      expect(res.statusCode, res.body).toBe(201);
      return { currentId, runId: res.json().run.id as string };
    }

    const adopt = (currentId: string, runId: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${currentId}/rollforward/${runId}/apply`,
        headers: authHeader(ops.token),
      });

    const paramsOf = async (valuationId: string) => {
      const { rows } = await ctx.pool.query<{
        engine_inputs: Record<string, unknown>;
        rolling_forward: boolean;
      }>('SELECT engine_inputs, rolling_forward FROM valuation_params WHERE valuation_id = $1', [
        valuationId,
      ]);
      return rows[0]!;
    };

    it('moves the anchor, the flag and the stamp together on the ordinary path', async () => {
      const { currentId, runId } = await pair();

      const res = await adopt(currentId, runId);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().run.applied_at).not.toBeNull();

      const params = await paramsOf(currentId);
      expect(params.engine_inputs.last_round_post_money).toBe(42_000_000);
      expect(params.engine_inputs.last_round_price_per_share).toBeNull();
      expect(params.rolling_forward).toBe(true);
    });

    it('leaves the anchor and the superseded inputs alone when the stamp cannot be written', async () => {
      const { currentId, runId } = await pair();

      const restore = interceptPoolQueries(ctx.pool, (sql) => {
        if (sql.includes('UPDATE rollforward_runs')) {
          throw new Error('staged failure on the applied stamp');
        }
        return undefined;
      });
      try {
        const res = await adopt(currentId, runId);
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        restore();
      }

      /*
       * The clears are the half that cannot be walked back by hand: nothing
       * else on the engagement holds last year's round price once this route
       * has removed it. A 500 that says the adoption failed, over an anchor
       * that moved and a price that is gone, is the report this round exists
       * to stop.
       */
      const params = await paramsOf(currentId);
      expect(params.engine_inputs.last_round_post_money).toBe(30_000_000);
      expect(params.engine_inputs.last_round_price_per_share).toBe(1.25);
      expect(params.engine_inputs.last_round_class).toBe('Series A');
      expect(params.engine_inputs.market_movement).toEqual({ index_start: 100, index_end: 120 });
      expect(params.rolling_forward).toBe(false);

      const { rows } = await ctx.pool.query<{ applied_at: Date | null }>(
        'SELECT applied_at FROM rollforward_runs WHERE id = $1',
        [runId],
      );
      expect(rows[0]!.applied_at).toBeNull();
    });
  });
});
