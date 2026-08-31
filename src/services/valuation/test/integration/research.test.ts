import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import { invalidateValuation } from '../../src/repos/valuations.js';

const dbUp = await isDbAvailable();

interface StubState {
  /** Every research request body the AI service received, in order. */
  requests: Array<Record<string, unknown>>;
  /**
   * Fail every call with this status until it is cleared. Not a one-shot:
   * `postJson` retries a 5xx once, so a stub that healed on the second attempt
   * would test the retry rather than the outage.
   */
  failWith: number | null;
  citations: Array<{ url: string; title?: string }>;
  /**
   * Run before the stub answers. The routes await this call, so it is the
   * interleaving point: whatever it does has committed by the time the handler
   * reaches the write.
   */
  onRequest: (() => Promise<void>) | null;
}

/** Stands in for POST /ai/v1/research so no test reaches a search provider. */
async function startAiStub(state: StubState) {
  const stub = Fastify({ logger: false });
  stub.post('/ai/v1/research', async (req, reply) => {
    state.requests.push(req.body as Record<string, unknown>);
    if (state.onRequest) await state.onRequest();
    if (state.failWith !== null) {
      return reply.status(state.failWith).send({ detail: 'stubbed research outage' });
    }
    return reply.status(200).send({
      model: 'sonar',
      content: 'The sector traded at 4.2x forward revenue in Q2 2026.',
      citations: state.citations,
      grounded: state.citations.length > 0,
      tokens: 812,
    });
  });
  stub.post('/ai/v1/pipelines/report_narrative', async (req, reply) => {
    state.requests.push({ __narrative: req.body });
    return reply.status(200).send({ model: 'stub', result: { sections: [] } });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

/**
 * Design §12.3 — the research adapter's caller.
 *
 * The cases that matter are the ones about what leaves the building: that the
 * question is built from public fields, that the company's own name never
 * reaches the provider, and that a re-run supersedes rather than overwrites so
 * a report's citation still means what it meant.
 */
describe.skipIf(!dbUp)('market research', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let aiStub: Awaited<ReturnType<typeof startAiStub>>;
  const state: StubState = {
    requests: [],
    failWith: null,
    citations: [{ url: 'https://example.com/sector-report', title: 'Sector report 2026' }],
    onRequest: null,
  };
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const COMPANY = 'Zorblatt Dynamics';

  const run = (body: Record<string, unknown>, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/research`,
      headers: authHeader(token),
      payload: body,
    });

  const list = (token = ops.token) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/research`,
      headers: authHeader(token),
    });

  const lastQuery = (): string => {
    const research = state.requests.filter((r) => typeof r.query === 'string');
    return research[research.length - 1]!.query as string;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    aiStub = await startAiStub(state);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AI_URL: aiStub.url,
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    const ctx = { app, pool, teardown: async () => {} };
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { email: 'owner@research.example', roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: COMPANY },
    });
    valuationId = created.json().valuation.id;

    // The two public facts a research question is allowed to know.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/company-profile`,
      headers: authHeader(ops.token),
      payload: { industry: 'industrial robotics' },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await db?.teardown();
  });

  it('seeds an enabled prompt row for every research topic', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/prompts',
      headers: authHeader(ops.token),
    });
    const prompts = res.json().prompts as Array<{ pipeline: string; enabled: boolean; model: string | null }>;
    for (const pipeline of [
      'market_research',
      'industry_overview',
      'industry_outlook',
      'competitor_analysis',
      'company_overview',
      'industry_finder',
    ]) {
      const row = prompts.find((p) => p.pipeline === pipeline);
      expect(row, `${pipeline} seeded`).toBeDefined();
      expect(row!.enabled).toBe(true);
      // Bound to a Sonar tier, not an OpenRouter model. Perplexity is the
      // primary research provider (0117, restored by 0124 after 0123 briefly
      // re-pointed these while it was removed), so the column names the tier
      // to ask Sonar for. The keyless search fallback ignores it rather than
      // forwarding it to OpenRouter — see `research.synthesis_model`.
      expect(row!.model, pipeline).toMatch(/^sonar/);
    }
  });

  it('serves the topic registry to ops and refuses everyone else', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/research/topics',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().topics).toHaveLength(6);

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/research/topics',
      headers: authHeader(client.token),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('runs a topic, stores the answer with its citations, and never sends the company name', async () => {
    const res = await run({ topic: 'industry_overview' });
    expect(res.statusCode).toBe(201);

    const query = lastQuery();
    expect(query).toContain('industrial robotics');
    expect(query.toLowerCase()).not.toContain('zorblatt');

    const stored = res.json().research;
    expect(stored.topic).toBe('industry_overview');
    expect(stored.citations[0].url).toBe('https://example.com/sector-report');
    // The question is kept as the evidence that only public fields travelled.
    expect(stored.question).toBe(query);
  });

  it('ships the registry’s system prompt and Sonar tier with the call', async () => {
    await run({ topic: 'industry_outlook' });
    const call = state.requests.filter((r) => typeof r.query === 'string').at(-1)!;
    expect(String(call.system)).toContain('valuation firm');
    expect(call.model).toBe('sonar-pro');
    // Outlook is time-sensitive; the registry pins how far back the search reaches.
    expect(call.recency).toBe('month');
  });

  it('supersedes the prior row for the same topic rather than overwriting it', async () => {
    await run({ topic: 'competitor_analysis' });
    const first = (await list())
      .json()
      .research.find((r: { topic: string }) => r.topic === 'competitor_analysis');
    await run({ topic: 'competitor_analysis' });

    const live = (await list())
      .json()
      .research.filter((r: { topic: string }) => r.topic === 'competitor_analysis');
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(first.id);

    // The old answer is still there, marked, because a report drafted from it
    // cites it and rewriting the answer under the citation would be a lie.
    const { rows } = await pool.query('SELECT superseded_at FROM market_research WHERE id = $1', [first.id]);
    expect(rows[0].superseded_at).not.toBeNull();
  });

  it('keeps region-scoped topics separate per market', async () => {
    await run({ topic: 'market_conditions', region: 'us' });
    await run({ topic: 'market_conditions', region: 'uk' });
    const live = (await list())
      .json()
      .research.filter((r: { topic: string }) => r.topic === 'market_conditions');
    expect(live.map((r: { region: string }) => r.region).sort()).toEqual(['uk', 'us']);
  });

  it('refuses a guideline lookup of the engagement’s own company', async () => {
    const res = await run({ topic: 'company_overview', subject: COMPANY });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/confidential/i);
  });

  it('refuses a subject on a topic that does not take one', async () => {
    const res = await run({ topic: 'industry_overview', subject: 'ABB Ltd' });
    expect(res.statusCode).toBe(422);
  });

  it('is ops-only to run and readable by the engagement’s owner', async () => {
    const denied = await run({ topic: 'industry_overview' }, client.token);
    expect(denied.statusCode).toBe(403);

    const read = await list(client.token);
    expect(read.statusCode).toBe(200);
    expect(read.json().can_run).toBe(false);
  });

  it('maps an AI-service outage to a problem response and stores nothing', async () => {
    const before = (await list()).json().research.length;
    state.failWith = 503;
    try {
      const res = await run({ topic: 'industry_finder' });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      // Nothing is persisted on a failed call: a research row exists to be
      // cited, and a row with no answer in it is worse than an absent one.
      expect((await list()).json().research.length).toBe(before);
    } finally {
      state.failWith = null;
    }
  });

  it('refresh-all reports each topic and skips the one needing an analyst’s subject', async () => {
    /*
     * The query count is asserted alongside the behaviour (R290). `publicFacts`
     * is two reads keyed on the engagement alone — the company profile and the
     * overwrites — and nothing it reads varies by topic. Asked inside the loop
     * it fetched the same two rows once per topic to build five objects
     * differing in one field, `region`, which is an input to the object and not
     * to either query.
     *
     * Counted on the statement so the assertion is about how many times the
     * question was asked rather than about how long it took.
     */
    let factReads = 0;
    const original = pool.query.bind(pool);
    (pool as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
      if (/FROM (company_profiles|overwrites)\b/.test(text)) factReads += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    let res;
    try {
      res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/research/refresh-all`,
        headers: authHeader(ops.token),
        payload: { region: 'ca' },
      });
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }
    expect(res.statusCode).toBe(200);
    const topics = (res.json().results as Array<{ topic: string }>).map((r) => r.topic);
    expect(topics).not.toContain('company_overview');
    expect(topics).toHaveLength(5);
    expect(res.json().succeeded).toBe(5);
    // Two: the profile and the overwrites, once for the run. Five topics ran,
    // so the per-topic form reads ten and this cannot pass vacuously.
    expect(factReads, `read the engagement's facts ${factReads} times for 5 topics`).toBe(2);
  });

  /**
   * A withdrawal landing while the research call is out.
   *
   * `RESEARCH_TIMEOUT_MS` is 150 seconds and `refresh-all` spends it once per
   * topic, so one press is up to twelve minutes of one request — which is the
   * window `refuseIfRetiredNow` was written for, in its own words: "a run is
   * exactly the length of time in which a decision about a file gets made". Its
   * doc names the two AI routes that write something of their own and were left
   * on the old reading; market research is the third, reached by a different
   * door and guarded only at the top of the handler.
   *
   * A row written past the withdrawal is not incidental to the request: the
   * research tab renders it and the report's market section cites it, and
   * retirement is reversible (R90), so it comes back with the engagement.
   *
   * Driven through the AI stub, which archives the engagement while answering,
   * so the ordering is enforced rather than slept on.
   */
  describe('an engagement withdrawn mid-run', () => {
    let withdrawnId: string;

    const rowsFor = async (id: string): Promise<number> => {
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM market_research WHERE valuation_id = $1',
        [id],
      );
      return rows[0]!.n;
    };

    const archiveOnce = (id: string) => {
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        await pool.query('UPDATE valuations SET archived_at = now() WHERE id = $1', [id]);
        // What every archive writer in the service does beside the UPDATE.
        // Without it this drives the 5s read-through cache, not the guard.
        invalidateValuation(id);
      };
    };

    beforeEach(async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(client.token),
        payload: { kind: '409a', company_name: 'Withdrawn Research Co' },
      });
      expect(created.statusCode, created.body).toBe(201);
      withdrawnId = created.json().valuation.id as string;
      // The public fact every topic's question is built from.
      const profile = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${withdrawnId}/company-profile`,
        headers: authHeader(ops.token),
        payload: { industry: 'industrial robotics' },
      });
      expect(profile.statusCode, profile.body).toBe(200);
    });

    afterEach(() => {
      state.onRequest = null;
    });

    it('refuses the single run rather than storing research against a closed file', async () => {
      state.onRequest = archiveOnce(withdrawnId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${withdrawnId}/research`,
        headers: authHeader(ops.token),
        payload: { topic: 'industry_overview' },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(await rowsFor(withdrawnId)).toBe(0);
    });

    it('stops refresh-all instead of spending the remaining topics on it', async () => {
      state.onRequest = archiveOnce(withdrawnId);
      const before = state.requests.length;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${withdrawnId}/research/refresh-all`,
        headers: authHeader(ops.token),
        payload: { region: 'un' },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(await rowsFor(withdrawnId)).toBe(0);
      // One AI call spent — the one already in flight when the withdrawal
      // landed — and not the four behind it.
      const asked = state.requests.slice(before).filter((r) => typeof r.query === 'string').length;
      expect(asked).toBe(1);
    });
  });

  it('threads grounded research into the narrative agent’s payload', async () => {
    // The value the whole feature exists to collect: the drafting agent sees
    // the sourced market answers rather than writing from the corpus alone.
    await pool.query(
      `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, results, equity_value, fmv_per_share)
       VALUES ($1, $2, 'test', 'succeeded', '{}', '{}', 1000000, 1.25)`,
      [newUlid(), valuationId],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/report_narrative`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);

    const narrative = state.requests.filter((r) => '__narrative' in r).at(-1)!.__narrative as Record<
      string,
      unknown
    >;
    const research = narrative.market_research as Array<{ topic: string; citations: unknown[] }>;
    expect(research.length).toBeGreaterThan(0);
    expect(research.every((r) => r.citations.length > 0)).toBe(true);
  });

  it('refuses to run a research prompt through the generic AI pipeline route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/market_research`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/research/i);
  });

  it('puts the sources in the evidence bundle, superseded rows included', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/evidence-bundle`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    // The zip is binary; the manifest count is what the assertion needs and it
    // is the field an auditor reads first.
    expect(res.headers['content-type']).toContain('zip');
  });
});
