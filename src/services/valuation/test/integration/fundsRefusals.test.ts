import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/**
 * `funds.test.ts` covers what the ASC 820 routes do when everything is present:
 * a fund, a position, a mark, a NAV, a waterfall. This file covers what they do
 * when something is not — bad ids, bad bodies, missing prerequisites, omitted
 * optional fields, and an engine that fails.
 *
 * Those paths were the least-exercised code in the service: `routes/funds.ts`
 * sat at 57% branch coverage, the lowest of any route, entirely because the
 * refusals had no tests. A refusal is not a lesser behaviour than a success —
 * it is the behaviour a caller hits on their first wrong guess, and the status
 * code it answers with is the whole of what they learn. A 500 where a 422
 * belongs is a bug the happy path can never find.
 */

/** Mirrors funds.test.ts's stand-in for fund_valuation.py's method dispatch. */
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

describe.skipIf(!dbUp)('ASC 820 fund holdings — refusals and defaults', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  /** Flipped by the one test that needs the engine to fail. */
  let engineFails = false;
  /** Records what the route actually sent the engine, for the default tests. */
  let lastValuationBody: Record<string, any> | null = null;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/fund-valuation', async (req, reply) => {
      if (engineFails) return reply.status(503).send({ detail: 'engine down' });
      const body = req.body as Record<string, any>;
      lastValuationBody = body;
      const positions = (body.positions ?? []).map(markOne);
      const gross = positions.reduce((s: number, m: any) => s + m.fair_value, 0);
      const cost = positions.reduce((s: number, m: any) => s + m.cost_basis, 0);
      const by = { level_1: 0, level_2: 0, level_3: 0 } as Record<string, number>;
      for (const m of positions) by[`level_${m.level}`] += m.fair_value;
      return {
        positions,
        gross_asset_value: gross,
        total_cost_basis: cost,
        total_unrealized_gain: gross - cost,
        liabilities: Number(body.liabilities ?? 0),
        net_asset_value: gross,
        level_breakdown: by,
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
    engineStub.post('/engine/v1/fund-calibrate', async () => ({
      implied_volatility: 0.65,
      calibrated_equity_call: 80_000_000,
      target_class_value: 16_000_000,
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

  const opsAuth = () => authHeader(ops.token);

  async function createFund(body?: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/funds',
      headers: opsAuth(),
      payload: body ?? { name: 'Fund I', fund_type: 'vc', currency: 'usd', vintage_year: 2024 },
    });
    expect(res.statusCode).toBe(201);
    return res.json().fund.id as string;
  }

  async function addPosition(fundId: string, over: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/funds/${fundId}/positions`,
      headers: opsAuth(),
      payload: {
        company_name: 'Acme',
        security_type: 'preferred',
        quantity: 1000,
        cost_basis: 5000,
        mark_method: 'last_round',
        ...over,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().position.id as string;
  }

  // ── Identifiers ───────────────────────────────────────────────────────────
  describe('fund ids', () => {
    it('404s a malformed id without going to the database', async () => {
      // `loadFund` checks `isUlid` before it queries. The distinction matters:
      // a syntactically impossible id is not a lookup that missed, it is a
      // lookup that must never be issued — otherwise every route becomes a
      // place to send arbitrary strings at the query planner.
      for (const url of [
        '/api/v1/funds/not-a-ulid',
        '/api/v1/funds/not-a-ulid/lp-terms',
        '/api/v1/funds/../../etc/passwd',
      ]) {
        const res = await app.inject({ method: 'GET', url, headers: opsAuth() });
        expect(res.statusCode).toBe(404);
      }
    });

    it('404s a well-formed id that belongs to no fund', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/funds/01ARZ3NDEKTSV4RRFFQ69G5FAV/positions',
        headers: opsAuth(),
        payload: { company_name: 'Ghost', quantity: 1, cost_basis: 1, mark_method: 'cost' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s a position that belongs to a different fund', async () => {
      // Scoping, not just existence: the position id is real, the fund id is
      // real, and the pair is not. Answering 404 rather than 200 is what stops
      // one fund's holdings being readable through another's URL.
      const a = await createFund();
      const b = await createFund();
      const pid = await addPosition(a);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/funds/${b}/positions/${pid}/marks`,
        headers: opsAuth(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('404s a mark POST and a roll-forward for a position outside the fund', async () => {
      const a = await createFund();
      const b = await createFund();
      const pid = await addPosition(a);
      for (const path of ['marks', 'rollforward']) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/funds/${b}/positions/${pid}/${path}`,
          headers: opsAuth(),
          payload: { measurement_date: '2026-03-31', method: 'market' },
        });
        expect(res.statusCode).toBe(404);
      }
    });
  });

  // ── Bodies ────────────────────────────────────────────────────────────────
  describe('request bodies', () => {
    it('422s every write route on a body it cannot parse', async () => {
      const id = await createFund();
      const pid = await addPosition(id);
      const cases: [string, string, unknown][] = [
        ['POST', '/api/v1/funds', { name: '', fund_type: 'vc', currency: 'USD' }],
        [
          'POST',
          `/api/v1/funds/${id}/positions`,
          { company_name: 'X', quantity: -5, cost_basis: 1, mark_method: 'cost' },
        ],
        ['POST', `/api/v1/funds/${id}/positions/${pid}/marks`, { method: 'not-a-method' }],
        ['POST', `/api/v1/funds/${id}/positions/${pid}/rollforward`, { method: 'nonsense' }],
        ['PUT', `/api/v1/funds/${id}/valuation`, { valuation_id: 42 }],
        ['PUT', `/api/v1/funds/${id}/lp-terms`, { committed_capital: 'lots' }],
        ['POST', `/api/v1/funds/${id}/waterfall`, { distributable: 'some' }],
        ['POST', `/api/v1/funds/${id}/calibrate`, { round_price_per_share: 'high' }],
      ];
      for (const [method, url, payload] of cases) {
        const res = await app.inject({ method: method as 'POST', url, headers: opsAuth(), payload });
        expect(res.statusCode, `${method} ${url}`).toBe(422);
        // The issue list is the point of a 422 — without it the caller is told
        // only that something, somewhere, was wrong.
        expect(res.json().errors, `${method} ${url}`).toBeTruthy();
      }
    });

    it('400s the fund list on a limit outside its range', async () => {
      // A *query* fault is a 400, not a 422: there is no entity to be
      // unprocessable, only a malformed request line.
      for (const q of ['limit=0', 'limit=100000', 'limit=abc']) {
        const res = await app.inject({ method: 'GET', url: `/api/v1/funds?${q}`, headers: opsAuth() });
        expect(res.statusCode, q).toBe(400);
      }
    });

    it('accepts a fund with no vintage year and upper-cases the currency', async () => {
      // `vintage_year ?? null` and `currency.toUpperCase()` — the two places the
      // create route rewrites what it was handed.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/funds',
        headers: opsAuth(),
        payload: { name: 'Evergreen', fund_type: 'vc', currency: 'gbp' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().fund.vintage_year).toBeNull();
      expect(res.json().fund.currency).toBe('GBP');
    });
  });

  // ── Missing prerequisites ─────────────────────────────────────────────────
  describe('prerequisites', () => {
    it('422s NAV for a fund with no positions', async () => {
      const id = await createFund();
      const res = await app.inject({ method: 'GET', url: `/api/v1/funds/${id}/nav`, headers: opsAuth() });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/no positions/i);
    });

    it('422s a roll-forward before any mark exists', async () => {
      const id = await createFund();
      const pid = await addPosition(id);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/positions/${pid}/rollforward`,
        headers: opsAuth(),
        payload: { method: 'index', index_return: 0.1 },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/no prior mark/i);
    });

    it('422s the waterfall before LP terms are set', async () => {
      const id = await createFund();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/waterfall`,
        headers: opsAuth(),
        payload: { distributable: 1_000_000, years: 5 },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/LP terms/i);
    });

    it('returns null LP terms rather than 404 when none are set', async () => {
      // The distinction the route draws: the *fund* exists, its terms are
      // simply absent. A 404 here would be read as "no such fund".
      const id = await createFund();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/funds/${id}/lp-terms`,
        headers: opsAuth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().lp_terms).toBeNull();
    });
  });

  // ── Carrying at cost ──────────────────────────────────────────────────────
  describe('unmarked positions', () => {
    it('reports a position with no mark as latest_mark: null', async () => {
      const id = await createFund();
      await addPosition(id);
      const res = await app.inject({ method: 'GET', url: `/api/v1/funds/${id}`, headers: opsAuth() });
      expect(res.statusCode).toBe(200);
      expect(res.json().positions[0].latest_mark).toBeNull();
    });

    it('carries an unmarked position at cost when valuing NAV', async () => {
      // The `mark && mark.inputs` fork. An unmarked holding is not skipped and
      // not guessed at — it goes to the engine as a `cost` position, which is
      // the only carrying value that asserts nothing the file does not contain.
      const id = await createFund();
      await addPosition(id, { company_name: 'Unmarked', cost_basis: 7_500 });
      lastValuationBody = null;
      const res = await app.inject({ method: 'GET', url: `/api/v1/funds/${id}/nav`, headers: opsAuth() });
      expect(res.statusCode).toBe(200);
      expect(lastValuationBody?.positions).toEqual([{ name: 'Unmarked', method: 'cost', cost_basis: 7500 }]);
      expect(res.json().nav.level_breakdown.level_3).toBe(7500);
    });
  });

  // ── Method defaults ───────────────────────────────────────────────────────
  describe('mark defaults', () => {
    it('falls back to the position quantity and a zero price per method', async () => {
      // Each `?? ` in the method dispatch, exercised by omitting the field it
      // defends. A mark that omits its price is worth zero, not NaN — the
      // difference between a figure an analyst can see is wrong and one that
      // poisons every total downstream of it.
      const id = await createFund();
      const cases: [string, Record<string, unknown>][] = [
        ['market', { quantity: 1000, quoted_price: 0 }],
        ['last_round', { quantity: 1000, round_price_per_share: 0 }],
        ['calibrated_opm', { model_value: 0 }],
      ];
      for (const [method, expected] of cases) {
        const pid = await addPosition(id, { company_name: `Default-${method}` });
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/funds/${id}/positions/${pid}/marks`,
          headers: opsAuth(),
          payload: { measurement_date: '2026-03-31', method },
        });
        expect(res.statusCode, method).toBe(201);
        expect(Number(res.json().mark.fair_value), method).toBe(0);
        expect(res.json().mark.inputs, method).toEqual(expected);
      }
    });

    it('dates a recorded roll-forward as today when the body omits the date', async () => {
      const id = await createFund();
      const pid = await addPosition(id);
      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/positions/${pid}/marks`,
        headers: opsAuth(),
        payload: { measurement_date: '2026-03-31', method: 'market', quantity: 100, quoted_price: 10 },
      });
      expect(first.statusCode).toBe(201);

      const rolled = await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/positions/${pid}/rollforward`,
        headers: opsAuth(),
        payload: { method: 'index', index_return: 0.2, record: true },
      });
      expect(rolled.statusCode).toBe(201);
      const today = new Date().toISOString().slice(0, 10);
      expect(String(rolled.json().mark.measurement_date)).toContain(today);
      // A rolled mark is a model estimate, so Level 3 regardless of what the
      // mark it rolled from was.
      expect(rolled.json().mark.level).toBe(3);
      expect(rolled.json().mark.inputs.rolled_from).toBeTruthy();
    });

    it('previews a roll-forward without recording it when record is not set', async () => {
      const id = await createFund();
      const pid = await addPosition(id);
      await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/positions/${pid}/marks`,
        headers: opsAuth(),
        payload: { measurement_date: '2026-03-31', method: 'market', quantity: 100, quoted_price: 10 },
      });
      const preview = await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${id}/positions/${pid}/rollforward`,
        headers: opsAuth(),
        payload: { method: 'index', index_return: 0.5 },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().mark).toBeUndefined();
      expect(preview.json().rollforward.new_fair_value).toBe(1500);
      // Still one mark: the preview left no trace.
      const marks = await app.inject({
        method: 'GET',
        url: `/api/v1/funds/${id}/positions/${pid}/marks`,
        headers: opsAuth(),
      });
      expect(marks.json().marks).toHaveLength(1);
    });
  });

  // ── Engagement link ───────────────────────────────────────────────────────
  describe('engagement link', () => {
    async function createValuation(kind: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: opsAuth(),
        payload: { company_name: `Link ${kind}`, kind, valuation_date: '2026-03-31' },
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
      return res.json().valuation.id as string;
    }

    it('404s an engagement id the caller cannot see, malformed or merely absent', async () => {
      const id = await createFund();
      for (const valuationId of ['not-a-ulid', '01ARZ3NDEKTSV4RRFFQ69G5FAV']) {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/funds/${id}/valuation`,
          headers: opsAuth(),
          payload: { valuation_id: valuationId },
        });
        expect(res.statusCode, valuationId).toBe(404);
      }
    });

    it('422s linking a portfolio to an engagement of the wrong kind', async () => {
      // The check that matters. A NAV schedule inside a common-stock opinion is
      // not a formatting problem — it is a different valuation standard.
      const id = await createFund();
      const valuationId = await createValuation('409a');
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${id}/valuation`,
        headers: opsAuth(),
        payload: { valuation_id: valuationId },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/only be linked to a 'fund' engagement/);
      expect(res.json().detail).toContain("'409a'");
    });

    it('links, unlinks, and refuses a second portfolio on one engagement', async () => {
      const valuationId = await createValuation('fund');
      const first = await createFund();
      const second = await createFund();

      const linked = await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${first}/valuation`,
        headers: opsAuth(),
        payload: { valuation_id: valuationId },
      });
      expect(linked.statusCode).toBe(200);
      expect(linked.json().fund.valuation_id).toBe(valuationId);

      // Two portfolios on one engagement would make "the fund's NAV" ambiguous
      // at render time, so the second is a 409 rather than a silent reassign.
      const conflict = await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${second}/valuation`,
        headers: opsAuth(),
        payload: { valuation_id: valuationId },
      });
      expect(conflict.statusCode).toBe(409);

      const detached = await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${first}/valuation`,
        headers: opsAuth(),
        payload: { valuation_id: null },
      });
      expect(detached.statusCode).toBe(200);
      expect(detached.json().fund.valuation_id).toBeNull();

      // With the first detached the engagement is free again.
      const relinked = await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${second}/valuation`,
        headers: opsAuth(),
        payload: { valuation_id: valuationId },
      });
      expect(relinked.statusCode).toBe(200);
    });
  });

  // ── Engine failure ────────────────────────────────────────────────────────
  it('answers a failed engine call with a problem document, not a 500', async () => {
    const id = await createFund();
    await addPosition(id);
    engineFails = true;
    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/funds/${id}/nav`, headers: opsAuth() });
      // Whatever the mapping, what must not happen is an unhandled throw
      // surfacing as a bare 500 with no problem body.
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.json().title ?? res.json().detail).toBeTruthy();
    } finally {
      engineFails = false;
    }
  });

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('forbids a client on every fund route, read and write alike', async () => {
    const id = await createFund();
    const pid = await addPosition(id);
    const routes: [string, string][] = [
      ['POST', '/api/v1/funds'],
      ['GET', '/api/v1/funds'],
      ['GET', `/api/v1/funds/${id}`],
      ['POST', `/api/v1/funds/${id}/positions`],
      ['GET', `/api/v1/funds/${id}/positions/${pid}/marks`],
      ['POST', `/api/v1/funds/${id}/positions/${pid}/marks`],
      ['POST', `/api/v1/funds/${id}/positions/${pid}/rollforward`],
      ['GET', `/api/v1/funds/${id}/nav`],
      ['PUT', `/api/v1/funds/${id}/valuation`],
      ['GET', `/api/v1/funds/${id}/lp-terms`],
      ['PUT', `/api/v1/funds/${id}/lp-terms`],
      ['POST', `/api/v1/funds/${id}/waterfall`],
      ['POST', `/api/v1/funds/${id}/calibrate`],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: authHeader(client.token),
        payload: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('rejects an unauthenticated caller before it looks at the body', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/funds' });
    expect(res.statusCode).toBe(401);
  });
});
