import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

/**
 * The per-engagement network log (409.ai §11, "Network Items").
 *
 * The property that makes this table worth its weight is that it holds the
 * calls no result table can: a `calculations` row exists only when the engine
 * answered, a `market_research` row only when synthesis succeeded. The 422, the
 * timeout and the retry are recorded here and nowhere else, so most of what
 * follows is about the failure paths rather than the happy one.
 *
 * The other property under test is that recording is *subordinate* — it must
 * never change a status code, a stored figure, or an upstream error message.
 */

const dbUp = await isDbAvailable();

/** Engine stub whose behaviour each test dictates through `state`. */
async function startEngineStub(state: { mode: 'ok' | 'reject' | 'hang' | 'garbage' }) {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/compute', async (req, reply) => {
    if (state.mode === 'reject') {
      return reply.status(422).send({
        detail: 'weighted equity value is not positive',
        issues: [],
      });
    }
    if (state.mode === 'garbage') {
      return reply.header('content-type', 'application/json').send('<html>gateway error</html>');
    }
    if (state.mode === 'hang') {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return reply.send({
      engine_version: 'py-stub',
      results: {
        equity_value: 12_000_000,
        fmv_per_share: 1.2,
        approaches: { income: { equity_value: 12_000_000, weight: 1 } },
      },
      warnings: [],
      trace: [],
    });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('network items', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let otherValuationId: string;

  const state = { mode: 'ok' as 'ok' | 'reject' | 'hang' | 'garbage' };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    engineStub = await startEngineStub(state);

    app = buildApp({
      config: loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        JWT_SECRET: 'integration-test-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        ENGINE_URL: engineStub.url,
      }),
      pool,
    });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });

    const create = async (name: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: name },
      });
      const id = res.json().valuation.id as string;
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${id}/params`,
        headers: authHeader(ops.token),
        payload: { weight_income: 1, weight_asset: 0, weight_opm: 0, weight_market: 0, dlom: 0.25 },
      });
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${id}/engine-inputs`,
        headers: authHeader(ops.token),
        payload: {
          shares_outstanding_common: 8_000_000,
          income: { free_cash_flows: [1e6, 2e6], discount_rate: 0.25, terminal_growth: 0.03 },
        },
      });
      return id;
    };
    valuationId = await create('NetlogCo');
    otherValuationId = await create('OtherCo');
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  const compute = (id = valuationId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/calculations`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const list = (query = '', token = ops.token, id = valuationId) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/network-items${query}`,
      headers: authHeader(token),
    });

  /**
   * The sink is deliberately not awaited on the request path, so a row can land
   * a tick or two after the response. Polling beats an arbitrary sleep: it is
   * both faster in the normal case and not flaky on a loaded machine.
   */
  const waitForItems = async (min: number, id = valuationId) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const body = (await list('', ops.token, id)).json();
      if (body.items.length >= min) return body;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`network items never reached ${min}`);
  };

  it('records a successful engine call with its payloads, status and duration', async () => {
    state.mode = 'ok';
    await compute();
    const body = await waitForItems(1);

    const item = body.items[0];
    expect(item.service).toBe('engine');
    expect(item.name).toBe('engine compute');
    expect(item.status).toBe(200);
    expect(item.error).toBeNull();
    expect(item.duration_ms).toBeGreaterThanOrEqual(0);

    // The list omits the payloads — they are the weight of the table.
    expect(item.request).toBeUndefined();
    expect(item.response).toBeUndefined();

    const detail = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/network-items/${item.id}`,
        headers: authHeader(ops.token),
      })
    ).json();
    expect(detail.item.request.inputs.shares_outstanding_common).toBe(8_000_000);
    expect(detail.item.response.results.fmv_per_share).toBe(1.2);
  });

  describe('the calls no result table holds', () => {
    it('records a rejected call, which leaves no calculation behind to explain it', async () => {
      state.mode = 'reject';
      const before = (await list()).json().total;
      const res = await compute();
      expect(res.statusCode).toBe(422);

      const body = await waitForItems(before + 1);
      const item = body.items[0];
      expect(item.status).toBe(422);
      expect(item.error).toContain('not positive');

      // And the upstream's own words survive to be re-read later, rather than
      // only the summary we turned into a client-facing problem.
      const detail = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${valuationId}/network-items/${item.id}`,
          headers: authHeader(ops.token),
        })
      ).json();
      expect(detail.item.response.detail).toContain('not positive');
    });

    it('records an unparseable body as the raw text it actually was', async () => {
      state.mode = 'garbage';
      const before = (await list()).json().total;
      await compute();

      const body = await waitForItems(before + 1);
      const item = body.items[0];
      expect(item.error).toBe('invalid JSON in response body');
      const detail = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/valuations/${valuationId}/network-items/${item.id}`,
          headers: authHeader(ops.token),
        })
      ).json();
      expect(detail.item.response).toContain('gateway error');
    });
  });

  it('recording never changes the answer the caller gets', async () => {
    // The whole feature is subordinate: an engine that rejects must still
    // produce a 422 naming the engine's reason, not a logging error.
    state.mode = 'reject';
    const res = await compute();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('engine');

    state.mode = 'ok';
    const ok = await compute();
    expect(ok.statusCode).toBe(201);
    // A string: `fmv_per_share` is numeric, which pg hands back unparsed so no
    // per-share figure ever passes through a float. Asserted as it is stored.
    expect(Number(ok.json().calculation.fmv_per_share)).toBe(1.2);
  });

  it('counts every tier, including the ones not being filtered to', async () => {
    state.mode = 'ok';
    await compute();
    const body = await waitForItems(1);
    expect(body.counts.engine).toBeGreaterThan(0);

    // A filter narrows the rows but not the tab counts, which have to say what
    // the other tabs hold.
    const filtered = (await list('?service=engine')).json();
    expect(filtered.items.every((i: { service: string }) => i.service === 'engine')).toBe(true);
    expect(filtered.counts).toEqual(body.counts);

    const none = (await list('?service=ai')).json();
    expect(none.items).toHaveLength(0);
    expect(none.total).toBe(0);
    // Still reports what engine holds, so the tab strip does not collapse.
    expect(none.counts.engine).toBeGreaterThan(0);
  });

  it('reports the true total on a page past the end, not zero', async () => {
    state.mode = 'ok';
    await compute();
    const first = await waitForItems(1);
    const far = (await list('?page=500')).json();
    expect(far.items).toHaveLength(0);
    // The reflex `count(*) OVER ()` rides on the returned rows and would say 0
    // here — telling a reader who paged one step too far that the log is empty.
    expect(far.total).toBe(first.total);
  });

  it('keeps one engagement’s calls out of another’s log', async () => {
    state.mode = 'ok';
    await compute(otherValuationId);
    const other = await waitForItems(1, otherValuationId);
    const mine = (await list()).json();
    const otherIds = new Set(other.items.map((i: { id: string }) => i.id));
    expect(mine.items.some((i: { id: string }) => otherIds.has(i.id))).toBe(false);

    // And an id from one engagement cannot be read through the other's URL.
    const crossed = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/network-items/${other.items[0].id}`,
      headers: authHeader(ops.token),
    });
    expect(crossed.statusCode).toBe(404);
  });

  it('is operations-only — the payloads are the engine’s working state', async () => {
    const res = await list('', client.token);
    expect(res.statusCode).toBe(403);
  });

  it('404s an item id that is not a ULID rather than reaching SQL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/network-items/not-a-ulid`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(404);
  });
});
