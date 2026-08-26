import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/**
 * A minimal in-process stand-in for the Python fund engine — enough to exercise
 * the route wiring. Marking maths mirror fund_valuation.py's method dispatch.
 */
function markOne(p: Record<string, any>): Record<string, any> {
  const cost = Number(p.cost_basis ?? 0);
  let fv = cost;
  let level = 3;
  if (p.method === 'market') {
    fv = Number(p.quantity ?? 0) * Number(p.quoted_price ?? 0);
    level = 1;
  } else if (p.method === 'last_round') {
    fv = Number(p.quantity ?? 0) * Number(p.round_price_per_share ?? 0);
    level = 2;
  } else if (p.method === 'calibrated_opm') {
    fv = Number(p.model_value ?? 0);
    level = 3;
  }
  return {
    name: p.name,
    method: p.method,
    level,
    quantity: Number(p.quantity ?? 0),
    cost_basis: cost,
    fair_value: fv,
    unrealized_gain: fv - cost,
  };
}

describe.skipIf(!dbUp)('ASC 820 fund holdings', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/fund-valuation', async (req) => {
      const body = req.body as Record<string, any>;
      const positions = (body.positions ?? []).map(markOne);
      const gross = positions.reduce((s: number, m: any) => s + m.fair_value, 0);
      const cost = positions.reduce((s: number, m: any) => s + m.cost_basis, 0);
      const liab = Number(body.liabilities ?? 0);
      const by = { level_1: 0, level_2: 0, level_3: 0 } as Record<string, number>;
      for (const m of positions) by[`level_${m.level}`] += m.fair_value;
      return {
        positions,
        gross_asset_value: gross,
        total_cost_basis: cost,
        total_unrealized_gain: gross - cost,
        liabilities: liab,
        net_asset_value: gross - liab,
        level_breakdown: by,
      };
    });
    engineStub.post('/engine/v1/fund-waterfall', async (req) => {
      const b = req.body as Record<string, any>;
      const roc = Math.min(b.distributable, b.contributed_capital);
      return {
        distributable: b.distributable,
        lp_distribution: roc,
        gp_distribution: b.distributable - roc,
        tiers: {},
        clawback_owed: 0,
      };
    });
    engineStub.post('/engine/v1/fund-rollforward', async (req) => {
      const b = req.body as Record<string, any>;
      const nv = b.prior_fair_value * (1 + (b.index_return ?? 0));
      return {
        prior_fair_value: b.prior_fair_value,
        new_fair_value: nv,
        change: nv - b.prior_fair_value,
        method: b.method,
      };
    });
    engineStub.post('/engine/v1/fund-calibrate', async () => ({
      implied_volatility: 0.65,
      calibrated_equity_call: 80000000,
      target_class_value: 16000000,
    }));
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
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  async function createFund(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name: 'Fund I', fund_type: 'vc', currency: 'USD', vintage_year: 2024 },
    });
    expect(res.statusCode).toBe(201);
    return res.json().fund.id as string;
  }

  it('creates a fund and adds positions', async () => {
    const id = await createFund();
    const pos = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions`,
      headers: authHeader(ops.token),
      payload: {
        company_name: 'Acme',
        security_type: 'preferred',
        quantity: 1000,
        cost_basis: 5000,
        mark_method: 'last_round',
      },
    });
    expect(pos.statusCode).toBe(201);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/funds/${id}`,
      headers: authHeader(ops.token),
    });
    expect(detail.json().positions).toHaveLength(1);
    expect(detail.json().positions[0].latest_mark).toBeNull();
  });

  it('marks a position and rolls it into NAV with the ASC 820 level breakdown', async () => {
    const id = await createFund();
    const pos = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'PublicCo', quantity: 1000, cost_basis: 8000, mark_method: 'market' },
    });
    const pid = pos.json().position.id as string;
    const mark = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions/${pid}/marks`,
      headers: authHeader(ops.token),
      payload: { measurement_date: '2026-03-31', method: 'market', quantity: 1000, quoted_price: 12 },
    });
    expect(mark.statusCode).toBe(201);
    expect(Number(mark.json().mark.fair_value)).toBeCloseTo(12000);
    expect(mark.json().mark.level).toBe(1);

    const nav = await app.inject({
      method: 'GET',
      url: `/api/v1/funds/${id}/nav`,
      headers: authHeader(ops.token),
    });
    expect(nav.statusCode).toBe(200);
    expect(nav.json().nav.net_asset_value).toBeCloseTo(12000);
    expect(nav.json().nav.level_breakdown.level_1).toBeCloseTo(12000);
  });

  it('rolls a mark forward and records the new mark', async () => {
    const id = await createFund();
    const pos = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'GrowthCo', quantity: 100, cost_basis: 1000, mark_method: 'calibrated_opm' },
    });
    const pid = pos.json().position.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions/${pid}/marks`,
      headers: authHeader(ops.token),
      payload: { measurement_date: '2026-01-01', method: 'calibrated_opm', model_value: 2000 },
    });
    const roll = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions/${pid}/rollforward`,
      headers: authHeader(ops.token),
      payload: { method: 'index', index_return: 0.25, record: true, measurement_date: '2026-06-30' },
    });
    expect(roll.statusCode).toBe(201);
    expect(Number(roll.json().mark.fair_value)).toBeCloseTo(2500);
  });

  it('sets LP terms and runs the distribution waterfall', async () => {
    const id = await createFund();
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${id}/lp-terms`,
      headers: authHeader(ops.token),
      payload: {
        committed_capital: 1000,
        contributed_capital: 800,
        carry_pct: 0.2,
        preferred_return_rate: 0.08,
      },
    });
    expect(put.statusCode).toBe(200);
    const wf = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/waterfall`,
      headers: authHeader(ops.token),
      payload: { distributable: 2000, years: 3 },
    });
    expect(wf.statusCode).toBe(200);
    expect(wf.json().waterfall.lp_distribution).toBeGreaterThan(0);
  });

  it('runs a calibration to the last round', async () => {
    const id = await createFund();
    const cal = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/calibrate`,
      headers: authHeader(ops.token),
      payload: {
        round_price_per_share: 8,
        total_equity_value: 100000000,
        strike: 40000000,
        time_to_exit_years: 4,
        risk_free_rate: 0.04,
        preferred_shares: 2000000,
        fully_diluted_shares: 10000000,
      },
    });
    expect(cal.statusCode).toBe(200);
    expect(cal.json().calibration.implied_volatility).toBeGreaterThan(0);
  });

  /**
   * `fund_marks.fair_value` is `numeric(24, 4)`, so it holds figures below 1e20.
   * A `market` mark is `quantity × quoted_price`, and the route caps quantity at
   * 1e15 and quoted_price at 1e12 — each defensible alone, their product 1e27.
   * No single input is wrong, so no single bound could have caught it; the
   * driver answered `22003 numeric field overflow` and nothing caught that
   * either.
   */
  it('refuses a mark too large for its column instead of 500ing', async () => {
    const id = await createFund();
    const pos = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'Oversized', quantity: 1e15, cost_basis: 1e15, mark_method: 'market' },
    });
    expect(pos.statusCode).toBe(201);
    const pid = pos.json().position.id as string;

    const mark = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions/${pid}/marks`,
      headers: authHeader(ops.token),
      // Each field is inside its own declared ceiling; the product is not.
      payload: { measurement_date: '2026-03-31', method: 'market', quantity: 1e15, quoted_price: 1e12 },
    });
    expect(mark.statusCode).toBe(422);
    expect(mark.json().detail).toMatch(/too large to record/i);

    // Refused whole: no mark row, so NAV is unaffected.
    const marks = await app.inject({
      method: 'GET',
      url: `/api/v1/funds/${id}/positions/${pid}/marks`,
      headers: authHeader(ops.token),
    });
    expect(marks.json().marks).toHaveLength(0);
  });

  it('still records a mark at the top of what the column holds', async () => {
    const id = await createFund();
    const pos = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'BigCo', quantity: 1e9, cost_basis: 1e9, mark_method: 'market' },
    });
    const pid = pos.json().position.id as string;
    const mark = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions/${pid}/marks`,
      headers: authHeader(ops.token),
      payload: { measurement_date: '2026-03-31', method: 'market', quantity: 1e9, quoted_price: 1e9 },
    });
    expect(mark.statusCode).toBe(201);
    expect(Number(mark.json().mark.fair_value)).toBeCloseTo(1e18, -12);
  });

  it('forbids non-ops callers and 404s unknown funds', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/funds',
      headers: authHeader(client.token),
    });
    expect(forbidden.statusCode).toBe(403);
    const notFound = await app.inject({
      method: 'GET',
      url: '/api/v1/funds/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      headers: authHeader(ops.token),
    });
    expect(notFound.statusCode).toBe(404);
  });
  /**
   * R162 — the measurement domains had a C and an R and nothing else.
   *
   * A portfolio created with a typo'd name kept it for good, and a holding
   * added to the wrong fund stayed in that fund's NAV permanently. The route
   * file's own docstring claimed "the valuation service owns the CRUD"; two of
   * the four letters had never been written.
   */
  describe('correcting a portfolio', () => {
    const newFund = async (name: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/funds',
        headers: authHeader(ops.token),
        payload: { name, fund_type: 'vc', currency: 'USD' },
      });
      expect(res.statusCode).toBe(201);
      return res.json().fund.id as string;
    };

    it('renames a fund and leaves the fields it was not given alone', async () => {
      const id = await newFund('Tpyo Ventures I');
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/funds/${id}`,
        headers: authHeader(ops.token),
        payload: { name: 'Typo Ventures I' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().fund.name).toBe('Typo Ventures I');
      // The omitted fields keep their values rather than being nulled — the
      // whole point of a PATCH over the PUT this domain otherwise uses.
      expect(patched.json().fund.fund_type).toBe('vc');
      expect(patched.json().fund.currency).toBe('USD');
    });

    it('refuses an unknown field rather than silently changing nothing', async () => {
      const id = await newFund('Strict Fund');
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/funds/${id}`,
        headers: authHeader(ops.token),
        // `valuation_id` is the engagement link's own route, not a field of the
        // fund's identity; accepting it here would be two ways to do one thing.
        payload: { valuation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('deletes a fund with its holdings and marks', async () => {
      const id = await newFund('Wound Down I');
      const pos = await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/positions`,
        headers: authHeader(ops.token),
        payload: { company_name: 'Acme', quantity: 100, cost_basis: 1000, mark_method: 'cost' },
      });
      expect(pos.statusCode).toBe(201);
      const pid = pos.json().position.id as string;
      await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/positions/${pid}/marks`,
        headers: authHeader(ops.token),
        payload: { measurement_date: '2026-03-31', method: 'cost' },
      });

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/funds/${id}`,
        headers: authHeader(ops.token),
      });
      expect(deleted.statusCode).toBe(204);
      const gone = await app.inject({
        method: 'GET',
        url: `/api/v1/funds/${id}`,
        headers: authHeader(ops.token),
      });
      expect(gone.statusCode).toBe(404);
      // The cascades in 0086 are what carry the holdings and marks out with it.
      const marks = await pool.query('SELECT count(*)::int AS n FROM fund_marks WHERE position_id = $1', [
        pid,
      ]);
      expect(marks.rows[0].n).toBe(0);
      // A repeated delete is a 404, not a 500.
      const again = await app.inject({
        method: 'DELETE',
        url: `/api/v1/funds/${id}`,
        headers: authHeader(ops.token),
      });
      expect(again.statusCode).toBe(404);
    });

    it('refuses to delete a portfolio an engagement is measured against', async () => {
      const id = await newFund('Linked Fund I');
      const engagement = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: 'fund', company_name: 'Linked Fund I' },
      });
      expect(engagement.statusCode).toBe(201);
      const linked = await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${id}/valuation`,
        headers: authHeader(ops.token),
        payload: { valuation_id: engagement.json().valuation.id },
      });
      expect(linked.statusCode).toBe(200);

      // These marks are the NAV a report we have issued speaks for; 0110 chose
      // ON DELETE SET NULL in the other direction on exactly this ground.
      const refused = await app.inject({
        method: 'DELETE',
        url: `/api/v1/funds/${id}`,
        headers: authHeader(ops.token),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().detail).toMatch(/detach/i);

      // Detaching is the deliberate second act that makes it deletable.
      await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${id}/valuation`,
        headers: authHeader(ops.token),
        payload: { valuation_id: null },
      });
      const now = await app.inject({
        method: 'DELETE',
        url: `/api/v1/funds/${id}`,
        headers: authHeader(ops.token),
      });
      expect(now.statusCode).toBe(204);
    });

    it('edits and removes a holding, and scopes both by fund', async () => {
      const id = await newFund('Holdings Fund');
      const other = await newFund('Other Fund');
      const pos = await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/positions`,
        headers: authHeader(ops.token),
        payload: { company_name: 'Acme Ic', quantity: 100, cost_basis: 1000 },
      });
      const pid = pos.json().position.id as string;

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/funds/${id}/positions/${pid}`,
        headers: authHeader(ops.token),
        payload: { company_name: 'Acme Inc', quantity: 150 },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().position.company_name).toBe('Acme Inc');
      expect(Number(patched.json().position.quantity)).toBe(150);
      expect(Number(patched.json().position.cost_basis)).toBe(1000);

      // A position id from one fund must not reach through another fund's URL.
      const crossFund = await app.inject({
        method: 'DELETE',
        url: `/api/v1/funds/${other}/positions/${pid}`,
        headers: authHeader(ops.token),
      });
      expect(crossFund.statusCode).toBe(404);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/funds/${id}/positions/${pid}`,
        headers: authHeader(ops.token),
      });
      expect(removed.statusCode).toBe(204);
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/funds/${id}`,
        headers: authHeader(ops.token),
      });
      expect(detail.json().positions).toEqual([]);
    });

    it('is operations-only, like the rest of the measurement surface', async () => {
      const id = await newFund('RBAC Fund');
      for (const [method, url] of [
        ['PATCH', `/api/v1/funds/${id}`],
        ['DELETE', `/api/v1/funds/${id}`],
      ] as const) {
        const res = await app.inject({
          method,
          url,
          headers: authHeader(client.token),
          payload: method === 'PATCH' ? { name: 'nope' } : undefined,
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    });
  });

  /**
   * The caps these lists have always had, now said out loud.
   *
   * `listPositions` and `listMarks` had no `LIMIT` at all before R162 and the
   * fund detail carries the flag for the first, because NAV is a *sum* over
   * those rows — a silently short page is an understated NAV, not a short
   * table.
   */
  it('reports whether the holdings page was capped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: authHeader(ops.token),
      payload: { name: 'Cap Fund', fund_type: 'vc', currency: 'USD' },
    });
    const id = res.json().fund.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${id}/positions`,
      headers: authHeader(ops.token),
      payload: { company_name: 'Only Holding', quantity: 1, cost_basis: 1 },
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/funds/${id}`,
      headers: authHeader(ops.token),
    });
    expect(detail.json().truncated).toBe(false);
    expect(detail.json().positions).toHaveLength(1);

    const pid = detail.json().positions[0].id as string;
    const marks = await app.inject({
      method: 'GET',
      url: `/api/v1/funds/${id}/positions/${pid}/marks`,
      headers: authHeader(ops.token),
    });
    // The shape matters as much as the value: a client that reads `marks` off
    // this response has to find `truncated` beside it.
    expect(marks.json()).toMatchObject({ marks: [], truncated: false });
  });
});
