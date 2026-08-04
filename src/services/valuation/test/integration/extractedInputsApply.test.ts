import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/**
 * The AI extraction pipeline writes into the same `engine_inputs` document the
 * analyst form writes into, and used to do it without any validation — so a
 * figure the form would have refused (a 6,500% volatility, a negative share
 * count) was stored anyway, and nothing in the UI shows it as anomalous.
 *
 * This exercises both apply paths end-to-end against a stub AI service that
 * returns exactly such a mixture: the good fields must land, the bad ones must
 * be reported and left out of the document.
 */
async function startAiStub(result: () => Record<string, unknown>) {
  const stub = Fastify({ logger: false });
  stub.post('/ai/v1/pipelines/extract', async (_req, reply) =>
    reply.send({ model: 'stub-model', result: result() }),
  );
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

const MIXED_EXTRACTION = {
  engine_inputs: {
    shares_outstanding_common: 8_000_000, // good
    cash: 1_200_000, // good
    volatility: 65, // a percentage the model forgot to convert
    risk_free_rate: 4.2, // ditto
    debt: -50_000, // negative money
    made_up_field: 42, // not an engine input at all
  },
};

describe.skipIf(!dbUp)('AI-extracted engine inputs are held to the hand-entry bounds', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let docsDir: string;
  let aiStub: Awaited<ReturnType<typeof startAiStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    docsDir = mkdtempSync(path.join(tmpdir(), 'n409-extract-'));
    aiStub = await startAiStub(() => MIXED_EXTRACTION);

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AI_URL: aiStub.url,
      DOCUMENTS_DIR: docsDir,
      // Background runs would race the assertions below.
      AUTO_PIPELINE: 'off',
    });
    app = buildApp({ config, pool });
    await app.ready();

    ops = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['reviewer'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'ExtractCo' },
    });
    valuationId = created.json().valuation.id;

    const boundary = '----n409extract';
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: { ...authHeader(ops.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload:
        `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\ncap_table\r\n` +
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="cap.csv"\r\ncontent-type: text/csv\r\n\r\nclass,shares\r\ncommon,8000000\r\n` +
        `--${boundary}--\r\n`,
    });
    expect(upload.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await db?.teardown();
    rmSync(docsDir, { recursive: true, force: true });
  });

  async function engineInputs(): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().engine_inputs as Record<string, unknown>;
  }

  it('auto-apply stores the sound figures and reports the rest', async () => {
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/extract`,
      headers: authHeader(ops.token),
      payload: { auto_apply: true },
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();

    expect(body.applied_inputs).toEqual({ shares_outstanding_common: 8_000_000, cash: 1_200_000 });
    expect((body.rejected_inputs as Array<{ field: string }>).map((r) => r.field).sort()).toEqual([
      'debt',
      'made_up_field',
      'risk_free_rate',
      'volatility',
    ]);

    // The job still records everything the model said — the audit trail must
    // show what was proposed, not only what survived.
    expect(body.job.result.engine_inputs.volatility).toBe(65);

    const stored = await engineInputs();
    expect(stored.shares_outstanding_common).toBe(8_000_000);
    expect(stored.cash).toBe(1_200_000);
    expect(stored).not.toHaveProperty('volatility');
    expect(stored).not.toHaveProperty('risk_free_rate');
    expect(stored).not.toHaveProperty('debt');
    expect(stored).not.toHaveProperty('made_up_field');
  });

  it('the manual apply of a stored extraction filters it the same way', async () => {
    // Clear what auto-apply wrote so this asserts its own effect.
    await pool.query(`UPDATE valuation_params SET engine_inputs = '{}'::jsonb WHERE valuation_id = $1`, [
      valuationId,
    ]);
    expect(await engineInputs()).toEqual({});

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/extract/apply`,
      headers: authHeader(ops.token),
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().applied_inputs).toEqual({
      shares_outstanding_common: 8_000_000,
      cash: 1_200_000,
    });
    expect(applied.json().rejected_inputs).toHaveLength(4);

    const stored = await engineInputs();
    expect(stored).toEqual({ shares_outstanding_common: 8_000_000, cash: 1_200_000 });
  });

  it('anything the AI path stored would also be accepted from the analyst form', async () => {
    // Re-submitting the stored document through the validated route is the
    // property in its plainest form: the two writers now agree.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/engine-inputs`,
      headers: authHeader(ops.token),
      payload: await engineInputs(),
    });
    expect(patched.statusCode).toBe(200);
  });
});
