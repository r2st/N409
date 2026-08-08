import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What the market approach is actually handed (design §4.5).
 *
 * The precedence rule under test: a persisted peer set wins over the AI job's
 * summarised multiples, and an engagement with no peer set computes exactly as
 * it did before `comparable_items` existed. A new empty table that silently
 * changed what an untouched valuation computes would be the worst possible
 * outcome of this feature.
 */

/** Engine stub that records the compute payload it was handed. */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  let lastPayload: { inputs?: Record<string, unknown> } = {};
  stub.get('/engine/v1/health', async () => ({ engine_version: 'stub-1' }));
  stub.post('/engine/v1/compute', async (req) => {
    lastPayload = req.body as { inputs?: Record<string, unknown> };
    return {
      engine_version: 'stub-1',
      results: { equity_value: 10_000_000, fmv_per_share: 1.0, approaches: {} },
      warnings: [],
    };
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    market: () => (lastPayload.inputs as { market?: { multiples?: number[] } } | undefined)?.market ?? {},
  };
}

describe.skipIf(!dbUp)('peer set → market approach', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const compute = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const addPeer = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
      payload,
    });

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'MultiplesCo' },
    });
    valuationId = created.json().valuation.id;

    // The AI comp-selection job as the pipeline leaves it: the summarised
    // multiples that were the only source before this feature.
    await pool.query(
      `INSERT INTO ai_jobs (id, valuation_id, pipeline, input, status, result, completed_at)
       VALUES ($1, $2, 'comparables', '{}'::jsonb, 'succeeded', $3::jsonb, now())`,
      [
        newUlid(),
        valuationId,
        JSON.stringify({
          comparables: [
            { revenue_multiple: 3.0, ebitda_multiple: 8.0 },
            { revenue_multiple: 4.0, ebitda_multiple: 9.0 },
          ],
        }),
      ],
    );
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  it('falls back to the AI aggregate when nothing has been screened', async () => {
    const res = await compute();
    expect(res.statusCode).toBe(201);
    expect(engine.market().multiples).toEqual([3.0, 4.0]);
  });

  it('prefers the persisted peer set once it has rows', async () => {
    await addPeer({ ticker: 'AAA', name: 'Alpha', ev: 1_000, revenue_ltm: 100 }); // 10x
    await addPeer({ ticker: 'BBB', name: 'Beta', ev: 1_400, revenue_ltm: 100 }); // 14x

    const res = await compute();
    expect(res.statusCode).toBe(201);
    expect(engine.market().multiples).toEqual([10, 14]);
  });

  it('drops an excluded comp from what the engine is handed', async () => {
    const rows = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comparables`,
        headers: authHeader(ops.token),
      })
    ).json().comparables as Array<{ id: string; ticker: string }>;
    const beta = rows.find((r) => r.ticker === 'BBB')!;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/comparables/${beta.id}`,
      headers: authHeader(ops.token),
      payload: { included: false, exclude_reason: 'different growth profile' },
    });

    const res = await compute();
    expect(res.statusCode).toBe(201);
    // An excluded comp that still moved the median would be an exclusion that
    // did not happen, and the reason recorded against it a false statement.
    expect(engine.market().multiples).toEqual([10]);
  });

  it('falls back again rather than sending an empty list the engine would reject', async () => {
    // Switch the engagement to an EBITDA multiple, which no stored peer has:
    // `market.multiples must contain at least one positive multiple` would fail
    // the whole calculation over a peer set that simply lacks that leg.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { market_method: 'ebitda' },
    });

    const res = await compute();
    expect(res.statusCode).toBe(201);
    expect(engine.market().multiples).toEqual([8.0, 9.0]);
  });
});
