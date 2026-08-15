import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

interface StubState {
  requests: Array<Record<string, unknown>>;
  failWith: number | null;
  citations: Array<{ url: string; title?: string }>;
  /** The field the route actually reads — see ResearchAnswer.synthesized. */
  synthesized: boolean;
}

async function startAiStub(state: StubState) {
  const stub = Fastify({ logger: false });
  stub.post('/ai/v1/research', async (req, reply) => {
    state.requests.push(req.body as Record<string, unknown>);
    if (state.failWith !== null) {
      return reply.status(state.failWith).send({ detail: 'stubbed research outage' });
    }
    return reply.status(200).send({
      model: 'sonar',
      content: 'The sector traded at 4.2x forward revenue in Q2 2026.',
      citations: state.citations,
      synthesized: state.synthesized,
      tokens: 812,
    });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

/**
 * What the research route assembles a question *from*, and what it does when a
 * source of facts is empty rather than absent.
 *
 * `research.test.ts` covers the containment rules — the company's own name never
 * leaves, a guideline lookup of the subject is refused, a re-run supersedes. It
 * runs against a fully-populated engagement, so `publicFacts` only ever took the
 * arm where every field is present, and `routes/research.ts` sat at 68% branch
 * coverage.
 *
 * The empty arms matter for a specific reason. `publicFacts` reads overwrite
 * rows whose values are user-typed, and a whitespace-only industry code is not
 * a code — it is a blank somebody tabbed through. Sent as a fact it becomes part
 * of a question asked of a search provider, which is both a wasted call and a
 * worse answer.
 */
describe.skipIf(!dbUp)('market research — the facts a question is built from', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let aiStub: Awaited<ReturnType<typeof startAiStub>>;
  const state: StubState = { requests: [], failWith: null, citations: [], synthesized: true };
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const COMPANY = 'Zorblatt Dynamics';
  const ULID_ABSENT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

  const run = (body: Record<string, unknown>, id = valuationId, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/research`,
      headers: authHeader(token),
      payload: body,
    });

  const listResearch = (id = valuationId, token = ops.token) =>
    app.inject({ method: 'GET', url: `/api/v1/valuations/${id}/research`, headers: authHeader(token) });

  const lastQuestion = () => String(state.requests.at(-1)?.query ?? '');

  const setOverwrite = (key: string, value: unknown) =>
    pool.query(
      `INSERT INTO overwrites (id, valuation_id, category, field_key, class, value, created_by)
       VALUES ($5, $1, 'company_info', $2, 'character', $3::jsonb, $4)
       ON CONFLICT (valuation_id, field_key) DO UPDATE SET value = EXCLUDED.value`,
      [valuationId, key, JSON.stringify(value), ops.id, newUlid()],
    );

  const clearOverwrites = () => pool.query('DELETE FROM overwrites WHERE valuation_id = $1', [valuationId]);

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
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: COMPANY },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await db?.teardown();
  });

  // ── publicFacts ───────────────────────────────────────────────────────────
  describe('the facts a question is built from', () => {
    const setProfileIndustry = (industry: string | null) =>
      pool.query(
        `INSERT INTO company_profiles (valuation_id, industry) VALUES ($1, $2)
         ON CONFLICT (valuation_id) DO UPDATE SET industry = EXCLUDED.industry`,
        [valuationId, industry],
      );

    it('carries an industry code the analyst set as an overwrite', async () => {
      state.requests = [];
      await setProfileIndustry(null);
      await setOverwrite('industry_id', '7372');
      const res = await run({ topic: 'industry_outlook' });
      expect(res.statusCode, res.body).toBe(201);
      expect(lastQuestion()).toContain('7372');
      // Never the company, whatever else the question carries.
      expect(lastQuestion()).not.toContain(COMPANY);
    });

    it('prefers the company profile’s industry when it has one', async () => {
      state.requests = [];
      await setProfileIndustry('industrial robotics');
      const res = await run({ topic: 'industry_overview' });
      expect(res.statusCode, res.body).toBe(201);
      expect(lastQuestion()).toContain('industrial robotics');
      expect(lastQuestion()).not.toContain(COMPANY);
    });

    it('treats a whitespace-only industry as absent rather than as a fact', async () => {
      // This is the assertion the trim exists for. A blank somebody tabbed
      // through is not an industry; sent as one it becomes part of a question
      // asked of a search provider — a wasted call and a worse answer. Refusing
      // is the right outcome, and it is only reachable if the blank was
      // recognised as absent.
      await clearOverwrites();
      await setProfileIndustry('   ');
      const res = await run({ topic: 'industry_outlook' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/needs the industry/i);
    });

    it('treats a whitespace-only or null overwrite as absent too', async () => {
      await setProfileIndustry(null);
      for (const value of ['   ', null, '']) {
        await setOverwrite('industry_id', value);
        const res = await run({ topic: 'industry_outlook' });
        expect(res.statusCode, JSON.stringify(value)).toBe(422);
        expect(res.json().detail).toMatch(/needs the industry/i);
      }
    });

    it('refuses rather than asking a question with a hole in it', async () => {
      // A brand-new engagement has neither source. The route stops here rather
      // than sending "the  industry" to a provider and storing whatever comes
      // back as research.
      await clearOverwrites();
      await setProfileIndustry(null);
      const res = await run({ topic: 'industry_outlook' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/Company tab/);
    });
  });

  // ── Refusals ──────────────────────────────────────────────────────────────
  describe('refusals', () => {
    it('422s a topic or region outside the closed set', async () => {
      for (const body of [{ topic: 'astrology' }, { topic: 'industry_outlook', region: 'mars' }, {}]) {
        const res = await run(body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
      }
    });

    it('422s a run whose prompt row has been disabled', async () => {
      await pool.query(
        `INSERT INTO company_profiles (valuation_id, industry) VALUES ($1, 'industrial robotics')
         ON CONFLICT (valuation_id) DO UPDATE SET industry = EXCLUDED.industry`,
        [valuationId],
      );
      // The prompt registry is the off switch. A disabled topic must refuse
      // before the call, not spend the quota and then be ignored.
      await pool.query(`UPDATE ai_prompts SET enabled = false WHERE pipeline = 'industry_outlook'`);
      try {
        const res = await run({ topic: 'industry_outlook' });
        expect(res.statusCode).toBe(422);
        expect(res.json().detail).toMatch(/disabled/i);
      } finally {
        await pool.query(`UPDATE ai_prompts SET enabled = true WHERE pipeline = 'industry_outlook'`);
      }
    });

    it('404s a malformed or absent engagement on both run and read', async () => {
      for (const id of ['not-a-ulid', ULID_ABSENT]) {
        expect((await run({ topic: 'industry_outlook' }, id)).statusCode, `run ${id}`).toBe(404);
        expect((await listResearch(id)).statusCode, `read ${id}`).toBe(404);
      }
    });

    it('is ops-only to run but readable by the engagement owner', async () => {
      const forbidden = await run({ topic: 'industry_outlook' }, valuationId, client.token);
      expect(forbidden.statusCode).toBe(403);
      const readable = await listResearch(valuationId, client.token);
      expect(readable.statusCode).toBe(200);
      expect(readable.json().can_run).toBe(false);
    });
  });

  // ── Grounding ─────────────────────────────────────────────────────────────
  describe('whether a row counts as grounded', () => {
    beforeAll(async () => {
      await pool.query(
        `INSERT INTO company_profiles (valuation_id, industry) VALUES ($1, 'industrial robotics')
         ON CONFLICT (valuation_id) DO UPDATE SET industry = EXCLUDED.industry`,
        [valuationId],
      );
    });

    it('is not grounded with no citations, however confident the answer', async () => {
      // Sources are necessary. An ungrounded paragraph reads exactly like a
      // grounded one, which is why the flag is computed rather than trusted.
      state.citations = [];
      state.synthesized = true;
      const res = await run({ topic: 'industry_overview' });
      expect(res.statusCode).toBe(201);
      const rows = (await listResearch()).json().research as Array<{ topic: string; grounded: boolean }>;
      expect(rows.find((r) => r.topic === 'industry_overview')!.grounded).toBe(false);
    });

    it('is not grounded when the synthesiser says it did not synthesise', async () => {
      // And not sufficient: citations plus `synthesized: false` is a row that
      // has sources it did not read.
      state.citations = [{ url: 'https://example.com/a', title: 'A' }];
      state.synthesized = false;
      // `market_conditions` is asked of one market, so it needs a region.
      const res = await run({ topic: 'market_conditions', region: 'us' });
      expect(res.statusCode).toBe(201);
      const rows = (await listResearch()).json().research as Array<{
        topic: string;
        grounded: boolean;
        synthesized: boolean | null;
      }>;
      const row = rows.find((r) => r.topic === 'market_conditions')!;
      expect(row.grounded).toBe(false);
      // The tab needs to say *which* of the two reasons, so both travel.
      expect(row.synthesized).toBe(false);
    });

    it('is grounded with citations and a synthesis', async () => {
      state.citations = [{ url: 'https://example.com/b', title: 'B' }];
      state.synthesized = true;
      const res = await run({ topic: 'competitor_analysis' });
      expect(res.statusCode).toBe(201);
      const rows = (await listResearch()).json().research as Array<{
        topic: string;
        grounded: boolean;
        stale: boolean;
      }>;
      const row = rows.find((r) => r.topic === 'competitor_analysis')!;
      expect(row.grounded).toBe(true);
      // Freshly written, so not stale — the flag exists and is computed.
      expect(row.stale).toBe(false);
    });
  });

  // ── refresh-all ───────────────────────────────────────────────────────────
  describe('refresh-all', () => {
    beforeAll(async () => {
      await pool.query(
        `INSERT INTO company_profiles (valuation_id, industry) VALUES ($1, 'industrial robotics')
         ON CONFLICT (valuation_id) DO UPDATE SET industry = EXCLUDED.industry`,
        [valuationId],
      );
    });

    it('reports a failing topic instead of discarding the answers already retrieved', async () => {
      // One provider 503 must not throw away four good answers — the whole
      // reason each topic's failure is collected rather than raised.
      state.failWith = 503;
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${valuationId}/research/refresh-all`,
          headers: authHeader(ops.token),
          payload: {},
        });
        expect(res.statusCode).toBe(200);
        const results = res.json().results as Array<{ topic: string; ok: boolean; error?: string }>;
        expect(results.length).toBeGreaterThan(0);
        expect(results.every((r) => !r.ok)).toBe(true);
        expect(results.every((r) => typeof r.error === 'string' && r.error.length > 0)).toBe(true);
        // The subject-taking topic is skipped: there is no defensible way to
        // guess a guideline company.
        expect(results.map((r) => r.topic)).not.toContain('company_overview');
      } finally {
        state.failWith = null;
      }
    });

    it('422s a region it does not recognise', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/research/refresh-all`,
        headers: authHeader(ops.token),
        payload: { region: 'atlantis' },
      });
      expect(res.statusCode).toBe(422);
    });
  });
});
