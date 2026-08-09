import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

/**
 * The calculation step inspector (409.ai gap §1.3).
 *
 * `calculations` has always held the two ends of an engine run — the exact
 * payload posted and the document returned — and nothing of the middle. This
 * endpoint serves all three, and the tests below are about the properties that
 * make the middle worth having rather than about the plumbing:
 *
 *  * the trace is persisted from the run itself, never re-derived later;
 *  * it does not appear anywhere it would be paid for and unread;
 *  * a *failed* run keeps its steps, which is the case an inspector exists for;
 *  * an old run says it has no trace rather than looking like a broken one.
 */

const dbUp = await isDbAvailable();

/** The steps a real engine emits, in the shape `engine/trace.py` writes them. */
const STEPS = [
  {
    seq: 1,
    key: 'approach.asset',
    label: 'Asset approach',
    status: 'skipped',
    inputs: { weight: 0 },
    outputs: null,
    note: 'zero weight — excluded from the conclusion',
    elapsed_ms: 0.01,
  },
  {
    seq: 2,
    key: 'approach.income',
    label: 'Income approach (DCF)',
    status: 'computed',
    inputs: { weight: 1, discount_rate: 0.25 },
    outputs: { equity_value: 12_000_000 },
    note: null,
    elapsed_ms: 0.4,
  },
  {
    seq: 3,
    key: 'weighting',
    label: 'Weighted equity value',
    status: 'computed',
    inputs: {
      terms: [{ approach: 'income', equity_value: 12_000_000, weight: 1, contribution: 12_000_000 }],
    },
    outputs: { equity_value: 12_000_000 },
    note: null,
    elapsed_ms: 0.5,
  },
];

/**
 * Engine stub that records what it was asked for. The `trace` flag on the
 * request is itself under test: the valuation service must set it on every run,
 * because the run worth inspecting is always one that already happened.
 */
async function startEngineStub(state: { fail: boolean; lastPayload: Record<string, unknown> | null }) {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/compute', async (req, reply) => {
    state.lastPayload = req.body as Record<string, unknown>;
    if (state.fail) {
      return reply.status(422).send({
        detail: 'weighted equity value is not positive',
        issues: [
          {
            code: 'not_positive',
            field: 'results.equity_value',
            message: 'weighted equity value is not positive',
            severity: 'error',
            hint: null,
          },
        ],
      });
    }
    return reply.send({
      engine_version: 'py-stub',
      results: {
        equity_value: 12_000_000,
        fmv_per_share: 1.2,
        approaches: { income: { equity_value: 12_000_000, weight: 1 } },
      },
      warnings: [],
      trace: STEPS,
    });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('calculation step inspector', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const state = { fail: false, lastPayload: null as Record<string, unknown> | null };

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

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'InspectorCo' },
    });
    valuationId = created.json().valuation.id;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { weight_income: 1, weight_asset: 0, weight_opm: 0, weight_market: 0, dlom: 0.25 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(ops.token),
      payload: {
        shares_outstanding_common: 8_000_000,
        income: { free_cash_flows: [1e6, 2e6], discount_rate: 0.25, terminal_growth: 0.03 },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  const compute = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const inspect = (calculationId: string, token = ops.token) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/calculations/${calculationId}`,
      headers: authHeader(token),
    });

  it('asks the engine to trace every run', async () => {
    // Not on request. A trace you have to opt into in advance is one you never
    // have when a reviewer finally disputes the number.
    state.fail = false;
    await compute();
    expect(state.lastPayload?.trace).toBe(true);
  });

  it('serves the request, the response and the steps between them', async () => {
    state.fail = false;
    const calcId = (await compute()).json().calculation.id as string;
    const body = (await inspect(calcId)).json();

    expect(body.traced).toBe(true);
    expect(body.steps.map((s: { key: string }) => s.key)).toEqual([
      'approach.asset',
      'approach.income',
      'weighting',
    ]);
    // The two ends, named for what they are — this is what someone
    // reproducing the run by hand copies.
    expect(body.request.params.weight_income).toBe(1);
    expect(body.response.fmv_per_share).toBe(1.2);
  });

  it('keeps the reason a stage produced nothing', async () => {
    // The distinction `results` structurally cannot make: a zero-weight
    // approach and one carried over from an earlier run are both simply
    // missing from `results.approaches`, and they mean opposite things.
    state.fail = false;
    const calcId = (await compute()).json().calculation.id as string;
    const steps = (await inspect(calcId)).json().steps as Array<{
      key: string;
      status: string;
      note: string | null;
    }>;
    const asset = steps.find((s) => s.key === 'approach.asset')!;
    expect(asset.status).toBe('skipped');
    expect(asset.note).toMatch(/zero weight/);
  });

  it('does not carry the trace in the calculation list', async () => {
    // The trace is the engine's whole working state for one run. Selecting it
    // into a list of twenty would ship all of it to a page that renders none
    // of it; `has_trace` is the one bit the list actually needs.
    state.fail = false;
    await compute();
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
    });
    const rows = list.json().calculations as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty('trace');
    expect(rows[0]!.has_trace).toBe(true);
  });

  it('keeps the steps of a run that failed, which is the case worth inspecting', async () => {
    // A rejected payload records a failed calculation. Whatever the engine got
    // through before it raised is exactly what says where the run died — and it
    // is the one situation where reading the result document tells you nothing,
    // because there is no result document.
    state.fail = true;
    const res = await compute();
    expect(res.statusCode).toBe(422);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
    });
    const failed = (list.json().calculations as Array<{ id: string; status: string }>).find(
      (c) => c.status === 'failed',
    )!;
    const body = (await inspect(failed.id)).json();
    expect(body.calculation.status).toBe('failed');
    expect(body.calculation.error).toMatch(/not positive/);
    // The engine returned no trace with its 422, so there is nothing to show —
    // and the flag says which kind of nothing this is.
    expect(body.traced).toBe(false);
    expect(body.steps).toEqual([]);
    state.fail = false;
  });

  it('says a pre-0126 run has no trace rather than looking broken', async () => {
    // Every calculation written before the column existed. An empty step list
    // with no explanation reads as a broken inspector rather than as history.
    state.fail = false;
    const calcId = (await compute()).json().calculation.id as string;
    await pool.query('UPDATE calculations SET trace = NULL WHERE id = $1', [calcId]);
    const body = (await inspect(calcId)).json();
    expect(body.traced).toBe(false);
    expect(body.steps).toEqual([]);
    // The two ends survive — they always existed.
    expect(body.response.fmv_per_share).toBe(1.2);
  });

  it('is operations-only, like every other calculation route', async () => {
    state.fail = false;
    const calcId = (await compute()).json().calculation.id as string;
    expect((await inspect(calcId, client.token)).statusCode).toBe(403);
  });

  it('will not serve another engagement’s run', async () => {
    // The id alone is unguessable, but "unguessable" is not an access rule.
    state.fail = false;
    const calcId = (await compute()).json().calculation.id as string;
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'OtherCo' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${other.json().valuation.id}/calculations/${calcId}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s a calculation id that is not a ULID', async () => {
    expect((await inspect('not-an-id')).statusCode).toBe(404);
  });
});
