import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { newUlid } from '@n409/shared';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The company-profile agent, end to end: documents → agent → profile → report.
 *
 * `company_profiles` (0040) has always been hand-typed, the narrative agent has
 * always drafted a "Company Overview and Industry Analysis" section with no
 * structured company facts in front of it, and the comparable screen refuses to
 * run until somebody types a SIC code. This is gap #3 closed in the shape the
 * platform is built in — from the engagement's own documents rather than from a
 * web lookup of the client's name, which `domain/research.ts` is fenced against.
 *
 * The last two tests are the ones worth reading: an apply must not overwrite
 * what an analyst typed, and the profile has to actually reach the narrative
 * agent — a profile nothing reads would be a form nobody fills.
 */

const AGENT_RESULT = {
  business_description: 'Sells a subscription analytics platform to mid-market retailers.',
  industry: 'Retail analytics software',
  sic_codes: [{ code: '7372', title: 'Prepackaged Software' }],
  naics_codes: [{ code: '511210', title: 'Software Publishers' }],
  sic_code: '7372',
  naics_code: '511210',
  key_metrics: [{ key: 'revenue', value: '$4.2M ARR', source_document: 'deck.pdf' }],
  gaps: ['The documents do not state the customer count.'],
  confidence: 0.82,
};

/** Replays a canned `company_profile` result, and records the narrative payload. */
async function startAiStub(seen: Record<string, unknown>) {
  const stub = Fastify({ logger: false });
  let profileResult: Record<string, unknown> = AGENT_RESULT;
  stub.post('/ai/v1/pipelines/company_profile', async (req) => {
    seen.company_profile = req.body;
    return { model: 'stub-model', result: profileResult };
  });
  stub.post('/ai/v1/pipelines/report_narrative', async (req) => {
    seen.report_narrative = req.body;
    return { model: 'stub-model', result: { sections: [], section_keys: [] } };
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => stub.close(),
    setResult: (next: Record<string, unknown>) => {
      profileResult = next;
    },
  };
}

describe.skipIf(!dbUp)('company profile agent', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ai: Awaited<ReturnType<typeof startAiStub>>;
  const seen: Record<string, unknown> = {};
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const upload = () => {
    const boundary = '----n409profile';
    const payload = [
      `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\npitch_deck\r\n`,
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="deck.csv"\r\n` +
        `content-type: text/csv\r\n\r\nsummary\r\nAnalytics for retailers.\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    return app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: {
        ...authHeader(ops.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
  };

  const runAgent = (token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/company_profile`,
      headers: authHeader(token),
      payload: {},
    });

  const apply = (body: Record<string, unknown> = {}, token = ops.token) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/company_profile/apply`,
      headers: authHeader(token),
      payload: body,
    });

  const profile = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/company-profile`,
        headers: authHeader(ops.token),
      })
    ).json().profile as Record<string, unknown> | null;

  const patchProfile = (body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/company-profile`,
      headers: authHeader(ops.token),
      payload: body,
    });

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    ai = await startAiStub(seen);
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
      payload: { kind: '409a', company_name: 'ProfileCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await app?.close();
    await ai?.close();
    await db?.teardown();
  });

  it('seeds an enabled Bot Prompt row for the agent', async () => {
    const prompts = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/admin/prompts',
        headers: authHeader(ops.token),
      })
    ).json().prompts as Array<{ pipeline: string; enabled: boolean; label: string }>;
    const row = prompts.find((p) => p.pipeline === 'company_profile');
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
  });

  it('refuses to run with no documents — they are the agent’s only source', async () => {
    const res = await runAgent();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/upload at least one document/i);
  });

  it('refuses to apply before the agent has ever run', async () => {
    const res = await apply();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/run the company_profile agent first/i);
  });

  it('is operations-only', async () => {
    expect((await runAgent(client.token)).statusCode).toBe(403);
    expect((await apply({}, client.token)).statusCode).toBe(403);
  });

  it('runs the agent against the uploaded corpus', async () => {
    expect((await upload()).statusCode).toBe(201);
    const res = await runAgent();
    expect(res.statusCode).toBe(201);
    expect(res.json().job.status).toBe('succeeded');

    const payload = seen.company_profile as { documents?: unknown[] };
    expect(payload.documents).toHaveLength(1);
  });

  it('applies the draft to the four typed profile fields', async () => {
    const res = await apply();
    expect(res.statusCode).toBe(200);
    expect(res.json().applied_fields.sort()).toEqual([
      'business_description',
      'industry',
      'naics_code',
      'sic_code',
    ]);

    expect(await profile()).toMatchObject({
      business_description: AGENT_RESULT.business_description,
      industry: 'Retail analytics software',
      sic_code: '7372',
      naics_code: '511210',
    });
  });

  it('fills the blanks and holds back what an analyst typed, saying which', async () => {
    // The analyst classifies it themselves and clears the rest, so this run has
    // both something to write and something it must not touch.
    const edited = await patchProfile({
      sic_code: '3559',
      industry: null,
      business_description: null,
      naics_code: null,
    });
    expect(edited.statusCode).toBe(200);

    const res = await apply();
    expect(res.statusCode).toBe(200);
    expect(res.json().applied_fields.sort()).toEqual(['business_description', 'industry', 'naics_code']);
    expect(res.json().skipped_fields).toContainEqual({ field: 'sic_code', reason: 'already_set' });

    const after = (await profile())!;
    expect(after.sic_code).toBe('3559');
    expect(after.industry).toBe('Retail analytics software');
  });

  it('replaces it when overwrite is asked for explicitly', async () => {
    const res = await apply({ overwrite: true });
    expect(res.statusCode).toBe(200);
    expect((await profile())!.sic_code).toBe('7372');
  });

  it('refuses a malformed code typed by hand, at the same bound the agent uses', async () => {
    const res = await patchProfile({ sic_code: '73721' });
    expect(res.statusCode).toBe(422);
  });

  it('refuses a run that produced nothing usable', async () => {
    ai.setResult({ key_metrics: [], gaps: [] });
    expect((await runAgent()).statusCode).toBe(201);
    const res = await apply();
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/no usable field/i);
  });

  /**
   * The wiring that makes the profile worth filling: it reaches the narrative
   * agent, so the company-overview section is drafted from the business rather
   * than from whatever the params implied.
   */
  it('ships the profile to the report narrative agent', async () => {
    // The narrative agent refuses to run without a finished calculation, and
    // this test is about the profile rather than the engine — so the row goes
    // in directly, as dataRemediation.test.ts does.
    await pool.query(
      `INSERT INTO calculations
         (id, valuation_id, engine_version, status, inputs, results, equity_value, fmv_per_share)
       VALUES ($1, $2, 'test', 'succeeded', '{}'::jsonb, '{}'::jsonb, 10000000, 1.23)`,
      [newUlid(), valuationId],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/report_narrative`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);

    const payload = seen.report_narrative as { company_profile?: Record<string, unknown> };
    expect(payload.company_profile).toMatchObject({
      business_description: AGENT_RESULT.business_description,
      industry: 'Retail analytics software',
      sic_code: '7372',
    });
    // The identifying columns stay behind — the narrative agent has no section
    // that wants a legal name or a street address.
    expect(payload.company_profile).not.toHaveProperty('legal_name');
    expect(payload.company_profile).not.toHaveProperty('address_line1');
  });
});
