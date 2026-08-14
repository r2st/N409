import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The fourth copy of a decoder that split the file on `<...>` and read the
// bytes inside as Latin-1. The renderer embeds a subsetted Unicode face, so
// those bytes are glyph indices private to the document; only the face's
// /ToUnicode CMap turns them back into letters. `support/pdfText.ts` delegates
// to the renderer's own reader, which is the only one that can be right.
import { readable } from './support/pdfText.js';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createValuation, type ValuationRow } from '../../src/repos/valuations.js';
import { VALUATION_KINDS } from '../../src/domain/valuation.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/**
 * The deliverable for the two measurement kinds, end to end: link a portfolio
 * or an instrument to its engagement (migration 0109), then render the report
 * and read what a client would actually download.
 *
 * The point of the exercise is the join. Both domains had complete engines and
 * complete CRUD and still produced a report with no figures in it, because
 * nothing connected `fund_portfolios` / `debt_instruments` to a valuation. So
 * these tests assert on the rendered PDF rather than on the exhibit builders —
 * navExhibits.test.ts covers the arithmetic; what could silently regress here
 * is the wiring between the two.
 */

const actor = { actorType: 'human' as const, source: 'test' };

describe.skipIf(!dbUp)('the fund and debt deliverables', () => {
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

    // Enough of the two engines to make the routes persist a real mark and a
    // real valuation — the figures the report then reads back.
    engineStub = Fastify({ logger: false });
    engineStub.post('/engine/v1/fund-valuation', async (req) => {
      const body = req.body as Record<string, any>;
      const positions = (body.positions ?? []).map((p: Record<string, any>) => {
        const cost = Number(p.cost_basis ?? 0);
        const marketPrice = Number(p.quoted_price ?? 0);
        const roundPrice = Number(p.round_price_per_share ?? 0);
        const qty = Number(p.quantity ?? 0);
        const fv =
          p.method === 'market'
            ? qty * marketPrice
            : p.method === 'last_round'
              ? qty * roundPrice
              : p.method === 'calibrated_opm'
                ? Number(p.model_value ?? 0)
                : cost;
        const level = p.method === 'market' ? 1 : p.method === 'last_round' ? 2 : 3;
        return { name: p.name, method: p.method, level, quantity: qty, cost_basis: cost, fair_value: fv };
      });
      return { positions, gross_asset_value: 0, level_breakdown: {} };
    });
    engineStub.post('/engine/v1/debt-valuation', async () => ({
      fair_value: 967_432.11,
      clean_price: 946_182.11,
      accrued_interest: 21_250,
      market_yield: 0.095,
      macaulay_duration: 3.4121,
      modified_duration: 3.2573,
      convexity: 13.8842,
      schedule: [
        { period: 1, t_years: 0.5, interest: 42_500, principal: 0, amount: 42_500, balance: 1_000_000 },
      ],
    }));
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
        EMAIL_MODE: 'off',
      }),
      pool,
    });
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

  // ── helpers ────────────────────────────────────────────────────────────────

  const opsGet = (url: string) => app.inject({ method: 'GET', url, headers: authHeader(ops.token) });
  const opsSend = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
    app.inject({ method, url, headers: authHeader(ops.token), payload: payload as never });

  async function seedValuation(kind: string, company: string): Promise<ValuationRow> {
    return createValuation(
      pool,
      { kind: kind as never, companyName: company, userId: client.id, currency: 'USD' },
      { ...actor, actorId: client.id },
    );
  }

  async function pdfText(id: string): Promise<string> {
    await opsGet(`/api/v1/valuations/${id}/report`);
    const rendered = await opsSend('POST', `/api/v1/valuations/${id}/report/render`, {});
    expect(rendered.statusCode).toBe(200);
    const pdf = await opsGet(`/api/v1/valuations/${id}/report.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    return readable(pdf.rawPayload);
  }

  /** A fund with one quoted and one last-round holding, marked and linked. */
  async function seedFund(valuationId: string | null): Promise<string> {
    const created = await opsSend('POST', '/api/v1/funds', {
      name: 'Meridian Ventures II',
      fund_type: 'vc',
      currency: 'USD',
      vintage_year: 2021,
    });
    expect(created.statusCode).toBe(201);
    const fundId = created.json().fund.id as string;

    const holdings = [
      { company_name: 'Helios Public Co', mark_method: 'market', quoted_price: 4, quantity: 100_000 },
      {
        company_name: 'Northwind Robotics',
        mark_method: 'last_round',
        round_price_per_share: 9,
        quantity: 100_000,
      },
    ];
    for (const h of holdings) {
      const pos = await opsSend('POST', `/api/v1/funds/${fundId}/positions`, {
        company_name: h.company_name,
        security_type: 'preferred',
        quantity: h.quantity,
        cost_basis: 250_000,
        mark_method: h.mark_method,
      });
      expect(pos.statusCode).toBe(201);
      const mark = await opsSend(
        'POST',
        `/api/v1/funds/${fundId}/positions/${pos.json().position.id}/marks`,
        { measurement_date: '2026-06-30', method: h.mark_method, ...h },
      );
      expect(mark.statusCode).toBe(201);
    }

    await opsSend('PUT', `/api/v1/funds/${fundId}/lp-terms`, {
      committed_capital: 50_000_000,
      contributed_capital: 32_000_000,
      preferred_return_rate: 0.08,
      carry_pct: 0.2,
    });

    if (valuationId) {
      const link = await opsSend('PUT', `/api/v1/funds/${fundId}/valuation`, {
        valuation_id: valuationId,
      });
      expect(link.statusCode).toBe(200);
    }
    return fundId;
  }

  async function seedInstrument(valuationId: string | null): Promise<string> {
    const created = await opsSend('POST', '/api/v1/debt/instruments', {
      name: 'Northwind Senior Note 2030',
      instrument_type: 'bond',
      currency: 'USD',
      params: { face: 1_000_000, coupon_rate: 0.085, frequency: 2, maturity_years: 4, market_yield: 0.095 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().instrument.id as string;

    await opsSend('PUT', `/api/v1/debt/instruments/${id}/credit-terms`, {
      rating: 'BB',
      benchmark_yield: 0.042,
      spread: 0.053,
      seniority: 'senior_secured',
      secured: true,
    });
    const valued = await opsSend('POST', `/api/v1/debt/instruments/${id}/value`, {
      valuation_date: '2026-06-30',
    });
    expect(valued.statusCode).toBe(200);

    if (valuationId) {
      const link = await opsSend('PUT', `/api/v1/debt/instruments/${id}/valuation`, {
        valuation_id: valuationId,
      });
      expect(link.statusCode).toBe(200);
    }
    return id;
  }

  // ── the kinds themselves ───────────────────────────────────────────────────

  describe('the valuation_kind enum', () => {
    it('accepts every kind the domain declares', async () => {
      // domain/valuation.ts listed fifteen kinds while the enum carried
      // thirteen (0001), so creating a `fund` or `debt` engagement reached
      // Postgres and came back a 500 — with it, every downstream feature for
      // those kinds was unreachable. 0109 closes it; this keeps it closed, and
      // catches the next kind added to the constant without a migration.
      const { rows } = await pool.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'valuation_kind'`,
      );
      const inDb = new Set(rows.map((r) => r.enumlabel));
      expect([...VALUATION_KINDS].filter((k) => !inDb.has(k))).toEqual([]);
    });

    it('creates a fund and a debt engagement through the API', async () => {
      for (const kind of ['fund', 'debt'] as const) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/valuations',
          headers: authHeader(client.token),
          payload: { kind, company_name: `${kind} engagement`, currency: 'USD' },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().valuation.kind).toBe(kind);
      }
    });
  });

  // ── the link ───────────────────────────────────────────────────────────────

  describe('linking a measurement subject to its engagement', () => {
    it('refuses a portfolio on an engagement of another kind', async () => {
      const notAFund = await seedValuation('409a', 'Ashgrove Bio, Inc.');
      const fundId = await seedFund(null);
      const res = await opsSend('PUT', `/api/v1/funds/${fundId}/valuation`, {
        valuation_id: notAFund.id,
      });
      // A NAV schedule inside a common-stock opinion is the failure this stops.
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain("'409a'");
    });

    it('refuses a second portfolio on an engagement that already has one', async () => {
      const v = await seedValuation('fund', 'Meridian Ventures II');
      await seedFund(v.id);
      const second = await seedFund(null);
      const res = await opsSend('PUT', `/api/v1/funds/${second}/valuation`, { valuation_id: v.id });
      expect(res.statusCode).toBe(409);
    });

    it('404s an engagement that does not exist, and detaches on null', async () => {
      const fundId = await seedFund(null);
      const missing = await opsSend('PUT', `/api/v1/funds/${fundId}/valuation`, {
        valuation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      });
      expect(missing.statusCode).toBe(404);

      const v = await seedValuation('fund', 'Detachable Fund');
      await opsSend('PUT', `/api/v1/funds/${fundId}/valuation`, { valuation_id: v.id });
      const detached = await opsSend('PUT', `/api/v1/funds/${fundId}/valuation`, { valuation_id: null });
      expect(detached.statusCode).toBe(200);
      expect(detached.json().fund.valuation_id).toBeNull();
    });

    it('is operations-only', async () => {
      const fundId = await seedFund(null);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/funds/${fundId}/valuation`,
        headers: authHeader(client.token),
        payload: { valuation_id: null },
      });
      expect(res.statusCode).toBe(403);
    });

    it('refuses an instrument on an engagement of another kind', async () => {
      const notDebt = await seedValuation('fund', 'Not A Debt Engagement');
      const id = await seedInstrument(null);
      const res = await opsSend('PUT', `/api/v1/debt/instruments/${id}/valuation`, {
        valuation_id: notDebt.id,
      });
      expect(res.statusCode).toBe(422);
    });
  });

  // ── the rendered deliverable ───────────────────────────────────────────────

  describe('the fund NAV report', () => {
    it('renders the NAV schedules a client downloads', async () => {
      const v = await seedValuation('fund', 'Meridian Ventures II');
      await seedFund(v.id);
      const text = await pdfText(v.id);

      // The authored skeleton, which used to be the generic one.
      expect(text).toContain('Fair Value Hierarchy');
      expect(text).toContain('Net Asset Value');
      // The holdings, by name, from the marks the engine actually produced:
      // Helios 100,000 x $4 = 400,000 (Level 1); Northwind 100,000 x $9 =
      // 900,000 (Level 2). Gross 1,300,000 against 500,000 of cost.
      expect(text).toContain('Helios');
      expect(text).toContain('Northwind');
      expect(text).toContain('$1,300,000');
      expect(text).toContain('$800,000'); // unrealized gain
      // The LP terms exhibit.
      expect(text).toContain('$18,000,000'); // unfunded commitment
    });

    it('renders the authored body and no schedules when nothing is linked', async () => {
      const v = await seedValuation('fund', 'Unlinked Fund LP');
      const text = await pdfText(v.id);
      expect(text).toContain('Fair Value Hierarchy'); // the skeleton section
      // Asserted on figures, not headings: the authored body *names* every
      // exhibit ("The Portfolio Schedule exhibit records…"), so the heading is
      // in the prose either way. An empty NAV table implying a portfolio worth
      // nothing is the failure this avoids — the exhibit is absent, not zeroed.
      expect(text).not.toContain('Unrealized gain');
      expect(text).not.toContain('$0');
    });
  });

  describe('the debt instrument report', () => {
    it('renders the instrument, its yield and its cash flows', async () => {
      const v = await seedValuation('debt', 'Northwind Robotics, Inc.');
      await seedInstrument(v.id);
      const text = await pdfText(v.id);

      expect(text).toContain('Instrument Terms');
      expect(text).toContain('Contractual Cash Flows');
      expect(text).toContain('$967,432.11'); // fair value from the engine
      expect(text).toContain('8.500%'); // coupon, as a rate not a decimal
      expect(text).toContain('4.200%'); // benchmark from the credit terms
      expect(text).toContain('3.4121'); // Macaulay duration, as a number
    });

    it('renders the authored body and no schedules when nothing is linked', async () => {
      const v = await seedValuation('debt', 'Unlinked Credit Co');
      const text = await pdfText(v.id);
      expect(text).toContain('Credit Assessment'); // the skeleton section
      // As above — the body names the exhibits, so assert no figures reached it.
      expect(text).not.toContain('967,432');
      expect(text).not.toContain('8.500%');
    });
  });
});
