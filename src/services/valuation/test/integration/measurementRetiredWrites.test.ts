import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { newUlid } from '@n409/shared';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import { mutatingMeasurementRoutes } from '../support/routeTable.js';

const dbUp = await isDbAvailable();

/**
 * Writes aimed at a retired engagement, on the surface `retiredEngagementWrites`
 * structurally cannot reach.
 *
 * That census drives every mutating route *under a valuation id* out of the
 * route table, which is what makes it survive a route added tomorrow. A fund
 * portfolio and a debt instrument are addressed by their own ids — 0086/0087
 * built both as standalone ops tools keyed to nothing, and 0110 gave them an
 * engagement link afterwards — so the whole measurement surface sat outside its
 * shape. Neither route file contained a single retirement check.
 *
 * Same method as the census it extends, and for the same reason: every request
 * is sent twice, once against a live engagement's subject and once against a
 * retired one, with an identical body. The live 2xx proves the request was
 * well-formed and reached the handler, so the retired 409 can only have come
 * from the guard. A one-sided test would pass on a 422 from body validation.
 */
describe.skipIf(!dbUp)('measurement writes against a retired engagement', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let engineStub: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  /** { live, retired } subject ids, per measurement kind. */
  let liveFund: string;
  let retiredFund: string;
  let livePosition: string;
  let retiredPosition: string;
  let liveInstrument: string;
  let retiredInstrument: string;
  /**
   * Retired engagements with nothing linked to them, for the link-direction
   * test. One per kind: both link routes check the engagement's kind *before*
   * they check its state, so a fund engagement offered to the debt route is
   * refused as the wrong kind and never reaches the guard under test.
   */
  let spareRetiredFundValuation: string;
  let spareRetiredDebtValuation: string;
  /** `METHOD /registered/path` → the statuses this file drove out of it. */
  const driven = new Map<string, Set<number>>();

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/fund-rollforward', async (req) => {
      const b = req.body as Record<string, number>;
      return {
        prior_fair_value: b.prior_fair_value,
        new_fair_value: b.prior_fair_value! * 1.1,
        change: b.prior_fair_value! * 0.1,
        method: 'index',
      };
    });
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

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      ENGINE_URL: `http://127.0.0.1:${enginePort}`,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    // Which registered route each request in this file actually reached, and
    // with what status. `req.routeOptions.url` is the pattern Fastify matched,
    // not the concrete URL, so it joins straight onto the route table — which
    // is what lets the census at the bottom check the sweep against the
    // registry rather than against its own list of what it meant to send.
    app.addHook('onResponse', async (req, reply) => {
      const url = req.routeOptions.url;
      if (!url) return;
      const key = `${req.method} ${url}`;
      driven.set(key, (driven.get(key) ?? new Set()).add(reply.statusCode));
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

    const fundLinkedTo = async (valuationId: string, name: string): Promise<string> => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/funds',
        headers: authHeader(ops.token),
        payload: { name, fund_type: 'vc', currency: 'USD' },
      });
      if (created.statusCode !== 201) throw new Error(`create fund failed: ${created.body}`);
      const id = created.json().fund.id as string;
      const linked = await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${id}/valuation`,
        headers: authHeader(ops.token),
        payload: { valuation_id: valuationId },
      });
      if (linked.statusCode !== 200) throw new Error(`link fund failed: ${linked.body}`);
      return id;
    };

    const positionIn = async (fundId: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/funds/${fundId}/positions`,
        headers: authHeader(ops.token),
        payload: { company_name: 'PortCo', security_type: 'preferred', quantity: 100, cost_basis: 1000 },
      });
      if (res.statusCode !== 201) throw new Error(`create position failed: ${res.body}`);
      const pid = res.json().position.id as string;
      // A prior mark, so the roll-forward has something to roll. Written
      // directly: the mark route is one of the things under test.
      await pool.query(
        `INSERT INTO fund_marks (id, position_id, measurement_date, method, fair_value, level, inputs)
         VALUES ($1, $2, current_date, 'cost', 1000, 3, '{}')`,
        [newUlid(), pid],
      );
      return pid;
    };

    const instrumentLinkedTo = async (valuationId: string, name: string): Promise<string> => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/debt/instruments',
        headers: authHeader(ops.token),
        payload: { name, instrument_type: 'credit_spread', currency: 'USD', params: { face_value: 1e6 } },
      });
      if (created.statusCode !== 201) throw new Error(`create instrument failed: ${created.body}`);
      const id = created.json().instrument.id as string;
      const linked = await app.inject({
        method: 'PUT',
        url: `/api/v1/debt/instruments/${id}/valuation`,
        headers: authHeader(ops.token),
        payload: { valuation_id: valuationId },
      });
      if (linked.statusCode !== 200) throw new Error(`link instrument failed: ${linked.body}`);
      return id;
    };

    const liveFundValuation = await valuation('fund', 'Live Fund Engagement');
    const retiredFundValuation = await valuation('fund', 'Retired Fund Engagement');
    const liveDebtValuation = await valuation('debt', 'Live Debt Engagement');
    const retiredDebtValuation = await valuation('debt', 'Retired Debt Engagement');
    spareRetiredFundValuation = await valuation('fund', 'Retired Unlinked Fund Engagement');
    spareRetiredDebtValuation = await valuation('debt', 'Retired Unlinked Debt Engagement');

    liveFund = await fundLinkedTo(liveFundValuation, 'Live Fund I');
    retiredFund = await fundLinkedTo(retiredFundValuation, 'Retired Fund I');
    livePosition = await positionIn(liveFund);
    retiredPosition = await positionIn(retiredFund);
    liveInstrument = await instrumentLinkedTo(liveDebtValuation, 'Live Note');
    retiredInstrument = await instrumentLinkedTo(retiredDebtValuation, 'Retired Note');

    // Everything above was set up while the work was live. The withdrawal is
    // the last act, exactly as it is in life.
    //
    // Through `retireValuations`, not a raw UPDATE: `findValuationById` reads
    // through a cache, and every one of these rows is already in it from the
    // link calls above. A hand-written UPDATE leaves the guard under test
    // reading a row that still says `archived_at: null`, which is a
    // vacuous pass rather than a real one.
    const retired = await retireValuations(pool, [
      retiredFundValuation,
      retiredDebtValuation,
      spareRetiredFundValuation,
      spareRetiredDebtValuation,
    ]);
    if (retired.retired.length !== 4) throw new Error(`retire failed: ${JSON.stringify(retired)}`);
  });

  afterAll(async () => {
    await app?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  /**
   * Drive one request against both subjects. `live` is the control: without a
   * 2xx there, the retired 409 proves nothing.
   */
  async function pair(
    method: 'POST' | 'PUT' | 'PATCH',
    url: (subject: string, position: string) => string,
    payload: unknown,
    subjects: { live: [string, string]; retired: [string, string] },
  ): Promise<{ live: number; retired: number }> {
    const send = async (s: [string, string]) =>
      (await app.inject({ method, url: url(s[0], s[1]), headers: authHeader(ops.token), payload }))
        .statusCode;
    return { live: await send(subjects.live), retired: await send(subjects.retired) };
  }

  const funds = () => ({
    live: [liveFund, livePosition] as [string, string],
    retired: [retiredFund, retiredPosition] as [string, string],
  });
  const debts = () => ({
    live: [liveInstrument, ''] as [string, string],
    retired: [retiredInstrument, ''] as [string, string],
  });

  it.each([
    [
      'renaming the portfolio',
      'PATCH' as const,
      (f: string) => `/api/v1/funds/${f}`,
      { name: 'Renamed Fund' },
    ],
    [
      'adding a holding',
      'POST' as const,
      (f: string) => `/api/v1/funds/${f}/positions`,
      { company_name: 'NewCo', quantity: 10, cost_basis: 100 },
    ],
    [
      'rewriting the LP waterfall terms',
      'PUT' as const,
      (f: string) => `/api/v1/funds/${f}/lp-terms`,
      { committed_capital: 1e7, contributed_capital: 5e6 },
    ],
  ])('refuses %s on a retired fund engagement', async (_label, method, url, payload) => {
    const { live, retired } = await pair(method, (f) => url(f), payload, funds());
    expect(live).toBeLessThan(300);
    expect(retired).toBe(409);
  });

  it('refuses editing a holding on a retired fund engagement', async () => {
    const { live, retired } = await pair(
      'PATCH',
      (f, p) => `/api/v1/funds/${f}/positions/${p}`,
      { quantity: 200 },
      funds(),
    );
    expect(live).toBe(200);
    expect(retired).toBe(409);
  });

  /**
   * The consequential one. `domain/navExhibits.ts` sums the *stored* marks at
   * render time, so a mark written after retirement moves the NAV of a report
   * the firm has already issued — and retirement is reversible, so it is still
   * there when the engagement comes back.
   */
  it('refuses recording a new mark on a retired fund engagement', async () => {
    const { live, retired } = await pair(
      'POST',
      (f, p) => `/api/v1/funds/${f}/positions/${p}/marks`,
      { measurement_date: '2026-01-31', method: 'cost' },
      funds(),
    );
    expect(live).toBe(201);
    expect(retired).toBe(409);

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM fund_marks WHERE position_id = $1 AND measurement_date = '2026-01-31'",
      [retiredPosition],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('refuses recording a rolled-forward mark, while leaving the preview open', async () => {
    const preview = { method: 'index', index_return: 0.1, periods: 1, record: false };
    const recorded = { ...preview, record: true, measurement_date: '2026-02-28' };

    // The read half is a calculator that persists nothing, so it stays open on
    // withdrawn work like every other read on this platform.
    const previews = await pair(
      'POST',
      (f, p) => `/api/v1/funds/${f}/positions/${p}/rollforward`,
      preview,
      funds(),
    );
    expect(previews.live).toBe(200);
    expect(previews.retired).toBe(200);

    const writes = await pair(
      'POST',
      (f, p) => `/api/v1/funds/${f}/positions/${p}/rollforward`,
      recorded,
      funds(),
    );
    expect(writes.live).toBe(201);
    expect(writes.retired).toBe(409);
  });

  it.each([
    ['editing the instrument', 'PUT' as const, (i: string) => `/api/v1/debt/instruments/${i}`, {}],
    [
      'rewriting its credit terms',
      'PUT' as const,
      (i: string) => `/api/v1/debt/instruments/${i}/credit-terms`,
      { rating: 'BB', seniority: 'senior', secured: true },
    ],
  ])('refuses %s on a retired debt engagement', async (_label, method, url, payload) => {
    const { live, retired } = await pair(method, (i) => url(i), payload, debts());
    expect(live).toBeLessThan(300);
    expect(retired).toBe(409);
  });

  it('refuses storing a debt valuation, while leaving the pricing run open', async () => {
    const priced = await pair(
      'POST',
      (i) => `/api/v1/debt/instruments/${i}/value`,
      { persist: false },
      debts(),
    );
    expect(priced.live).toBe(200);
    expect(priced.retired).toBe(200);

    const stored = await pair(
      'POST',
      (i) => `/api/v1/debt/instruments/${i}/value`,
      { persist: true },
      debts(),
    );
    expect(stored.live).toBeLessThan(300);
    expect(stored.retired).toBe(409);

    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM debt_valuations WHERE instrument_id = $1',
      [retiredInstrument],
    );
    expect(rows[0]!.n).toBe(0);
  });

  /**
   * The link direction, on both subjects.
   *
   * This one is not `refuseIfSubjectRetired` — there is no engagement on
   * the subject yet to read the state off — but `refuseIfRetired` against the
   * engagement named in the body, which is the only route on this surface
   * where the retirement being asked about arrives in the request. Both files
   * write it by hand, so both are driven: the debt half was guarded by R279
   * and left untested, and the census below is what turned that up.
   */
  it.each([
    [
      'fund portfolio',
      '/api/v1/funds',
      { name: 'Unattached Fund', fund_type: 'vc', currency: 'USD' },
      (body: Record<string, { id: string }>) => body.fund!.id,
      () => spareRetiredFundValuation,
    ],
    [
      'debt instrument',
      '/api/v1/debt/instruments',
      {
        name: 'Unattached Note',
        instrument_type: 'credit_spread',
        currency: 'USD',
        params: { face_value: 1e6 },
      },
      (body: Record<string, { id: string }>) => body.instrument!.id,
      () => spareRetiredDebtValuation,
    ],
  ])(
    'refuses attaching a %s to a retired engagement',
    async (_label, collection, payload, idOf, engagement) => {
      const spare = await app.inject({
        method: 'POST',
        url: collection,
        headers: authHeader(ops.token),
        payload,
      });
      expect(spare.statusCode).toBe(201);
      const subject = idOf(spare.json());
      const res = await app.inject({
        method: 'PUT',
        url: `${collection}/${subject}/valuation`,
        headers: authHeader(ops.token),
        payload: { valuation_id: engagement() },
      });
      expect(res.statusCode).toBe(409);
    },
  );

  /**
   * Detaching stays open, and deliberately: it is the step `DELETE /funds/:id`
   * tells the caller to take, and cleanup on a withdrawn file is the standing
   * exemption the whole retirement doctrine carries. Guarding it would leave a
   * retired engagement's portfolio undeletable forever.
   */
  it('still lets a retired engagement’s subject be detached and deleted', async () => {
    const detached = await app.inject({
      method: 'PUT',
      url: `/api/v1/funds/${retiredFund}/valuation`,
      headers: authHeader(ops.token),
      payload: { valuation_id: null },
    });
    expect(detached.statusCode).toBe(200);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/funds/${retiredFund}`,
      headers: authHeader(ops.token),
    });
    expect(deleted.statusCode).toBe(204);
  });

  /**
   * The gate that makes everything above survive the next route.
   *
   * R279 put a retirement guard on all ten mutating measurement routes and
   * R280–R281 put the same surface on the audit spine, but the sweep proving
   * it was a hand-written list of six `it`s. The valuation-scoped census this
   * file extends has been driven out of the route table since R89 for exactly
   * one reason — **a route added tomorrow is swept the day it is registered**
   * — and that property did not come across with the tests. So the eleventh
   * fund route would have been written, shipped and left unguarded with a
   * green measurement suite, which is the same way the first ten got there.
   *
   * Both halves are asserted against `printRoutes`, in both directions:
   *
   *   * every mutating route on the surface is classified here, so a new one
   *     fails this until somebody decides which side it is on; and
   *   * nothing classified here has stopped existing, so a route that is
   *     renamed or removed does not leave a line behind that reads as
   *     coverage.
   *
   * `driven` is what stops the guarded half being a declaration. It is
   * recorded by an `onResponse` hook from the requests the suite actually
   * sent, so a route can only be listed as guarded if this file drove a 409
   * out of it — a list entry with no test behind it fails.
   */
  describe('the census behind the sweep', () => {
    /**
     * Refuse a write aimed at a retired engagement. Each is driven above,
     * against a live subject and a retired twin, with an identical body.
     */
    const GUARDED = [
      'PATCH /api/v1/funds/:id',
      'POST /api/v1/funds/:id/positions',
      'PATCH /api/v1/funds/:id/positions/:pid',
      'POST /api/v1/funds/:id/positions/:pid/marks',
      'POST /api/v1/funds/:id/positions/:pid/rollforward',
      'PUT /api/v1/funds/:id/lp-terms',
      'PUT /api/v1/funds/:id/valuation',
      'PUT /api/v1/debt/instruments/:id',
      'PUT /api/v1/debt/instruments/:id/credit-terms',
      'PUT /api/v1/debt/instruments/:id/valuation',
      'POST /api/v1/debt/instruments/:id/value',
    ];

    /**
     * Open on a withdrawn file, each for a reason that predates this sweep.
     *
     * The three DELETEs are the standing cleanup exemption — `DELETE
     * /funds/:id` tells the caller to detach first, so guarding the detach or
     * the delete would leave a retired engagement's portfolio undeletable.
     * The waterfall and the calibration are calculators: they read LP terms,
     * call the engine and return the answer, persisting nothing, so they are
     * reads by the doctrine's own definition — "what stops is anything that
     * changes the file, produces a new artifact from it, or tells somebody
     * about it".
     *
     * A route landing here needs that argument made about it. The failure mode
     * this list has is a genuinely mutating route being parked in it to make
     * the census pass, which is why each one carries its reason.
     */
    const EXEMPT = [
      'DELETE /api/v1/funds/:id',
      'DELETE /api/v1/funds/:id/positions/:pid',
      'DELETE /api/v1/debt/instruments/:id',
      'POST /api/v1/funds/:id/waterfall',
      'POST /api/v1/funds/:id/calibrate',
    ];

    it('classifies every mutating route on the measurement surface', () => {
      expect(mutatingMeasurementRoutes(app)).toEqual([...GUARDED, ...EXEMPT].sort());
    });

    it('drove a refusal out of every route it calls guarded', () => {
      const undriven = GUARDED.filter((route) => !driven.get(route)?.has(409));
      expect(undriven).toEqual([]);
    });
  });
});
