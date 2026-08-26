import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Two per-approach recalculations of one valuation, in flight together.
 *
 * A per-approach recalculation is a read-modify-write whose modify step is the
 * engine: the route reads the latest successful run's `results.approaches`,
 * ships them to `/engine/v1/compute` as `prior_approaches`, and the engine
 * copies every approach it was *not* asked to recompute straight into the new
 * run (`engine/compute.py::_reused_prior`). So the row this writes states a
 * value for all four approaches, and three of those four are quotations of a
 * baseline read up to thirty seconds earlier — `postJson`'s timeout is the
 * width of the window.
 *
 * That is the whole-form PATCH shape ([[n409-lost-update-shape]]) with the
 * form filled in by the engine rather than by a browser. Two analysts pressing
 * "Recalculate" on two different approaches both read the same baseline, and
 * the second run to commit quotes the first one's *pre-recalculation* number
 * back over the top of it — with a 201, a fresh row in the history, and a
 * `reused: true` flag that says the number is a carry-forward rather than that
 * it is out of date. Nothing errors and nothing is marked; the analyst who
 * recalculated income watches the FMV move and then, on the next page load,
 * finds it back where it was.
 *
 * The window is staged inside the engine stub's own handler, which is the only
 * place honestly inside it: both requests are held there until both have read
 * their baseline, then released together.
 */

interface Approach {
  equity_value: number;
  weight: number;
  [key: string]: unknown;
}

interface ComputePayload {
  recompute?: string[];
  prior_approaches?: Record<string, Approach>;
}

/**
 * Engine stub that reproduces `_reused_prior`: the approaches it was not asked
 * to recompute are copied out of `prior_approaches` with their stale weight
 * stripped and `reused: true` set, and the one it was asked for is computed
 * fresh. `fresh` names the number each approach computes to on its next run,
 * so a lost recalculation is identifiable by value.
 */
async function startEngineStub(state: {
  fresh: Record<string, number>;
  /** Held inside the compute handler, after the caller has read its baseline. */
  gate: ((payload: ComputePayload) => Promise<void>) | null;
}) {
  const stub = Fastify({ logger: false });
  stub.post('/engine/v1/compute', async (req, reply) => {
    const payload = req.body as ComputePayload;
    await state.gate?.(payload);

    const prior = payload.prior_approaches ?? {};
    const approaches: Record<string, unknown> = {};
    if (payload.recompute) {
      for (const [name, entry] of Object.entries(prior)) {
        if (payload.recompute.includes(name)) continue;
        const { weight: _weight, ...rest } = entry;
        approaches[name] = { ...rest, reused: true };
      }
      for (const name of payload.recompute) {
        approaches[name] = { equity_value: state.fresh[name] ?? 0, weight: 0.5 };
      }
    } else {
      for (const [name, value] of Object.entries(state.fresh)) {
        approaches[name] = { equity_value: value, weight: 0.5 };
      }
    }

    const equity = Object.values(approaches).reduce(
      (sum, a) => sum + Number((a as Approach).equity_value) * 0.5,
      0,
    );
    return reply.send({
      engine_version: 'py-stub',
      results: { equity_value: equity, fmv_per_share: equity / 1e7, approaches },
      warnings: [],
    });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

/** Resolves once `count` callers have arrived, then releases all of them. */
function meetingPoint(count: number) {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) open();
    await opened;
  };
}

describe.skipIf(!dbUp)('concurrent per-approach recalculation', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const state = {
    fresh: { income: 100, market: 200 } as Record<string, number>,
    gate: null as ((payload: ComputePayload) => Promise<void>) | null,
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    engineStub = await startEngineStub(state);

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ENGINE_URL: engineStub.url,
    });
    app = buildApp({ config, pool });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    const client = await seedUser(seedCtx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'RecalcRaceCo' },
    });
    valuationId = created.json().valuation.id;

    // Both approaches carry weight, so both are recalculable.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/params`,
      headers: authHeader(ops.token),
      payload: { weight_income: 0.5, weight_market: 0.5, weight_asset: 0, weight_opm: 0 },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(ops.token),
      payload: { shares_outstanding_common: 10_000_000 },
    });
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  const compute = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
      payload: body,
    });

  /** The approach values the newest successful run states. */
  const latestApproaches = async (): Promise<Record<string, Approach>> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
    });
    const rows = res.json().calculations as Array<{
      status: string;
      results: { approaches: Record<string, Approach> } | null;
    }>;
    const latest = rows.find((r) => r.status === 'succeeded');
    if (!latest?.results) throw new Error(`no succeeded run in ${JSON.stringify(rows)}`);
    return latest.results.approaches;
  };

  it('establishes a baseline both approaches can be recalculated from', async () => {
    state.gate = null;
    const res = await compute({});
    expect(res.statusCode).toBe(201);
    const approaches = await latestApproaches();
    expect(approaches.income!.equity_value).toBe(100);
    expect(approaches.market!.equity_value).toBe(200);
  });

  it('does not answer a recalculation with a number it is about to discard', async () => {
    state.fresh = { income: 111, market: 222 };
    state.gate = meetingPoint(2);

    const [incomeRes, marketRes] = await Promise.all([
      compute({ approach: 'income' }),
      compute({ approach: 'market' }),
    ]);
    state.gate = null;

    const approaches = await latestApproaches();
    const landed = {
      income: approaches.income!.equity_value,
      market: approaches.market!.equity_value,
    };

    // The property, stated without reference to who won: a recalculation
    // answered 201 has changed the engagement's number. One that was refused
    // has not, and says so. What must never happen is a 201 whose figure is
    // absent from the run everything downstream reads.
    for (const [approach, res, fresh] of [
      ['income', incomeRes, 111],
      ['market', marketRes, 222],
    ] as const) {
      if (res.statusCode === 201) {
        expect(landed[approach], `${approach} was accepted and then discarded`).toBe(fresh);
      } else {
        expect(res.statusCode).toBe(409);
      }
    }
  });

  it('refuses the loser by name rather than with a bare conflict', async () => {
    state.fresh = { income: 333, market: 444 };
    state.gate = meetingPoint(2);
    const results = await Promise.all([compute({ approach: 'income' }), compute({ approach: 'market' })]);
    state.gate = null;

    const refused = results.filter((r) => r.statusCode === 409);
    expect(refused.length).toBe(1);
    expect(refused[0]!.json().detail).toMatch(/recalculat/i);
  });

  it('lets sequential recalculations of two approaches both stand', async () => {
    state.gate = null;
    state.fresh = { income: 555, market: 200 };
    expect((await compute({ approach: 'income' })).statusCode).toBe(201);
    state.fresh = { income: 555, market: 666 };
    expect((await compute({ approach: 'market' })).statusCode).toBe(201);

    const approaches = await latestApproaches();
    expect(approaches.income!.equity_value).toBe(555);
    expect(approaches.market!.equity_value).toBe(666);
  });

  it('leaves two concurrent full runs to last-write-wins, losing nothing', async () => {
    // A full run recomputes every approach from the inputs as they stand, so
    // neither of two of them quotes the other: whichever commits second is a
    // complete answer, not a partial one carrying a stale half.
    state.fresh = { income: 777, market: 888 };
    state.gate = meetingPoint(2);
    const results = await Promise.all([compute({}), compute({})]);
    state.gate = null;

    expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
    const approaches = await latestApproaches();
    expect(approaches.income!.equity_value).toBe(777);
    expect(approaches.market!.equity_value).toBe(888);
  });
});
