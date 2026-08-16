import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import { beforeRequest, expectDatedToday } from '../support/today.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/**
 * The debt routes' refusals, and the credit-terms merge that decides what the
 * engine is actually asked to price.
 *
 * `debt.test.ts` prices each instrument type once, with valid input. That left
 * `routes/debt.ts` at 59.5% branch coverage — the lowest of any route — with
 * the id checks, the body checks, the engagement-link rules and two of the
 * three credit-terms arms unexercised.
 *
 * The merge arms are the ones worth having: `spread` and `rating` are
 * alternative ways to say the same thing, the route prefers the explicit spread
 * and falls back to the rating, and getting that precedence backwards would
 * price a bond off a table lookup when somebody had typed the actual spread.
 */
describe.skipIf(!dbUp)('Debt valuation — refusals and the credit-terms merge', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  interface DebtEngineRequest {
    instrument_type?: string;
    params?: Record<string, unknown>;
  }
  let lastPayload: DebtEngineRequest | null = null;
  let engineFails = false;

  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/debt-valuation', async (req, reply) => {
      if (engineFails) return reply.status(503).send({ detail: 'engine down' });
      lastPayload = req.body as DebtEngineRequest;
      return { dirty_price: 980.5, clean_price: 980.5, accrued_interest: 0, market_yield: 0.06 };
    });
    engineStub.post('/engine/v1/debt-rating-spread', async (req) => {
      const { rating } = req.body as { rating?: unknown };
      if (typeof rating !== 'string') throw new Error('rating-spread called without a rating');
      return { rating: rating.toUpperCase(), spread: 0.03 };
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
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  const auth = () => authHeader(ops.token);

  async function createInstrument(
    type = 'bond',
    params: Record<string, unknown> = { face: 1000, coupon: 0.05 },
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/debt/instruments',
      headers: auth(),
      payload: { name: `${type} instrument`, instrument_type: type, currency: 'usd', params, ...over },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().instrument.id as string;
  }

  const setTerms = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/debt/instruments/${id}/credit-terms`,
      headers: auth(),
      payload,
    });

  const value = (id: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/v1/debt/instruments/${id}/value`, headers: auth(), payload });

  // ── Identifiers ───────────────────────────────────────────────────────────
  it('404s every instrument route on a malformed or absent id', async () => {
    const routes: [string, string, unknown][] = [
      ['GET', '/api/v1/debt/instruments/{id}', undefined],
      ['PUT', '/api/v1/debt/instruments/{id}', { name: 'x' }],
      ['PUT', '/api/v1/debt/instruments/{id}/valuation', { valuation_id: null }],
      ['PUT', '/api/v1/debt/instruments/{id}/credit-terms', {}],
      ['POST', '/api/v1/debt/instruments/{id}/value', {}],
      ['GET', '/api/v1/debt/instruments/{id}/valuations', undefined],
    ];
    for (const id of ['not-a-ulid', ULID_ABSENT]) {
      for (const [method, tpl, payload] of routes) {
        const res = await app.inject({
          method: method as 'GET',
          url: tpl.replace('{id}', id),
          headers: auth(),
          payload,
        });
        expect(res.statusCode, `${method} ${tpl} ${id}`).toBe(404);
      }
    }
  });

  // ── Bodies ────────────────────────────────────────────────────────────────
  it('422s each write route on a body it cannot parse', async () => {
    const id = await createInstrument();
    const cases: [string, string, unknown][] = [
      ['POST', '/api/v1/debt/instruments', { name: '', instrument_type: 'bond' }],
      ['POST', '/api/v1/debt/instruments', { name: 'x', instrument_type: 'mortgage' }],
      ['PUT', `/api/v1/debt/instruments/${id}`, { name: '' }],
      ['PUT', `/api/v1/debt/instruments/${id}/valuation`, { valuation_id: 42 }],
      ['PUT', `/api/v1/debt/instruments/${id}/credit-terms`, { spread: 'wide' }],
      ['PUT', `/api/v1/debt/instruments/${id}/credit-terms`, { seniority: 'junior-ish' }],
      ['POST', `/api/v1/debt/instruments/${id}/value`, { valuation_date: '2026-02-30' }],
      ['POST', `/api/v1/debt/instruments/${id}/value`, { valuation_date: 'yesterday' }],
    ];
    for (const [method, url, payload] of cases) {
      const res = await app.inject({ method: method as 'PUT', url, headers: auth(), payload });
      expect(res.statusCode, `${method} ${url} ${JSON.stringify(payload)}`).toBe(422);
    }
  });

  it('422s a rating-spread lookup with no rating', async () => {
    for (const payload of [{}, { rating: '' }, { rating: 'far-too-long' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/debt/rating-spread',
        headers: auth(),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
  });

  it('upper-cases the currency on create', async () => {
    const id = await createInstrument();
    const res = await app.inject({ method: 'GET', url: `/api/v1/debt/instruments/${id}`, headers: auth() });
    expect(res.json().instrument.currency).toBe('USD');
  });

  it('reads back null credit terms before any are set', async () => {
    const id = await createInstrument();
    const res = await app.inject({ method: 'GET', url: `/api/v1/debt/instruments/${id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().credit_terms).toBeNull();
    expect(res.json().valuations).toEqual([]);
  });

  // ── Credit-terms merge ────────────────────────────────────────────────────
  describe('credit terms merge into a credit_spread run', () => {
    it('prefers an explicit spread over the rating', async () => {
      // Both are ways of saying the same thing, and a typed spread is the more
      // specific of the two. Getting this precedence backwards would price off
      // a table lookup while an analyst's own figure sat in the row.
      const id = await createInstrument('credit_spread', { face: 1000 });
      expect((await setTerms(id, { rating: 'BBB', spread: 0.042, benchmark_yield: 0.03 })).statusCode).toBe(
        200,
      );
      lastPayload = null;
      expect((await value(id)).statusCode).toBe(200);
      expect(lastPayload?.params?.spread).toBe(0.042);
      expect(lastPayload?.params?.benchmark_yield).toBe(0.03);
      // The rating is not also sent — two spreads in one payload is ambiguous.
      expect(lastPayload?.params?.rating).toBeUndefined();
    });

    it('falls back to the rating when no spread is stored', async () => {
      const id = await createInstrument('credit_spread', { face: 1000 });
      expect((await setTerms(id, { rating: 'BB' })).statusCode).toBe(200);
      lastPayload = null;
      expect((await value(id)).statusCode).toBe(200);
      expect(lastPayload?.params?.rating).toBe('BB');
      expect(lastPayload?.params?.spread).toBeUndefined();
    });

    it('sends neither when the terms row carries only a seniority', async () => {
      const id = await createInstrument('credit_spread', { face: 1000 });
      expect((await setTerms(id, { seniority: 'subordinated', secured: true })).statusCode).toBe(200);
      lastPayload = null;
      expect((await value(id)).statusCode).toBe(200);
      expect(lastPayload?.params?.spread).toBeUndefined();
      expect(lastPayload?.params?.rating).toBeUndefined();
      expect(lastPayload?.params?.benchmark_yield).toBeUndefined();
    });

    it('leaves a non-credit_spread instrument untouched by stored credit terms', async () => {
      // The merge is keyed on instrument type. A bond with a stored rating must
      // not silently acquire a spread it was never priced with.
      const id = await createInstrument('bond', { face: 1000, coupon: 0.05 });
      expect((await setTerms(id, { rating: 'AA', spread: 0.01 })).statusCode).toBe(200);
      lastPayload = null;
      expect((await value(id)).statusCode).toBe(200);
      expect(lastPayload?.params?.spread).toBeUndefined();
      expect(lastPayload?.params?.rating).toBeUndefined();
      expect(lastPayload?.params?.face).toBe(1000);
    });

    it('lets a per-run override win over both the stored params and the terms', async () => {
      // Overrides are applied last on purpose: they are the "what if" an
      // analyst is asking, and anything that could overwrite them would make
      // the answer not the question.
      const id = await createInstrument('credit_spread', { face: 1000 });
      await setTerms(id, { spread: 0.042, benchmark_yield: 0.03 });
      lastPayload = null;
      expect((await value(id, { overrides: { spread: 0.09, face: 2000 } })).statusCode).toBe(200);
      expect(lastPayload?.params?.spread).toBe(0.09);
      expect(lastPayload?.params?.face).toBe(2000);
    });

    it('dates a run today when the request omits a valuation date', async () => {
      const id = await createInstrument();
      const startedAt = beforeRequest();
      const res = await value(id);
      expect(res.statusCode).toBe(200);
      // The local day, not the UTC one: a debt instrument valued at 10pm in
      // New York must not be dated into a day that has not happened.
      expectDatedToday(res.json().valuation.valuation_date, startedAt);
    });
  });

  // ── Engagement link ───────────────────────────────────────────────────────
  describe('engagement link', () => {
    async function createValuation(kind: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: auth(),
        payload: { company_name: `Debt ${kind}`, kind, valuation_date: '2026-03-31' },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().valuation.id as string;
    }

    it('404s an engagement id that is malformed or not visible', async () => {
      const id = await createInstrument();
      for (const valuationId of ['not-a-ulid', ULID_ABSENT]) {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/v1/debt/instruments/${id}/valuation`,
          headers: auth(),
          payload: { valuation_id: valuationId },
        });
        expect(res.statusCode, valuationId).toBe(404);
      }
    });

    it('422s linking to an engagement that is not a debt engagement', async () => {
      const id = await createInstrument();
      const valuationId = await createValuation('409a');
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/debt/instruments/${id}/valuation`,
        headers: auth(),
        payload: { valuation_id: valuationId },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/only be linked to a 'debt' engagement/);
      expect(res.json().detail).toContain("'409a'");
    });

    it('409s a second instrument on one engagement, and frees it on detach', async () => {
      const valuationId = await createValuation('debt');
      const first = await createInstrument();
      const second = await createInstrument();

      const linked = await app.inject({
        method: 'PUT',
        url: `/api/v1/debt/instruments/${first}/valuation`,
        headers: auth(),
        payload: { valuation_id: valuationId },
      });
      expect(linked.statusCode).toBe(200);

      const conflict = await app.inject({
        method: 'PUT',
        url: `/api/v1/debt/instruments/${second}/valuation`,
        headers: auth(),
        payload: { valuation_id: valuationId },
      });
      expect(conflict.statusCode).toBe(409);

      const detached = await app.inject({
        method: 'PUT',
        url: `/api/v1/debt/instruments/${first}/valuation`,
        headers: auth(),
        payload: { valuation_id: null },
      });
      expect(detached.statusCode).toBe(200);
      expect(detached.json().instrument.valuation_id).toBeNull();

      const relinked = await app.inject({
        method: 'PUT',
        url: `/api/v1/debt/instruments/${second}/valuation`,
        headers: auth(),
        payload: { valuation_id: valuationId },
      });
      expect(relinked.statusCode).toBe(200);
    });
  });

  // ── Engine failure ────────────────────────────────────────────────────────
  it('answers a failed engine call with a problem document and stores nothing', async () => {
    const id = await createInstrument();
    engineFails = true;
    try {
      const res = await value(id);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.json().title ?? res.json().detail).toBeTruthy();
    } finally {
      engineFails = false;
    }
    // A failed pricing leaves no history row — a valuations list that grew on
    // every failure would make the record of what was priced unreadable.
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/debt/instruments/${id}/valuations`,
      headers: auth(),
    });
    expect(list.json().valuations).toEqual([]);
  });

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('forbids a client on every debt route', async () => {
    const id = await createInstrument();
    const routes: [string, string][] = [
      ['POST', '/api/v1/debt/instruments'],
      ['GET', '/api/v1/debt/instruments'],
      ['GET', `/api/v1/debt/instruments/${id}`],
      ['PUT', `/api/v1/debt/instruments/${id}`],
      ['PUT', `/api/v1/debt/instruments/${id}/valuation`],
      ['PUT', `/api/v1/debt/instruments/${id}/credit-terms`],
      ['POST', `/api/v1/debt/instruments/${id}/value`],
      ['GET', `/api/v1/debt/instruments/${id}/valuations`],
      ['POST', '/api/v1/debt/rating-spread'],
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
});
