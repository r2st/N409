import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A measurement write and its spine event are one transaction.
 *
 * `events/record.ts` states the rule the whole audit trail rests on — "events
 * are written in the SAME transaction as the change they describe, so a change
 * without its event (or vice versa) is impossible" — and every one of the
 * thirty-odd `recordEvent` callers in this service is inside the repo
 * transaction that does the write. The measurement surface was the exception:
 * R279 put the spine writes on the fund and debt *routes*, after the mutation
 * had already committed on the pool, each opening a transaction of its own.
 *
 * That is the invariant read backwards. The pool sets a statement timeout and
 * a connection can drop, so the second transaction failing is an ordinary
 * outcome, and when it did the holding was added, the mark taken or the
 * instrument re-priced with nothing on the trail — and the caller was answered
 * 500 for work that had landed, so the obvious retry files it twice. Neither
 * half is visible afterwards: the row looks hand-entered and the trail looks
 * complete.
 *
 * Driven by making the event INSERT fail, which is the only honest way to ask
 * the question: a trigger that raises on the type under test, so the failure
 * lands exactly where a timeout would.
 */
describe.skipIf(!dbUp)('a measurement change and its event stand or fall together', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let fundId: string;
  let instrumentId: string;

  /** Make the spine refuse one event type, the way a statement timeout would. */
  const breakEvent = async (type: string): Promise<void> => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_break_event() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'spine unavailable'; END $$;
      CREATE TRIGGER test_break_event BEFORE INSERT ON valuation_events
        FOR EACH ROW WHEN (NEW.type = '${type}') EXECUTE FUNCTION test_break_event();
    `);
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/fund-valuation', async (req) => {
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
    engineStub.post('/engine/v1/debt-valuation', async () => ({ fair_value: 950_000 }));
    await engineStub.listen({ port: 0, host: '127.0.0.1' });
    const address = engineStub.server.address();
    const enginePort = typeof address === 'object' && address ? address.port : 0;

    app = buildApp({
      config: loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        JWT_SECRET: 'integration-test-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        ENGINE_URL: `http://127.0.0.1:${enginePort}`,
        AUTO_PIPELINE: 'off',
      }),
      pool,
    });
    await app.ready();

    const ctx = { app, pool, teardown: async () => {} };
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    const engagement = async (kind: 'fund' | 'debt', name: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(owner.token),
        payload: { kind, company_name: name },
      });
      if (res.statusCode !== 201) throw new Error(`create ${kind} failed: ${res.body}`);
      return res.json().valuation.id as string;
    };

    const fund = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name: 'Atomic Fund', fund_type: 'vc', currency: 'USD' },
    });
    fundId = fund.json().fund.id as string;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/valuation`,
      headers: authHeader(ops.token),
      payload: { valuation_id: await engagement('fund', 'Atomic Fund Engagement') },
    });

    const instrument = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: authHeader(ops.token),
      payload: { name: 'Atomic Note', instrument_type: 'credit_spread', currency: 'USD', params: {} },
    });
    instrumentId = instrument.json().instrument.id as string;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/debt/instruments/${instrumentId}/valuation`,
      headers: authHeader(ops.token),
      payload: { valuation_id: await engagement('debt', 'Atomic Debt Engagement') },
    });
  });

  afterEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS test_break_event ON valuation_events');
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  it('does not leave a holding the trail never heard about', async () => {
    await breakEvent('fund_position_added');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'Ghost Co', security_type: 'preferred', quantity: 10, cost_basis: 100 },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);

    const { rows } = await pool.query(
      'SELECT id FROM fund_positions WHERE fund_id = $1 AND company_name = $2',
      [fundId, 'Ghost Co'],
    );
    // The answer was an error, so the holding must not be there. Before the
    // fix it was, and the NAV it feeds moved with nothing to say who moved it.
    expect(rows).toHaveLength(0);
  });

  it('does not leave a mark the NAV is summed from and the trail does not know', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'Marked Co', security_type: 'preferred', quantity: 10, cost_basis: 100 },
    });
    expect(created.statusCode).toBe(201);
    const positionId = created.json().position.id as string;

    await breakEvent('fund_mark_recorded');
    const marked = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
      headers: authHeader(ops.token),
      payload: { measurement_date: '2026-03-31', method: 'cost' },
    });
    expect(marked.statusCode).toBeGreaterThanOrEqual(500);

    const { rows } = await pool.query('SELECT id FROM fund_marks WHERE position_id = $1', [positionId]);
    expect(rows).toHaveLength(0);
  });

  it('does not leave a stored price off the instrument’s trail', async () => {
    await breakEvent('debt_valuation_recorded');
    const priced = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${instrumentId}/value`,
      headers: authHeader(ops.token),
      payload: { persist: true },
    });
    expect(priced.statusCode).toBeGreaterThanOrEqual(500);

    const { rows } = await pool.query('SELECT id FROM debt_valuations WHERE instrument_id = $1', [
      instrumentId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
