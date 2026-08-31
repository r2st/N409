import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * An engine answer the mark routes cannot read.
 *
 * `postJson` shape-checks nothing beyond "it was JSON" — the debt pricing route
 * says exactly that and guards its own figure. The two fund mark routes did
 * not. `POST /positions/:pid/marks` read `nav.positions[0]!`, an assertion the
 * compiler takes on trust, and put `fair_value` and `level` straight into a
 * `NOT NULL numeric` and a `CHECK (level IN (1, 2, 3))`. The roll-forward
 * handed its number to `requireStorableFigure`, which reads `null` and then
 * assumes anything else is a number.
 *
 * Each of those is a 500 `urn:n409:problem:internal` for a condition that is
 * not internal and not a bug in the caller's request: a `TypeError` on
 * `undefined.fair_value`, a `TypeError` raised from inside the 422's own
 * message, a 23514 from the CHECK. The catalogued advice on that problem type
 * is to retry with an `Idempotency-Key` because the write may have landed;
 * nothing landed and no retry helps. The condition is two deployments
 * disagreeing about a payload, which passes only when somebody changes
 * something — so it wants a 502 in the estate's upstream voice and an alert
 * that names the engine, not a page that says this service crashed.
 */
describe.skipIf(!dbUp)('an engine answer the mark routes cannot read', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  /** What the stub answers next. Set per test. */
  let navAnswer: () => unknown = () => ({});
  let rollAnswer: () => unknown = () => ({});

  const wellFormedNav = (costBasis: number) => ({
    positions: [
      {
        name: 'PortCo',
        method: 'market',
        level: 3,
        quantity: 100,
        cost_basis: costBasis,
        fair_value: costBasis,
        unrealized_gain: 0,
      },
    ],
    gross_asset_value: costBasis,
    total_cost_basis: costBasis,
    total_unrealized_gain: 0,
    liabilities: 0,
    net_asset_value: costBasis,
    level_breakdown: { level_1: 0, level_2: 0, level_3: costBasis },
  });

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/fund-valuation', async () => navAnswer());
    engineStub.post('/engine/v1/fund-rollforward', async () => rollAnswer());
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

    const ctx = { app, pool, teardown: async () => {} };
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  const fundSetup = async (name: string) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: 'fund', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    const valuationId = created.json().valuation.id as string;

    const fund = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name, fund_type: 'vc', currency: 'USD' },
    });
    expect(fund.statusCode).toBe(201);
    const fundId = fund.json().fund.id as string;

    const linked = await app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/valuation`,
      headers: authHeader(ops.token),
      payload: { valuation_id: valuationId },
    });
    expect(linked.statusCode).toBe(200);

    const position = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'PortCo', security_type: 'preferred', quantity: 100, cost_basis: 1000 },
    });
    expect(position.statusCode).toBe(201);
    return { valuationId, fundId, positionId: position.json().position.id as string };
  };

  const recordMark = (fundId: string, positionId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
      headers: authHeader(ops.token),
      payload: { measurement_date: '2026-03-31', method: 'market', quantity: 100, quoted_price: 15 },
    });

  const markCount = async (positionId: string): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM fund_marks WHERE position_id = $1',
      [positionId],
    );
    return rows[0]!.n;
  };

  // Each answer is a different failure on the old code — an empty list threw a
  // TypeError, a string fair value a 22P02 from the driver, a level of 4 a
  // 23514 from the CHECK — and all three arrived as the same 500.
  const unreadable: Array<[string, unknown]> = [
    ['no positions in the answer', { ...wellFormedNav(1000), positions: [] }],
    [
      'a fair value serialised as a string',
      {
        ...wellFormedNav(1000),
        positions: [{ ...wellFormedNav(1000).positions[0], fair_value: '1000.00' }],
      },
    ],
    [
      'a level outside the hierarchy',
      { ...wellFormedNav(1000), positions: [{ ...wellFormedNav(1000).positions[0], level: 4 }] },
    ],
    [
      'a fair value that is not a number at all',
      {
        ...wellFormedNav(1000),
        positions: [{ ...wellFormedNav(1000).positions[0], fair_value: null }],
      },
    ],
  ];

  for (const [what, answer] of unreadable) {
    it(`answers 502 for ${what}`, async () => {
      const { fundId, positionId } = await fundSetup(`Shape ${what}`);
      navAnswer = () => answer;
      const res = await recordMark(fundId, positionId);

      expect(res.statusCode).toBe(502);
      expect(res.json().type).toBe('urn:n409:problem:upstream');
      // The sentence a person reads has to say the two things that are true:
      // which side failed, and that nothing was written.
      expect(res.json().detail).toMatch(/engine/i);
      expect(res.json().detail).toMatch(/nothing has been recorded/i);
      expect(await markCount(positionId)).toBe(0);
    });
  }

  it('records the mark when the engine answers in the shape it declares', async () => {
    const { fundId, positionId } = await fundSetup('Shape control');
    navAnswer = () => wellFormedNav(1000);
    const res = await recordMark(fundId, positionId);

    // The control the four refusals need: same route, same request, a
    // well-formed answer — so the 502s are about the answer and not about the
    // route having stopped working.
    expect(res.statusCode).toBe(201);
    expect(await markCount(positionId)).toBe(1);
  });

  it('answers 502 for a roll-forward with no figure in it', async () => {
    const { fundId, positionId } = await fundSetup('Shape rollforward');
    navAnswer = () => wellFormedNav(1000);
    expect((await recordMark(fundId, positionId)).statusCode).toBe(201);

    rollAnswer = () => ({ change: 100, method: 'index' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions/${positionId}/rollforward`,
      headers: authHeader(ops.token),
      payload: { method: 'index', index_return: 0.1, record: true },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().type).toBe('urn:n409:problem:upstream');
    // The prior mark and nothing else: the roll-forward wrote nothing.
    expect(await markCount(positionId)).toBe(1);
  });

  it('records a roll-forward when the engine answers with a figure', async () => {
    const { fundId, positionId } = await fundSetup('Shape rollforward control');
    navAnswer = () => wellFormedNav(1000);
    expect((await recordMark(fundId, positionId)).statusCode).toBe(201);

    rollAnswer = () => ({ new_fair_value: 1_100, change: 100, method: 'index' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions/${positionId}/rollforward`,
      headers: authHeader(ops.token),
      payload: { method: 'index', index_return: 0.1, record: true },
    });

    expect(res.statusCode).toBe(201);
    expect(await markCount(positionId)).toBe(2);
  });
});
