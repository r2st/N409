import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The financial projection — the build behind the DCF's cash flows.
 *
 * Four claims carry this feature, and each of them is a thing that was wrong
 * before there was a test for it:
 *
 *   * running never moves the engagement's figures, and adopting is a separate,
 *     operations-only call that writes through the ordinary inputs path;
 *   * `recalculation_required` answers for *every* field adoption writes. It
 *     compared the cash flows alone, so adopting a run whose terminal-year
 *     EBITDA differed — on the identical cash-flow column, which is the usual
 *     case, because the column was generally typed *from* a run — reported that
 *     nothing had moved while the exit-multiple terminal value, and so the
 *     concluded value, had;
 *   * a terminal-year EBITDA of zero or less is never adopted as
 *     `terminal_metric`. Both other writers of `engine_inputs` refuse it, and
 *     adoption was the one path that did not;
 *   * an absent figure is absent. `Number(null)` is `0`, so a run struck with
 *     no terminal method recorded a terminal value of zero — a claim about the
 *     horizon rather than the absence of one.
 */

/** One forecast year, as engine/projection.py builds it. */
interface Year {
  year: number;
  revenue: number;
  cogs: number;
  opex: number;
  ebitda: number;
  da: number;
  ebit: number;
  nopat: number;
  capex: number;
  delta_nwc: number;
  fcff: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Growth-mode `project_financials`, mirrored.
 *
 * The arithmetic is reproduced rather than stubbed to a fixed payload because
 * the assertions below turn on the *relationship* between EBITDA and FCFF —
 * two runs with the same cash flows and different terminal EBITDA is the case
 * `recalculation_required` was getting wrong, and a canned response cannot
 * express it. Only the paths these tests exercise are implemented; the engine's
 * own suite owns the rest.
 */
function projectGrowth(inputs: Record<string, unknown>) {
  const years = Number(inputs.years ?? 1);
  const base = Number(inputs.base_revenue);
  const taxRate = Number(inputs.tax_rate ?? 0.21);
  const vec = (v: unknown): number[] =>
    Array.isArray(v) ? (v as number[]) : Array.from({ length: years }, () => Number(v ?? 0));

  const growth = vec(inputs.revenue_growth);
  const cogsPct = vec(inputs.cogs_pct);
  const opexPct = vec(inputs.opex_pct);
  const daPct = vec(inputs.da_pct);
  const capexPct = vec(inputs.capex_pct);
  const nwcPct = vec(inputs.nwc_pct);

  const revenue: number[] = [];
  let prev = base;
  for (let i = 0; i < years; i += 1) {
    prev *= 1 + (growth[i] ?? 0);
    revenue.push(prev);
  }

  const projections: Year[] = [];
  const freeCashFlows: number[] = [];
  let priorNwc = base * (nwcPct[0] ?? 0);
  for (let i = 0; i < years; i += 1) {
    const rev = revenue[i]!;
    const cogs = rev * (cogsPct[i] ?? 0);
    const opex = rev * (opexPct[i] ?? 0);
    const da = rev * (daPct[i] ?? 0);
    const capex = rev * (capexPct[i] ?? 0);
    const nwcLevel = rev * (nwcPct[i] ?? 0);
    const ebit = rev - cogs - opex - da;
    const ebitda = ebit + da;
    const nopat = ebit * (1 - taxRate);
    const deltaNwc = nwcLevel - priorNwc;
    const fcff = nopat + da - capex - deltaNwc;
    priorNwc = nwcLevel;
    freeCashFlows.push(round2(fcff));
    projections.push({
      year: i + 1,
      revenue: round2(rev),
      cogs: round2(cogs),
      opex: round2(opex),
      ebitda: round2(ebitda),
      da: round2(da),
      ebit: round2(ebit),
      nopat: round2(nopat),
      capex: round2(capex),
      delta_nwc: round2(deltaNwc),
      fcff: round2(fcff),
    });
  }

  // Only the terminal methods these tests reach; `none` is the absence of one,
  // and the engine reports it back as a null terminal value.
  let terminalValue: number | null = null;
  if (inputs.terminal_method === 'exit_multiple') {
    const last = projections.at(-1)!;
    const metric = inputs.exit_metric === 'revenue' ? last.revenue : last.ebitda;
    terminalValue = round2(metric * Number(inputs.exit_multiple));
  } else if (inputs.terminal_method === 'gordon') {
    const g = Number(inputs.terminal_growth ?? 0);
    const r = Number(inputs.discount_rate);
    terminalValue = round2((freeCashFlows.at(-1)! * (1 + g)) / (r - g));
  }

  return {
    method: 'growth',
    years,
    tax_rate: taxRate,
    projections,
    free_cash_flows: freeCashFlows,
    terminal_method: inputs.terminal_method ?? null,
    terminal_value: terminalValue,
  };
}

/** Stands in for `engine/v1/projection`, with a hook for the failure paths. */
async function startEngineStub() {
  const stub = Fastify({ logger: false });
  let override: { status: number; body: unknown } | null = null;

  stub.post('/engine/v1/projection', async (req, reply) => {
    if (override) return reply.code(override.status).send(override.body);
    const { inputs } = req.body as { inputs: Record<string, unknown> };
    return projectGrowth(inputs);
  });

  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    setOverride: (next: { status: number; body: unknown } | null) => {
      override = next;
    },
  };
}

