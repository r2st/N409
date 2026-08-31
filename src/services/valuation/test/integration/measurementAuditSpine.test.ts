import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The measurement surface on the engagement's audit spine.
 *
 * `fund` and `debt` are two of the fifteen valuation kinds, and their entire
 * working record lived off it. Both subjects are addressed by their own ids —
 * 0086/0087 built them as standalone ops tools, 0110 linked them to an
 * engagement afterwards — so neither route file ever wrote a `valuation_events`
 * row. The engagement panel's activity feed for a fund engagement was empty of
 * every act that produced the deliverable, and `domain/navExhibits.ts` renders
 * the NAV schedule by summing the *stored* marks at render time, so the figure
 * the report prints could move with nothing on the trail saying who moved it.
 *
 * Asserted through the events route rather than against the table, because the
 * feed is the thing that was empty: an event written under a type the catalog
 * does not know renders as "Event recorded" and is worth little more than
 * silence.
 */
describe.skipIf(!dbUp)('measurement changes land on the engagement audit trail', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let fundValuation: string;
  let debtValuation: string;
  let fundId: string;
  let positionId: string;
  let instrumentId: string;
  /** Never linked to anything: the control for "only when there is a trail". */
  let looseFundId: string;

  const eventTypes = async (valuationId: string): Promise<string[]> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/events`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return (res.json().events as { type: string }[]).map((e) => e.type);
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

    const valuation = async (kind: 'fund' | 'debt', name: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(owner.token),
        payload: { kind, company_name: name },
      });
      if (res.statusCode !== 201) throw new Error(`create ${kind} failed: ${res.body}`);
      return res.json().valuation.id as string;
    };
    fundValuation = await valuation('fund', 'Spine Fund Engagement');
    debtValuation = await valuation('debt', 'Spine Debt Engagement');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name: 'Spine Fund I', fund_type: 'vc', currency: 'USD' },
    });
    fundId = created.json().fund.id as string;

    const loose = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name: 'Unlinked Sketch', fund_type: 'vc', currency: 'USD' },
    });
    looseFundId = loose.json().fund.id as string;

    const instrument = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: authHeader(ops.token),
      payload: { name: 'Spine Note', instrument_type: 'credit_spread', currency: 'USD', params: {} },
    });
    instrumentId = instrument.json().instrument.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  it('records the link that gives the engagement its measurement subject', async () => {
    for (const [url, valuationId] of [
      [`/api/v1/funds/${fundId}/valuation`, fundValuation],
      [`/api/v1/debt/instruments/${instrumentId}/valuation`, debtValuation],
    ] as const) {
      const res = await app.inject({
        method: 'PUT',
        url,
        headers: authHeader(ops.token),
        payload: { valuation_id: valuationId },
      });
      expect(res.statusCode).toBe(200);
      expect(await eventTypes(valuationId)).toContain('measurement_subject_linked');
    }
  });

  it('records every change to the portfolio the NAV schedule is summed from', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'PortCo', security_type: 'preferred', quantity: 100, cost_basis: 1000 },
    });
    expect(created.statusCode).toBe(201);
    positionId = created.json().position.id as string;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/funds/${fundId}/positions/${positionId}`,
      headers: authHeader(ops.token),
      payload: { quantity: 250 },
    });
    expect(patched.statusCode).toBe(200);

    const marked = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions/${positionId}/marks`,
      headers: authHeader(ops.token),
      payload: { measurement_date: '2026-03-31', method: 'cost' },
    });
    expect(marked.statusCode).toBe(201);

    const terms = await app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/lp-terms`,
      headers: authHeader(ops.token),
      payload: { committed_capital: 1e7, contributed_capital: 5e6 },
    });
    expect(terms.statusCode).toBe(200);

    const types = await eventTypes(fundValuation);
    expect(types).toContain('fund_position_added');
    expect(types).toContain('fund_position_updated');
    expect(types).toContain('fund_mark_recorded');
    expect(types).toContain('fund_lp_terms_updated');
  });

  it('names the mark it recorded, so the figure in the exhibit can be reached from the trail', async () => {
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'fund_mark_recorded'`,
      [fundValuation],
    );
    expect(rows).toHaveLength(1);
    // Every other writer on the spine names the row it wrote — `grant_id`,
    // `report_id`. A mark is the one whose figure the NAV schedule is a sum
    // of, so "a mark was recorded" leaves an auditor asking which one.
    const markId = rows[0]!.payload.mark_id;
    expect(typeof markId).toBe('string');
    const mark = await pool.query('SELECT id FROM fund_marks WHERE id = $1', [markId]);
    expect(mark.rowCount).toBe(1);
  });

  it('records a change to the portfolio itself, not only to what is under it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/funds/${fundId}`,
      headers: authHeader(ops.token),
      payload: { name: 'Spine Fund I (renamed)', currency: 'EUR' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM valuation_events WHERE valuation_id = $1 AND type = 'fund_updated'`,
      [fundValuation],
    );
    expect(rows).toHaveLength(1);
    // The currency is why this one is not cosmetic: every stored mark and
    // every LP-terms figure under the fund is a number in it, and the NAV
    // exhibit prints the fund's — so this restates the whole schedule's
    // meaning without moving a single figure.
    expect(rows[0]!.payload.changes).toMatchObject({ currency: 'EUR' });
  });

  it('names the holding it removed, which the cascade would otherwise take with it', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/funds/${fundId}/positions/${positionId}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(204);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'fund_position_removed'`,
      [fundValuation],
    );
    expect(rows).toHaveLength(1);
    // The row is read before the delete precisely so the event can say what
    // went. "A holding was removed" is not an answer to which one.
    expect(rows[0]!.payload.company_name).toBe('PortCo');
    expect(rows[0]!.payload.position_id).toBe(positionId);
  });

  it('records the debt instrument’s terms and its stored prices', async () => {
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/debt/instruments/${instrumentId}`,
      headers: authHeader(ops.token),
      payload: { name: 'Spine Note (amended)' },
    });
    expect(updated.statusCode).toBe(200);

    const terms = await app.inject({
      method: 'PUT',
      url: `/api/v1/debt/instruments/${instrumentId}/credit-terms`,
      headers: authHeader(ops.token),
      payload: { rating: 'BB', seniority: 'senior', secured: true },
    });
    expect(terms.statusCode).toBe(200);

    const priced = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${instrumentId}/value`,
      headers: authHeader(ops.token),
      payload: { persist: true },
    });
    expect(priced.statusCode).toBeLessThan(300);

    const types = await eventTypes(debtValuation);
    expect(types).toContain('debt_instrument_updated');
    expect(types).toContain('debt_credit_terms_updated');
    expect(types).toContain('debt_valuation_recorded');
  });

  it('names the priced row by a key that is not the spine’s own', async () => {
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'debt_valuation_recorded'`,
      [debtValuation],
    );
    expect(rows).toHaveLength(1);
    // `debt_valuations` and `valuations` are two tables, and the event sits on
    // a spine whose own `valuation_id` column is the second of them. A payload
    // key called `valuation_id` is therefore the same word for both, and the
    // reader who joins it to the engagement gets nothing back and no error.
    expect(rows[0]!.payload.valuation_id).toBeUndefined();
    const priced = await pool.query('SELECT id FROM debt_valuations WHERE id = $1', [
      rows[0]!.payload.debt_valuation_id,
    ]);
    expect(priced.rowCount).toBe(1);
  });

  it('does not price a run that stores nothing onto the trail', async () => {
    const before = (await eventTypes(debtValuation)).filter((t) => t === 'debt_valuation_recorded').length;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/debt/instruments/${instrumentId}/value`,
      headers: authHeader(ops.token),
      payload: { persist: false },
    });
    expect(res.statusCode).toBe(200);
    const after = (await eventTypes(debtValuation)).filter((t) => t === 'debt_valuation_recorded').length;
    expect(after).toBe(before);
  });

  it('records the detach on the engagement that is losing its schedule', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${fundId}/valuation`,
      headers: authHeader(ops.token),
      payload: { valuation_id: null },
    });
    expect(res.statusCode).toBe(200);
    expect(await eventTypes(fundValuation)).toContain('measurement_subject_unlinked');
  });

  it('writes nothing for an unlinked portfolio — there is no engagement to write to', async () => {
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM valuation_events');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${looseFundId}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'Sketch Co', quantity: 1, cost_basis: 1 },
    });
    expect(res.statusCode).toBe(201);
    const after = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM valuation_events');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('gives every one of these a catalog label rather than “Event recorded”', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${fundValuation}/events`,
      headers: authHeader(ops.token),
    });
    const measurement = (res.json().events as { type: string; label: string }[]).filter(
      (e) => e.type.startsWith('fund_') || e.type.startsWith('measurement_subject_'),
    );
    expect(measurement.length).toBeGreaterThan(0);
    for (const e of measurement) expect(e.label, e.type).not.toBe('Event recorded');
  });
});
