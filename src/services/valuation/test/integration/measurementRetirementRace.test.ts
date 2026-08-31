import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { newUlid } from '@n409/shared';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A retirement that lands while a measurement write is already in flight.
 *
 * `measurementRetiredWrites` drives every write on this surface against an
 * engagement that was *already* withdrawn when the request arrived, which is
 * the question R279 asked. It cannot see the one this file asks: the guard runs
 * on the pool and the write runs in a transaction opened afterwards, so between
 * them there is a window in which the answer stops being true.
 *
 * On `POST /funds/:id/positions/:pid/marks` that window was not a scheduling
 * hiccup — it was the whole `/engine/v1/fund-valuation` round trip, up to the
 * 30s client budget. The two sibling routes that also call the engine before
 * writing re-ask afterwards and this one never did, which is the asymmetry that
 * gave it away. A mark written there is not a note in the margin: the NAV
 * schedule is a sum over the stored marks at render time, so it restates the
 * figure in a report the firm has already issued, and retirement is reversible,
 * so it comes back with the engagement.
 *
 * Driven with an engine stub that blocks. The request is sent, the stub reports
 * that the route is inside the engine call and waits, the engagement is retired
 * to completion, and only then does the stub answer. That is the interleaving
 * itself rather than a race the test hopes to hit, so it either holds or it
 * does not.
 */
describe.skipIf(!dbUp)('a retirement landing inside a measurement write', () => {
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
    engineStub.post('/engine/v1/debt-valuation', async () => {
      entered?.();
      entered = null;
      await release;
      return { fair_value: 950_000 };
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

  /** A `fund` engagement with a linked portfolio holding one marked position. */
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

  const markCount = async (positionId: string): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM fund_marks WHERE position_id = $1',
      [positionId],
    );
    return rows[0]!.n;
  };

  it('refuses a mark whose engine call outlived the engagement', async () => {
    const { valuationId, fundId, positionId } = await fundSetup('Race Fund');

    const res = (await withEngineHeld(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
          headers: authHeader(ops.token),
          payload: { measurement_date: '2026-03-31', method: 'market', quantity: 100, quoted_price: 15 },
        }),
      async () => {
        const { retired } = await retireValuations(pool, [valuationId]);
        expect(retired).toEqual([valuationId]);
      },
    )) as Awaited<ReturnType<typeof app.inject>>;

    expect(res.statusCode).toBe(409);
    // The refusal is the guard's, not a body or an id problem.
    expect(res.json().detail).toMatch(/retired/i);
    // And nothing landed. A 409 over a committed row would be the worse half:
    // the NAV schedule would already have moved.
    expect(await markCount(positionId)).toBe(0);
  });

  it('records the mark when the engagement is still live', async () => {
    const { fundId, positionId } = await fundSetup('Live Fund');

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

    // The twin the refusal above needs: same request, same held engine, no
    // retirement — so the 409 can only have come from the state of the file.
    expect(res.statusCode).toBe(201);
    expect(await markCount(positionId)).toBe(1);
  });

  it('refuses a debt pricing run whose engine call outlived the engagement', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: 'debt', company_name: 'Race Notes' },
    });
    expect(created.statusCode).toBe(201);
    const valuationId = created.json().valuation.id as string;

    const instrument = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: authHeader(ops.token),
      payload: {
        name: 'Race Notes',
        instrument_type: 'credit_spread',
        currency: 'USD',
        params: { face_value: 1e6 },
      },
    });
    expect(instrument.statusCode).toBe(201);
    const instrumentId = instrument.json().instrument.id as string;
    const linked = await app.inject({
      method: 'PUT',
      url: `/api/v1/debt/instruments/${instrumentId}/valuation`,
      headers: authHeader(ops.token),
      payload: { valuation_id: valuationId },
    });
    expect(linked.statusCode).toBe(200);

    const res = (await withEngineHeld(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/debt/instruments/${instrumentId}/value`,
          headers: authHeader(ops.token),
          payload: { persist: true },
        }),
      async () => {
        await retireValuations(pool, [valuationId]);
      },
    )) as Awaited<ReturnType<typeof app.inject>>;

    expect(res.statusCode).toBe(409);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM debt_valuations WHERE instrument_id = $1',
      [instrumentId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('routes the spine event by the link the write itself sees', async () => {
    // A portfolio linked to its engagement *while* a mark is in flight. The
    // route read the fund before the engine call, when it was unlinked, and
    // `recordFundEvent` writes only when the copy it was handed is linked — so
    // the mark committed onto a linked engagement with nothing on its trail.
    // R280's invariant defeated by a stale read rather than by a failure.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: 'fund', company_name: 'Late Link Fund' },
    });
    const valuationId = created.json().valuation.id as string;
    const fund = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name: 'Late Link Fund', fund_type: 'vc', currency: 'USD' },
    });
    const fundId = fund.json().fund.id as string;
    const position = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'PortCo', security_type: 'preferred', quantity: 10, cost_basis: 500 },
    });
    const positionId = position.json().position.id as string;

    const res = (await withEngineHeld(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
          headers: authHeader(ops.token),
          payload: { measurement_date: '2026-03-31', method: 'market', quantity: 10, quoted_price: 60 },
        }),
      async () => {
        const linked = await app.inject({
          method: 'PUT',
          url: `/api/v1/funds/${fundId}/valuation`,
          headers: authHeader(ops.token),
          payload: { valuation_id: valuationId },
        });
        expect(linked.statusCode).toBe(200);
      },
    )) as Awaited<ReturnType<typeof app.inject>>;

    expect(res.statusCode).toBe(201);
    const markId = res.json().mark.id as string;
    const { rows } = await pool.query<{ payload: { mark_id?: string } }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'fund_mark_recorded'`,
      [valuationId],
    );
    expect(rows.map((r) => r.payload.mark_id)).toEqual([markId]);
  });

  it('leaves an unlinked portfolio writable while other work is retired', async () => {
    // The guard reads the *subject's* link, so a standalone ops sketch is not
    // affected by anything happening to anybody's engagement. Cheap to assert
    // and it is the branch a `FOR SHARE` on a null id would have crashed on.
    const fund = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name: 'Standalone', fund_type: 'vc', currency: 'USD' },
    });
    const fundId = fund.json().fund.id as string;
    const position = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'PortCo', security_type: 'common', quantity: 5, cost_basis: 100 },
    });
    expect(position.statusCode).toBe(201);
    const positionId = position.json().position.id as string;

    const res = (await withEngineHeld(
      () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
          headers: authHeader(ops.token),
          payload: { measurement_date: '2026-03-31', method: 'market', quantity: 5, quoted_price: 30 },
        }),
      async () => {},
    )) as Awaited<ReturnType<typeof app.inject>>;
    expect(res.statusCode).toBe(201);
  });
});
