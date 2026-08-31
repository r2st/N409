import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A holding deleted while a mark for it is already in flight.
 *
 * `measurementRetirementRace` asks what happens when the *engagement* goes away
 * inside the engine round trip and R284 answered it: the mark transaction
 * re-reads the engagement and refuses. The row the mark actually points at was
 * never re-read. `POST /funds/:id/positions/:pid/marks` loads the position on
 * the pool, spends up to 30s in `/engine/v1/fund-valuation`, and then INSERTs
 * `fund_marks.position_id` — a NOT NULL foreign key (0086) — from that copy.
 *
 * `DELETE /funds/:id/positions/:pid` is not exotic while a mark is running: it
 * is deliberately one of the writes that stays open even on withdrawn work,
 * because "a position entered against the wrong fund is the ordinary
 * correction this exists for". Delete one inside the window and the INSERT
 * raises 23503, which is not a SQLSTATE `databaseUnavailableReason` calls
 * transient — so it fell all the way through `registerProblemHandler` to
 * `urn:n409:problem:internal`, 500, logged `alert: true`. The caller is told
 * the server is broken and asked to retry a request that will never succeed,
 * and an operator is paged for two people editing the same portfolio.
 *
 * The sibling that prices an instrument re-reads its subject inside the
 * transaction (`instrumentForWriteIn`) and 404s, which is the asymmetry that
 * gave this away.
 *
 * Driven with an engine stub that blocks, so the interleaving is the test's
 * rather than one it hopes to hit.
 */
describe.skipIf(!dbUp)('a holding deleted inside a measurement write', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  /** Resolved by the stub when a request is inside the engine call. */
  let entered: (() => void) | null = null;
  /** Awaited by the stub; the test resolves it to let the engine answer. */
  let release: Promise<void> = Promise.resolve();
  let letGo: () => void = () => {};

  /** Arm the gate, run `fn` while the engine is held, then let the engine answer. */
  const withEngineHeld = async (send: () => Promise<unknown>, meanwhile: () => Promise<void>) => {
    const insideEngine = new Promise<void>((resolve) => {
      entered = resolve;
    });
    release = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const inFlight = send();
    await insideEngine;
    await meanwhile();
    letGo();
    return inFlight;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/fund-valuation', async (req) => {
      entered?.();
      entered = null;
      await release;
      const body = req.body as { positions: Record<string, number>[] };
      const positions = body.positions.map((p) => ({
        ...p,
        level: 3,
        fair_value: Number(p.cost_basis ?? 0),
        unrealized_gain: 0,
      }));
      const gross = positions.reduce((sum, p) => sum + p.fair_value, 0);
      return {
        positions,
        gross_asset_value: gross,
        total_cost_basis: gross,
        total_unrealized_gain: 0,
        liabilities: 0,
        net_asset_value: gross,
        level_breakdown: { level_1: 0, level_2: 0, level_3: gross },
      };
    });
    engineStub.post('/engine/v1/fund-rollforward', async () => {
      entered?.();
      entered = null;
      await release;
      return { new_fair_value: 2_000, change: 1_000, method: 'index' };
    });
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
    letGo();
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  /** A `fund` engagement with a linked portfolio holding one position. */
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

  const removePosition = async (fundId: string, positionId: string): Promise<void> => {
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/v1/funds/${fundId}/positions/${positionId}`,
      headers: authHeader(ops.token),
    });
    expect(gone.statusCode).toBe(204);
  };

  it('answers 404 for a mark whose holding was removed during the engine call', async () => {
    const { fundId, positionId } = await fundSetup('Vanishing Fund');

    const res = (await withEngineHeld(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
          headers: authHeader(ops.token),
          payload: { measurement_date: '2026-03-31', method: 'market', quantity: 100, quoted_price: 15 },
        }),
      () => removePosition(fundId, positionId),
    )) as Awaited<ReturnType<typeof app.inject>>;

    // The id no longer names anything, which is what a 404 says. A 500 says the
    // server is broken and the catalogued advice on `urn:n409:problem:internal`
    // is to retry with an idempotency key — advice that cannot ever work here.
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe('urn:n409:problem:not-found');
  });

  it('answers 404 for a roll-forward whose holding was removed during the engine call', async () => {
    const { fundId, positionId } = await fundSetup('Vanishing Roll Fund');

    const seeded = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
      headers: authHeader(ops.token),
      payload: { measurement_date: '2026-03-31', method: 'market', quantity: 100, quoted_price: 10 },
    });
    expect(seeded.statusCode).toBe(201);

    const res = (await withEngineHeld(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/funds/${fundId}/positions/${positionId}/rollforward`,
          headers: authHeader(ops.token),
          payload: { method: 'index', index_return: 0.1, record: true },
        }),
      () => removePosition(fundId, positionId),
    )) as Awaited<ReturnType<typeof app.inject>>;

    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe('urn:n409:problem:not-found');
  });

  it('still records a mark when the holding survives the engine call', async () => {
    const { fundId, positionId } = await fundSetup('Surviving Fund');

    const res = (await withEngineHeld(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
          headers: authHeader(ops.token),
          payload: { measurement_date: '2026-03-31', method: 'market', quantity: 100, quoted_price: 15 },
        }),
      async () => {},
    )) as Awaited<ReturnType<typeof app.inject>>;

    // The twin the two 404s need: same request, same held engine, nothing
    // deleted — so the refusals above can only have come from the missing row.
    expect(res.statusCode).toBe(201);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM fund_marks WHERE position_id = $1',
      [positionId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