describe.skipIf(!dbUp)('financial projection', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let engine: Awaited<ReturnType<typeof startEngineStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let stranger: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const get = (token = ops.token, id = valuationId) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/projection`,
      headers: authHeader(token),
    });

  const run = (payload: Record<string, unknown>, token = ops.token, id = valuationId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/projection/run`,
      headers: authHeader(token),
      payload,
    });

  const apply = (projectionId: string, token = ops.token, id = valuationId) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/projection/${projectionId}/apply`,
      headers: authHeader(token),
      payload: {},
    });

  const income = async (id = valuationId) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/engine-inputs`,
      headers: authHeader(ops.token),
    });
    return (res.json().engine_inputs.income ?? {}) as Record<string, unknown>;
  };

  const patchIncome = (patch: Record<string, unknown>, id = valuationId) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${id}/engine-inputs`,
      headers: authHeader(ops.token),
      payload: { income: patch },
    });

  const newValuation = async (name: string) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    return created.json().valuation.id as string;
  };

  /** A five-year forecast with a healthy margin. */
  const HEALTHY = {
    method: 'growth',
    years: 5,
    base_revenue: 1_000_000,
    revenue_growth: 0.2,
    cogs_pct: 0.4,
    opex_pct: 0.3,
    da_pct: 0.05,
    capex_pct: 0.06,
    nwc_pct: 0.1,
    tax_rate: 0.21,
  };

  beforeAll(async () => {
    engine = await startEngineStub();
    ctx = await setupTestApp({ ENGINE_URL: engine.url });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
    stranger = await seedUser(ctx, { roles: ['valuation_user'] });
    valuationId = await newValuation('ForecastCo');
  });

  afterAll(async () => {
    await ctx?.teardown();
    await engine?.close();
  });

  // ── Who may see it, and who may move it ───────────────────────────────────

  it('is invisible to someone who cannot read the engagement', async () => {
    expect((await get(stranger.token)).statusCode).toBe(404);
  });

  it('refuses a non-analyst on the role before it looks the engagement up', async () => {
    // 403 rather than 404, and deliberately: the role check runs first, so the
    // answer is the same whether or not the engagement exists and a stranger
    // learns nothing from it. A 404 here would have to be produced by a lookup,
    // which is the thing that would leak.
    const missing = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect((await run(HEALTHY, stranger.token)).statusCode).toBe(403);
    expect((await run(HEALTHY, stranger.token, missing)).statusCode).toBe(403);
  });

  it('lets the engagement owner read the build but not strike one', async () => {
    expect((await get(client.token)).statusCode).toBe(200);
    const res = await run(HEALTHY, client.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toContain('operations-only');
  });

  it('answers 404 for an id that is not a ulid rather than looking it up', async () => {
    expect((await get(ops.token, 'not-a-ulid')).statusCode).toBe(404);
  });

  it('starts with nothing forecast and no stream adopted', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().projections).toEqual([]);
    expect(res.json().applied_free_cash_flows).toBeNull();
    expect(res.json().applied_matches_run).toBe(false);
  });

  // ── Running ───────────────────────────────────────────────────────────────

  it('builds a forecast and stores the assumptions it was struck on', async () => {
    const res = await run(HEALTHY);
    expect(res.statusCode).toBe(201);
    const p = res.json().projection;

    expect(p.method).toBe('growth');
    expect(p.years).toBe(5);
    expect(p.free_cash_flows).toHaveLength(5);
    expect(p.projections).toHaveLength(5);
    // The assumptions are the disclosure — the flows cannot be checked without
    // them, so the run carries what it was asked for.
    expect(p.inputs.base_revenue).toBe(1_000_000);
    expect(p.inputs.cogs_pct).toBe(0.4);
    expect(p.applied_at).toBeNull();

    // Revenue compounds at the growth rate off the base.
    expect(p.projections[0].revenue).toBeCloseTo(1_200_000, 2);
    expect(p.projections[4].revenue).toBeCloseTo(1_000_000 * 1.2 ** 5, 2);
    // EBITDA is revenue less COGS and OpEx — D&A is added back.
    expect(p.projections[0].ebitda).toBeCloseTo(1_200_000 * 0.3, 2);
    // And the figure an exit multiple would be struck on is the terminal year's.
    expect(p.terminal_ebitda).toBeCloseTo(p.projections[4].ebitda, 2);
    expect(p.terminal_revenue).toBeCloseTo(p.projections[4].revenue, 2);
  });

  it('does not touch the financial model — running is not adopting', async () => {
    expect(await income()).toEqual({});
    const listed = await get();
    expect(listed.json().projections).toHaveLength(1);
    expect(listed.json().applied_free_cash_flows).toBeNull();
  });

  it('records a run struck with no terminal method as having none, not as zero', async () => {
    // `Number(null)` is 0, so a null terminal value was stored as 0.00 and
    // presented as a terminal value of zero — a claim about the horizon rather
    // than the absence of one.
    const res = await run({ ...HEALTHY, terminal_method: 'none' });
    expect(res.statusCode).toBe(201);
    expect(res.json().projection.terminal_value).toBeNull();
    expect(res.json().projection.terminal_method).toBeNull();
  });

  it('strikes an exit multiple on the terminal year and records the method', async () => {
    const res = await run({
      ...HEALTHY,
      terminal_method: 'exit_multiple',
      exit_multiple: 8,
      exit_metric: 'ebitda',
    });
    expect(res.statusCode).toBe(201);
    const p = res.json().projection;
    expect(p.terminal_method).toBe('exit_multiple');
    expect(p.terminal_value).toBeCloseTo(p.terminal_ebitda * 8, 0);
  });

  // ── What the run body refuses ─────────────────────────────────────────────

  it('refuses an assumption the engine has no field for', async () => {
    // `.strict()` here rather than a TypeError from `project_financials(**inputs)`
    // at the far end.
    const res = await run({ ...HEALTHY, ebitda_margin: 0.3 });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('Invalid projection assumptions');
  });

  it('refuses a margin typed as a percentage rather than a fraction', async () => {
    // 60 for a 60% margin is 6,000%, and is caught before it compounds.
    expect((await run({ ...HEALTHY, cogs_pct: 60 })).statusCode).toBe(422);
  });

  it('refuses a forecast horizon past the engine bound', async () => {
    expect((await run({ ...HEALTHY, years: 101 })).statusCode).toBe(422);
    expect((await run({ ...HEALTHY, years: 0 })).statusCode).toBe(422);
  });

  it('refuses an exit metric outside the closed set', async () => {
    // The engine reads anything it does not recognise as revenue; the enum here
    // means the caller hears about it instead.
    const res = await run({
      ...HEALTHY,
      terminal_method: 'exit_multiple',
      exit_multiple: 8,
      exit_metric: 'EBITDA',
    });
    expect(res.statusCode).toBe(422);
  });

  // ── When the engine will not answer ───────────────────────────────────────

  it('reports an engine rejection as a 422 carrying the engine’s reason', async () => {
    engine.setOverride({ status: 422, body: { detail: 'base_revenue must be positive' } });
    try {
      const res = await run(HEALTHY);
      expect(res.statusCode).toBe(422);
      // The upstream's own sentence, which is the useful part, plus the two
      // halves R198 added around it: what failed, and where to go and fix it.
      expect(res.json().detail).toContain('base_revenue must be positive');
      expect(res.json().detail).toContain('The calculation could not be run');
      expect(res.json().detail).toContain('parameters');
    } finally {
      engine.setOverride(null);
    }
  });

  it('reports an engine outage as a 502, not as a valuation problem', async () => {
    engine.setOverride({ status: 500, body: { detail: 'boom' } });
    try {
      const res = await run(HEALTHY);
      expect(res.statusCode).toBe(502);
    } finally {
      engine.setOverride(null);
    }
  });

  it('refuses to store a run with no cash flows in it', async () => {
    // The engine raises on every input it cannot project, so an empty stream
    // means it answered with something this route does not understand. Storing
    // it would put a forecast with no forecast in front of an analyst.
    engine.setOverride({
      status: 200,
      body: { method: 'growth', years: 5, projections: [], free_cash_flows: [] },
    });
    try {
      const res = await run(HEALTHY);
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('no cash flows');
    } finally {
      engine.setOverride(null);
    }
  });

  // ── Adopting ──────────────────────────────────────────────────────────────

  it('will not adopt a run that belongs to another engagement', async () => {
    const otherId = await newValuation('NeighbourCo');
    const mine = (await run(HEALTHY)).json().projection.id;
    // The run exists; it is simply not this engagement's to adopt.
    expect((await apply(mine, ops.token, otherId)).statusCode).toBe(404);
    expect((await apply('01ARZ3NDEKTSV4RRFFQ69G5FAV')).statusCode).toBe(404);
    expect((await apply('not-a-ulid')).statusCode).toBe(404);
  });

  it('writes the stream, the revenues and the terminal metric, and says so', async () => {
    const target = await newValuation('AdoptCo');
    const created = (await run(HEALTHY, ops.token, target)).json().projection;

    const res = await apply(created.id, ops.token, target);
    expect(res.statusCode).toBe(200);
    expect(res.json().recalculation_required).toBe(true);
    expect(res.json().projection.applied_at).not.toBeNull();

    const after = await income(target);
    expect(after.free_cash_flows).toEqual(created.free_cash_flows);
    expect(after.revenues).toHaveLength(5);
    expect(after.terminal_metric).toBeCloseTo(created.terminal_ebitda, 2);
    expect(after.terminal_metric_basis).toBe('ebitda');
    // The engine's own terminal value is deliberately not adopted: income_dcf
    // computes its own, and writing both would put it in the valuation twice.
    expect(after.terminal_value).toBeUndefined();

    const listed = await get(ops.token, target);
    expect(listed.json().applied_free_cash_flows).toEqual(created.free_cash_flows);
    expect(listed.json().applied_matches_run).toBe(true);
  });

  it('leaves the analyst’s methodology choices alone', async () => {
    const target = await newValuation('MergeCo');
    await patchIncome({ discount_rate: 0.18, terminal_growth: 0.03, mid_year_convention: true }, target);
    const created = (await run(HEALTHY, ops.token, target)).json().projection;
    await apply(created.id, ops.token, target);

    const after = await income(target);
    expect(after.discount_rate).toBe(0.18);
    expect(after.terminal_growth).toBe(0.03);
    expect(after.mid_year_convention).toBe(true);
    expect(after.free_cash_flows).toEqual(created.free_cash_flows);
  });

  it('reports nothing to recalculate when the adoption moved nothing', async () => {
    const target = await newValuation('IdempotentCo');
    const created = (await run(HEALTHY, ops.token, target)).json().projection;

    expect((await apply(created.id, ops.token, target)).json().recalculation_required).toBe(true);
    // The same run again writes the same four fields.
    expect((await apply(created.id, ops.token, target)).json().recalculation_required).toBe(false);
  });

  /**
   * The regression this file exists for.
   *
   * `recalculation_required` compared `free_cash_flows` alone. Two runs can
   * share a cash-flow column and differ in terminal-year EBITDA — with no tax
   * and no working capital, FCFF is EBITDA less CapEx, so moving a point of
   * margin into CapEx leaves the stream untouched and lowers EBITDA. The
   * exit-multiple terminal value is struck on that EBITDA, so the concluded
   * value moves and the panel used to say it had not.
   */
  it('reports a recalculation when only the terminal metric moved', async () => {
    const target = await newValuation('SameFlowsCo');
    const flat = { ...HEALTHY, tax_rate: 0, da_pct: 0, nwc_pct: 0, revenue_growth: 0 };

    const a = (await run({ ...flat, opex_pct: 0.3, capex_pct: 0.05 }, ops.token, target)).json().projection;
    const b = (await run({ ...flat, opex_pct: 0.32, capex_pct: 0.03 }, ops.token, target)).json().projection;

    // Same stream, figure for figure...
    expect(b.free_cash_flows).toEqual(a.free_cash_flows);
    // ...and a genuinely different terminal metric, so the assertion below
    // cannot pass by coincidence.
    expect(b.terminal_ebitda).not.toBeCloseTo(a.terminal_ebitda, 2);

    expect((await apply(a.id, ops.token, target)).json().recalculation_required).toBe(true);
    const second = await apply(b.id, ops.token, target);
    expect(second.json().recalculation_required).toBe(true);
    expect((await income(target)).terminal_metric).toBeCloseTo(b.terminal_ebitda, 2);
  });

  /**
   * The other half of the same problem: a figure adoption must not write.
   *
   * `PATCH /engine-inputs` refuses a non-positive `terminal_metric` and
   * `approaches.income_dcf` refuses to price against one. Adoption wrote it
   * anyway, so a loss-making forecast reached `engine_inputs` by the one path
   * that did not check — and the 422 arrived on whoever next pressed Calculate.
   */
  it('does not adopt a terminal metric an exit multiple cannot be struck against', async () => {
    const target = await newValuation('LossCo');
    // Costs above revenue: every year loses money, so terminal EBITDA is negative.
    const lossy = { ...HEALTHY, cogs_pct: 0.7, opex_pct: 0.6, da_pct: 0, capex_pct: 0, nwc_pct: 0 };
    const created = (await run(lossy, ops.token, target)).json().projection;
    expect(created.terminal_ebitda).toBeLessThan(0);

    const res = await apply(created.id, ops.token, target);
    expect(res.statusCode).toBe(200);
    expect(res.json().adopted_terminal_metric).toBeNull();
    expect(res.json().terminal_metric_warning).toContain('exit multiple cannot be struck');

    const after = await income(target);
    // The stream itself is a legitimate forecast and is adopted.
    expect(after.free_cash_flows).toEqual(created.free_cash_flows);
    // The metric is not, and the document holds nothing the other two writers
    // of it would refuse.
    expect(after.terminal_metric).toBeNull();
    expect(after.terminal_metric_basis).toBeNull();
  });

  it('clears a stale terminal metric rather than striking the multiple on a superseded forecast', async () => {
    const target = await newValuation('TurnedCo');
    const healthy = (await run(HEALTHY, ops.token, target)).json().projection;
    await apply(healthy.id, ops.token, target);
    expect((await income(target)).terminal_metric).toBeCloseTo(healthy.terminal_ebitda, 2);

    const lossy = { ...HEALTHY, cogs_pct: 0.7, opex_pct: 0.6, da_pct: 0, capex_pct: 0, nwc_pct: 0 };
    const revised = (await run(lossy, ops.token, target)).json().projection;
    const res = await apply(revised.id, ops.token, target);

    expect(res.json().recalculation_required).toBe(true);
    // Leaving the earlier run's EBITDA in place would price the horizon off a
    // forecast this engagement no longer uses — which computes cleanly, and is
    // wrong.
    expect((await income(target)).terminal_metric).toBeNull();
  });

  it('records the adoption in the audit trail with the stream it replaced', async () => {
    const target = await newValuation('AuditedCo');
    const created = (await run(HEALTHY, ops.token, target)).json().projection;
    await apply(created.id, ops.token, target);

    const { rows } = await ctx.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM admin_events
        WHERE subject_id = $1 AND type = 'projection_applied'`,
      [target],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.projection_id).toBe(created.id);
    expect(rows[0]!.payload.to).toEqual(created.free_cash_flows);
    expect(rows[0]!.payload.from).toBeNull();
  });

  it('is the engagement owner’s to read and the analyst’s to adopt', async () => {
    const target = await newValuation('PermCo');
    const created = (await run(HEALTHY, ops.token, target)).json().projection;
    const res = await apply(created.id, client.token, target);
    expect(res.statusCode).toBe(403);
    // And nothing was written on the way to the refusal.
    expect(await income(target)).toEqual({});
  });
});
