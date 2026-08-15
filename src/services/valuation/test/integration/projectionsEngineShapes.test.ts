import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * What the projection route stores when the engine answers with something other
 * than the shape it expects.
 *
 * `projections.test.ts` drives a stub that always answers correctly, plus two
 * outright failures. What it never does is hand the route a *well-formed HTTP
 * 200 carrying the wrong types* — a null `years`, a numeric string, a
 * `terminal_method` the enum does not contain, an empty projections array.
 *
 * That is the case the route's `num` helper exists for, and its docblock
 * records three bugs that came from getting it wrong: `Number(null)` is 0, so
 * an absent terminal value was stored as a terminal value of zero (a claim
 * about the horizon rather than the absence of one), a null `years` never
 * reached its fallback, and a cleared terminal metric compared unequal to an
 * absent one so `recalculation_required` lied. None of those threw. They stored
 * a plausible wrong number, which is the failure mode this whole file is about.
 */

interface Override {
  status: number;
  body: unknown;
}

async function startEngineStub() {
  const stub = Fastify({ logger: false });
  let override: Override | null = null;

  stub.post('/engine/v1/projection', async (req, reply) => {
    if (override) return reply.code(override.status).send(override.body);
    const { inputs } = req.body as { inputs: Record<string, unknown> };
    const years = Number(inputs.years ?? 3);
    const base = Number(inputs.base_revenue ?? 1_000_000);
    const growth = Number(inputs.revenue_growth ?? 0.1);
    const projections = Array.from({ length: years }, (_, i) => {
      const revenue = base * (1 + growth) ** (i + 1);
      return { year: i + 1, revenue, ebitda: revenue * 0.3, free_cash_flow: revenue * 0.2 };
    });
    return {
      method: inputs.method ?? 'growth',
      years,
      tax_rate: inputs.tax_rate ?? 0.21,
      projections,
      free_cash_flows: projections.map((p) => p.free_cash_flow),
      terminal_method: inputs.terminal_method === 'none' ? null : (inputs.terminal_method ?? null),
      terminal_value: inputs.terminal_method === 'gordon' ? 5_000_000 : null,
    };
  });

  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    setOverride: (next: Override | null) => {
      override = next;
    },
  };
}

