import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

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
});
