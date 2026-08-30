import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * AI comparable discovery, end to end: agent run → peer set → market approach.
 *
 * The gap this closes is a wiring gap rather than a missing engine. The
 * `comp_selection` agent suggested, verified and refined a guideline set from
 * the day it was written; `comparable_items` has accepted an `'ai'` source since
 * migration 0119; nothing joined the two, so the agent's answer stayed in
 * `ai_jobs` and the market approach only ever saw comps somebody typed.
 *
 * The two properties worth the file are at the end: re-applying a re-run must
 * not re-admit a comp an analyst excluded on purpose, and must not touch the
 * rows they entered themselves. A discovery that silently reverted an analyst's
 * judgement every time it ran is one they would stop running.
 */

/** Replays a canned `comp_selection` result, overridable per test. */
async function startAiStub() {
  const stub = Fastify({ logger: false });
  let result: Record<string, unknown> = {
    selected: [
      {
        ticker: 'AAA',
        name: 'Alpha Analytics',
        sic_code: '7372',
        market_cap: 1_000,
        revenue: 100,
        ebitda_margin: 0.5,
        ev_revenue: 10,
        score: 0.82,
        score_breakdown: { industry: 1 },
        justification: 'Same segment, comparable scale.',
      },
      {
        ticker: 'BBB',
        name: 'Beta Systems',
        sic_code: '7372',
        market_cap: 3_000,
        revenue: 100,
        ebitda_margin: 0.4,
        ev_revenue: 30,
        score: 0.61,
      },
    ],
    excluded: [{ ticker: 'ZZZ', name: 'Zeta Mining', reason: 'different industry' }],
    market_data_verified: true,
  };
  stub.post('/ai/v1/pipelines/comp_selection', async () => ({ model: 'stub-model', result }));
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    setResult: (next: Record<string, unknown>) => {
      result = next;
    },
  };
}

interface ListedComparable {
  id: string;
  ticker: string | null;
  name: string;
  source: string;
  included: boolean;
  exclude_reason: string | null;
  ev: number | null;
  revenue_ltm: number | null;
  ebitda_ltm: number | null;
  figures_source: string | null;
  multiples: Record<string, number | null>;
}

describe.skipIf(!dbUp)('AI comparable discovery applied to the peer set', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ai: Awaited<ReturnType<typeof startAiStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const runAgent = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/comp_selection`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const apply = (token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/comp_selection/apply`,
      headers: authHeader(token),
      payload: {},
    });

  const list = async (): Promise<ListedComparable[]> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/comparables`,
        headers: authHeader(ops.token),
      })
    ).json().comparables;

  const byTicker = async (ticker: string) => (await list()).find((r) => r.ticker === ticker);

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    ai = await startAiStub();
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AI_URL: ai.url,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    ops = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['admin'] });
    client = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['valuation_user'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'DiscoveryCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await app?.close();
    await ai?.close();
    await db?.teardown();
  });

  it('refuses to apply before the agent has ever run', async () => {
    const res = await apply();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/run the comp_selection agent first/i);
  });

  it('is operations-only — the engagement owner cannot write their own peer set', async () => {
    const res = await apply(client.token);
    expect(res.statusCode).toBe(403);
  });

  it('writes the agent set with source "ai" and the multiples the agent reported', async () => {
    expect((await runAgent()).statusCode).toBe(201);

    const res = await apply();
    expect(res.statusCode).toBe(200);
    // `unverified` joined the summary with R216's verification gate; this
    // assertion is exact, so it has to carry the whole shape.
    expect(res.json().applied).toEqual({ selected: 2, excluded: 1, unusable: 0, unverified: 0 });

    const alpha = await byTicker('AAA');
    expect(alpha).toMatchObject({
      source: 'ai',
      name: 'Alpha Analytics',
      included: true,
      ev: 1_000,
      revenue_ltm: 100,
      ebitda_ltm: 50,
      figures_source: 'snapshot',
    });
    // The round trip that matters: the stored figures imply the agent's own
    // multiple, so the tab and Exhibit D-1 print what the agent produced.
    expect(alpha!.multiples.ev_revenue_ltm).toBe(10);
  });

  it('keeps the rejected half in the set, with the agent reason', async () => {
    const zeta = await byTicker('ZZZ');
    expect(zeta).toMatchObject({
      source: 'ai',
      included: false,
      exclude_reason: 'different industry',
    });
  });

  it('strikes the median from the included AI rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
    });
    expect(res.json().statistics.ev_revenue_ltm).toMatchObject({ count: 2, median: 20 });
  });

  it('records the application on the audit trail', async () => {
    const { rows } = await pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM admin_events
        WHERE subject_id = $1 AND type = 'comparables_ai_applied'
        ORDER BY occurred_at DESC LIMIT 1`,
      [valuationId],
    );
    expect(rows[0]?.payload).toMatchObject({ selected: 2, excluded: 1, written: 3 });
  });

  it('excludes a selected comp the market data could not price, rather than dropping it', async () => {
    ai.setResult({
      selected: [
        { ticker: 'AAA', name: 'Alpha Analytics', market_cap: 1_000, revenue: 100, ebitda_margin: 0.5 },
        { ticker: 'CCC', name: 'Gamma Holdings' },
      ],
      excluded: [],
    });
    expect((await runAgent()).statusCode).toBe(201);
    const res = await apply();
    expect(res.json().applied).toMatchObject({ unusable: 1 });

    const gamma = await byTicker('CCC');
    expect(gamma).toMatchObject({ included: false, ev: null });
    expect(gamma!.exclude_reason).toMatch(/no revenue to strike a multiple on/i);
  });

  it('carries an analyst exclusion forward across a re-run', async () => {
    // The analyst throws Alpha out by hand...
    const alpha = await byTicker('AAA');
    const excluded = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/comparables/${alpha!.id}`,
      headers: authHeader(ops.token),
      payload: { included: false, exclude_reason: 'litigation overhang' },
    });
    expect(excluded.statusCode).toBe(200);

    // ...and the agent, which knows nothing about that, selects it again.
    ai.setResult({
      selected: [
        { ticker: 'AAA', name: 'Alpha Analytics', market_cap: 1_000, revenue: 100, ebitda_margin: 0.5 },
      ],
      excluded: [],
    });
    expect((await runAgent()).statusCode).toBe(201);
    expect((await apply()).statusCode).toBe(200);

    const after = await byTicker('AAA');
    expect(after!.included).toBe(false);
    expect(after!.exclude_reason).toBe('litigation overhang');
  });

  it('leaves the analyst’s own rows alone', async () => {
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comparables`,
      headers: authHeader(ops.token),
      payload: { ticker: 'MINE', name: 'Hand Picked Co', ev: 500, revenue_ltm: 50 },
    });
    expect(added.statusCode).toBe(201);

    ai.setResult({
      selected: [
        { ticker: 'BBB', name: 'Beta Systems', market_cap: 3_000, revenue: 100, ebitda_margin: 0.4 },
      ],
      excluded: [],
    });
    expect((await runAgent()).statusCode).toBe(201);
    expect((await apply()).statusCode).toBe(200);

    const mine = await byTicker('MINE');
    expect(mine).toMatchObject({ source: 'analyst', included: true, ev: 500 });
  });

  it('refuses a run that named no company with a ticker', async () => {
    ai.setResult({ selected: [], excluded: [] });
    expect((await runAgent()).statusCode).toBe(201);
    const res = await apply();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/named no company with a ticker/i);
  });
});