describe.skipIf(!dbUp)('financial projection — engine response shapes', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const HEALTHY = {
    method: 'growth',
    years: 3,
    base_revenue: 1_000_000,
    revenue_growth: 0.2,
    tax_rate: 0.21,
  };

  const run = (payload: Record<string, unknown> = HEALTHY, id = valuationId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/projection/run`,
      headers: authHeader(ops.token),
      payload,
    });

  const listRuns = (id = valuationId) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/projection`,
      headers: authHeader(ops.token),
    });

  const apply = (projectionId: string, id = valuationId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/projection/${projectionId}/apply`,
      headers: authHeader(ops.token),
      payload: {},
    });

  async function newValuation(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  /** Runs `body` as the engine's answer, then restores the honest stub. */
  async function withEngineAnswer<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
    engine.setOverride({ status: 200, body });
    try {
      return await fn();
    } finally {
      engine.setOverride(null);
    }
  }

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    valuationId = await newValuation('ShapeCo');
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  const FLOWS = [100_000, 120_000, 144_000];
  const ROWS = [
    { year: 1, revenue: 500_000, ebitda: 150_000, free_cash_flow: 100_000 },
    { year: 2, revenue: 600_000, ebitda: 180_000, free_cash_flow: 120_000 },
    { year: 3, revenue: 720_000, ebitda: 216_000, free_cash_flow: 144_000 },
  ];

  describe('figures that are not numbers', () => {
    it('reads numeric strings, which is how pg hands back a numeric', async () => {
      const res = await withEngineAnswer(
        {
          method: 'growth',
          years: '3',
          tax_rate: '0.21',
          projections: ROWS,
          free_cash_flows: ['100000', '120000', '144000'],
          terminal_method: 'gordon',
          terminal_value: '5000000',
        },
        () => run(),
      );
      expect(res.statusCode).toBe(201);
      const p = res.json().projection;
      expect(Number(p.years)).toBe(3);
      expect(Number(p.tax_rate)).toBeCloseTo(0.21, 6);
      expect(Number(p.terminal_value)).toBe(5_000_000);
      expect(p.free_cash_flows.map(Number)).toEqual(FLOWS);
    });

    it('falls back to the stream length when the engine states no year count', async () => {
      // The bug this guards: `Number(null)` is 0, so a null `years` produced 0
      // rather than null and never reached the `?? flows.length` fallback — and
      // 0 then fails the row's `years >= 1` check as a 500.
      const res = await withEngineAnswer(
        { method: 'growth', years: null, projections: ROWS, free_cash_flows: FLOWS },
        () => run(),
      );
      expect(res.statusCode).toBe(201);
      expect(Number(res.json().projection.years)).toBe(FLOWS.length);
    });

    it('records no terminal value as absent rather than as zero', async () => {
      // A stored 0.00 reads as "the horizon is worth nothing", which is a claim.
      // Absent is the truth: no terminal method was struck.
      const res = await withEngineAnswer(
        {
          method: 'growth',
          years: 3,
          projections: ROWS,
          free_cash_flows: FLOWS,
          terminal_method: null,
          terminal_value: null,
        },
        () => run(),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json().projection.terminal_value).toBeNull();
      expect(res.json().projection.terminal_method).toBeNull();
    });

    it('treats booleans, empty strings and arrays as absent, not as zero', async () => {
      // All three are `Number`-coercible to a figure nobody wrote.
      const res = await withEngineAnswer(
        {
          method: 'growth',
          years: true,
          tax_rate: '',
          projections: ROWS,
          free_cash_flows: FLOWS,
          terminal_value: [],
        },
        () => run(),
      );
      expect(res.statusCode).toBe(201);
      const p = res.json().projection;
      expect(Number(p.years)).toBe(FLOWS.length);
      expect(Number(p.tax_rate)).toBe(0);
      expect(p.terminal_value).toBeNull();
    });

    it('drops non-numeric entries from the cash-flow stream', async () => {
      const res = await withEngineAnswer(
        {
          method: 'growth',
          years: 3,
          projections: ROWS,
          free_cash_flows: [100_000, 'nonsense', null, 144_000],
        },
        () => run(),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json().projection.free_cash_flows.map(Number)).toEqual([100_000, 144_000]);
    });
  });

  describe('shapes the route does not understand', () => {
    it('422s an answer whose cash-flow stream is empty, missing or not a list', async () => {
      // The engine raises on every input it cannot project, so an empty stream
      // means it answered with something this route does not understand.
      // Storing it would put a forecast with no cash flows in front of an
      // analyst as though it were one.
      for (const body of [
        { projections: ROWS, free_cash_flows: [] },
        { projections: ROWS },
        { projections: ROWS, free_cash_flows: 'not a list' },
        { projections: ROWS, free_cash_flows: ['all', 'junk'] },
      ]) {
        const res = await withEngineAnswer(body, () => run());
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json().detail).toMatch(/no cash flows/i);
      }
    });

    it('stores an unrecognised terminal method as none rather than passing it through', async () => {
      // `terminal_method` is a closed set on the row. An engine that invents a
      // third value must not widen it by writing through.
      const res = await withEngineAnswer(
        {
          method: 'growth',
          years: 3,
          projections: ROWS,
          free_cash_flows: FLOWS,
          terminal_method: 'perpetuity_with_flair',
          terminal_value: 1_000,
        },
        () => run(),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json().projection.terminal_method).toBeNull();
    });

    it('stores any method that is not driver as growth', async () => {
      for (const [sent, stored] of [
        ['driver', 'driver'],
        ['growth', 'growth'],
        ['freehand', 'growth'],
        [null, 'growth'],
      ] as const) {
        const res = await withEngineAnswer(
          { method: sent, years: 3, projections: ROWS, free_cash_flows: FLOWS },
          () => run(),
        );
        expect(res.statusCode, String(sent)).toBe(201);
        expect(res.json().projection.method, String(sent)).toBe(stored);
      }
    });

    it('accepts an answer with no per-year rows, and reports no terminal figures', async () => {
      // `present` derives the terminal EBITDA and revenue from the last row, so
      // an empty build must report null rather than reading `.at(-1)` of
      // nothing.
      const res = await withEngineAnswer(
        { method: 'growth', years: 3, projections: 'not a list', free_cash_flows: FLOWS },
        () => run(),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json().projection.terminal_ebitda).toBeNull();
      expect(res.json().projection.terminal_revenue).toBeNull();
    });
  });

  describe('adoption against an odd build', () => {
    it('adopts a run with no rows without writing revenues or a terminal metric', async () => {
      const id = await newValuation('EmptyRowsCo');
      const created = await withEngineAnswer(
        { method: 'growth', years: 3, projections: [], free_cash_flows: FLOWS },
        () => run(HEALTHY, id),
      );
      expect(created.statusCode).toBe(201);

      const res = await apply(created.json().projection.id as string, id);
      expect(res.statusCode).toBe(200);
      expect(res.json().applied_free_cash_flows.map(Number)).toEqual(FLOWS);
      // No terminal year, so nothing to strike a multiple on and no warning to
      // give — the warning is for a terminal EBITDA that exists and is unusable.
      expect(res.json().adopted_terminal_metric).toBeNull();
      expect(res.json().terminal_metric_warning).toBeNull();
      expect(res.json().recalculation_required).toBe(true);
    });

    it('does not write revenues when the two streams are different lengths', async () => {
      // `revenues` is only adopted when it lines up with the cash-flow column;
      // a mismatched pair would put two different horizons in one document.
      const id = await newValuation('MismatchCo');
      const created = await withEngineAnswer(
        { method: 'growth', years: 3, projections: ROWS.slice(0, 2), free_cash_flows: FLOWS },
        () => run(HEALTHY, id),
      );
      expect(created.statusCode).toBe(201);
      const res = await apply(created.json().projection.id as string, id);
      expect(res.statusCode).toBe(200);

      const inputs = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${id}/engine-inputs`,
        headers: authHeader(ops.token),
      });
      const incomeSection = (inputs.json().engine_inputs.income ?? {}) as Record<string, unknown>;
      expect(incomeSection.free_cash_flows).toBeTruthy();
      expect(incomeSection.revenues).toBeUndefined();
    });

    it('reports the run as adopted on the listing once it has been', async () => {
      const id = await newValuation('AdoptedFlagCo');
      const created = await run(HEALTHY, id);
      expect(created.statusCode).toBe(201);

      const before = await listRuns(id);
      expect(before.json().applied_matches_run).toBe(false);
      expect(before.json().applied_free_cash_flows).toBeNull();

      expect((await apply(created.json().projection.id as string, id)).statusCode).toBe(200);

      const after = await listRuns(id);
      expect(after.json().applied_matches_run).toBe(true);
      expect(after.json().applied_free_cash_flows).toBeTruthy();
    });
  });

  it('404s an apply naming a projection id that is not a ulid', async () => {
    const res = await apply('not-a-ulid');
    expect(res.statusCode).toBe(404);
  });
});
