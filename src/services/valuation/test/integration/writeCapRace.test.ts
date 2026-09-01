import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import { MAX_SCENARIOS } from '../../src/routes/scenarios.js';
import { MAX_BOARD_MEMBERS } from '../../src/routes/boardApproval.js';
import { countScenarios } from '../../src/repos/scenarios.js';
import { countBoardMembers, findResolutionByValuation } from '../../src/repos/boardApprovals.js';

const dbUp = await isDbAvailable();

/**
 * Write caps under concurrency (round 300, methodology M5).
 *
 * Two ceilings on this service are the *only* bound on a list that is read with
 * no LIMIT at all — `listScenarios` and `listBoardMembers`, each uncapped on
 * purpose and each with a comment saying the bound sits at the write end
 * instead. Both were enforced by a `count(*)` on the pool followed by an INSERT
 * in a separate statement, which is the ordinary stale-read-then-write: every
 * request that arrives before the first one commits reads the same figure, and
 * every one of them inserts.
 *
 * The scenario save is the sharper of the two, because the gap is not one
 * statement — the route counts, then spends up to thirty seconds on an engine
 * compute, then inserts. Every save an operator fires while the first is still
 * computing passes the check.
 *
 * Neither ceiling is a tidiness rule. `listBoardMembers` is uncapped because a
 * director hidden past a page boundary reads as a signature that is not
 * required; `listScenarios` has no LIMIT and no pagination anywhere above it.
 * So the failure is not "one row too many" — it is N, for whatever N a caller
 * cares to send at once, on a read nothing pages.
 *
 * Both are now re-asked inside the transaction that writes: the board list
 * under the resolution row lock `addBoardMember` already took, and the scenario
 * list under an advisory lock on the valuation (there is no row to lock in the
 * direction that matters — the rows being counted are the ones not yet
 * inserted, which is `repos/publishLock.ts`'s argument).
 */
describe.skipIf(!dbUp)('write caps under concurrency', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  const BASE_INPUTS = {
    income: { discount_rate: 0.25, terminal_growth: 0.03, free_cash_flows: [100_000, 200_000] },
    market: { metric: 5_000_000, multiples: [4, 6] },
    volatility: 0.6,
    shares_outstanding_common: 10_000_000,
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/compute', async (_req, reply) =>
      reply.send({
        engine_version: 'py-stub',
        results: { equity_value: 20_000_000, fmv_per_share: 2, approaches: { income: {} } },
      }),
    );
    await engineStub.listen({ port: 0, host: '127.0.0.1' });
    const address = engineStub.server.address();
    const enginePort = typeof address === 'object' && address ? address.port : 0;

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ENGINE_URL: `http://127.0.0.1:${enginePort}`,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  async function newValuation(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  it('admits no more than MAX_SCENARIOS when the last saves arrive together', async () => {
    const id = await newValuation('ScenarioCapRaceCo');
    const calc = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/calculations`,
      headers: authHeader(ops.token),
      payload: { inputs: BASE_INPUTS },
    });
    expect(calc.statusCode).toBe(201);

    // One short of the ceiling, sequentially — this half is the ordinary path
    // and is already covered; it is only here to set the state the race needs.
    for (let i = 0; i < MAX_SCENARIOS - 1; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/scenarios`,
        headers: authHeader(client.token),
        payload: { name: `fill-${i}` },
      });
      expect(res.statusCode, `fill ${i}`).toBe(201);
    }

    // Four saves in flight before any of them has committed. Under the pool-side
    // check alone all four counted MAX_SCENARIOS - 1, all four passed, and all
    // four inserted — leaving MAX_SCENARIOS + 3 rows on a list with no LIMIT.
    const racers = await Promise.all(
      [0, 1, 2, 3].map((n) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${id}/scenarios`,
          headers: authHeader(client.token),
          payload: { name: `race-${n}` },
        }),
      ),
    );
    const created = racers.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);
    for (const refused of racers.filter((r) => r.statusCode !== 201)) {
      expect(refused.statusCode).toBe(422);
      expect(refused.json().detail).toMatch(/delete one first/i);
    }

    expect(await countScenarios(pool, id)).toBe(MAX_SCENARIOS);
  });

  it('admits no more than MAX_BOARD_MEMBERS when the last adds arrive together', async () => {
    const id = await newValuation('BoardCapRaceCo');
    const generated = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/board`,
      headers: authHeader(ops.token),
      payload: { fmv_conclusion: 3.25 },
    });
    expect(generated.statusCode).toBe(201);

    const addMember = (label: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${id}/board/members`,
        headers: authHeader(ops.token),
        payload: { name: `Director ${label}`, email: `director-${label}@board.example` },
      });

    for (let i = 0; i < MAX_BOARD_MEMBERS - 1; i++) {
      expect((await addMember(`fill-${i}`)).statusCode, `fill ${i}`).toBe(201);
    }

    const racers = await Promise.all([0, 1, 2, 3].map((n) => addMember(`race-${n}`)));
    const created = racers.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);
    for (const refused of racers.filter((r) => r.statusCode !== 201)) {
      expect(refused.statusCode).toBe(409);
      expect(refused.json().detail).toMatch(/remove one first/i);
    }

    const resolution = await findResolutionByValuation(pool, id);
    expect(await countBoardMembers(pool, resolution!.id)).toBe(MAX_BOARD_MEMBERS);
  });
});
