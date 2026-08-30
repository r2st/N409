import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/**
 * What an AI job row says the run was drawn from.
 *
 * `ai_jobs.input.document_ids` is the provenance record — "which docs went in,
 * not their bytes", as the write puts it — and it was taken off the
 * engagement's whole corpus rather than off the payload. `encodeDocuments`
 * drops the non-extractable formats, anything over the per-file ceiling,
 * everything past the tenth document and everything past the request byte
 * budget; and the QA and narrative runs send no documents at all. So the row
 * named files the model never saw, which is the one thing a defensibility
 * record must not do.
 */
async function startAiStub() {
  const stub = Fastify({ logger: false });
  for (const [name, result] of [
    ['extract', { engine_inputs: {} }],
    ['report_narrative', { sections: [] }],
  ] as const) {
    stub.post(`/ai/v1/pipelines/${name}`, async (_req, reply) =>
      reply.status(200).send({ model: 'stub-model', result }),
    );
  }
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('an AI job records the documents that went', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let aiStub: Awaited<ReturnType<typeof startAiStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let textDocId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    aiStub = await startAiStub();
    app = buildApp({
      config: loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        JWT_SECRET: 'integration-test-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        AI_URL: aiStub.url,
        AUTO_PIPELINE: 'off',
        EMAIL_MODE: 'off',
      }),
      pool,
    });
    await app.ready();
    ops = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['reviewer'] });

    valuationId = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: 'Provenance, Inc.' },
      })
    ).json().valuation.id as string;

    // One extractable upload and one that is not. Both are on the engagement;
    // only the first can reach the model.
    textDocId = (await upload('cap-table.txt')).json().document.id as string;
    await upload('logo.png');

    await createCalculation(
      pool,
      {
        valuationId,
        engineVersion: '1.4.0',
        status: 'succeeded',
        inputs: { params: {}, inputs: {} },
        results: { equity_value: 42_000_000, fmv_per_share: 1.2345 },
        equityValue: 42_000_000,
        fmvPerShare: 1.2345,
        createdBy: ops.id,
      },
      { ...actor, actorId: ops.id },
    );
  });

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await db?.teardown();
  });

  async function upload(filename: string) {
    const boundary = '----n409test';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nother\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: text/plain\r\n\r\nplaceholder contents for ${filename}\r\n` +
      `--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: {
        ...authHeader(ops.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(body),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res;
  }

  const run = (pipeline: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/${pipeline}`,
      headers: authHeader(ops.token),
      payload: {},
    });

  const jobInput = async (pipeline: string) => {
    const { rows } = await pool.query<{ input: Record<string, unknown> }>(
      `SELECT input FROM ai_jobs WHERE valuation_id = $1 AND pipeline = $2
        ORDER BY created_at DESC LIMIT 1`,
      [valuationId, pipeline],
    );
    return rows[0]!.input;
  };

  it('names the extractable upload and not the one that could never be sent', async () => {
    expect((await run('extract')).statusCode).toBe(201);
    const input = await jobInput('extract');
    expect(input.document_ids).toEqual([textDocId]);
    // And says how much of the corpus that was, so "nothing on file" and "a
    // subset was sent" are distinguishable without reading the log.
    expect(input.documents_on_file).toBe(2);
  });

  it('names no document for the route that sends the agent none', async () => {
    // Drafting into the report passes `includeDocuments: false` — that agent
    // narrates a finished result rather than reading sources — so the payload
    // carries no corpus at all, while the row used to list the whole one.
    // First GET instantiates the skeleton the draft is applied to.
    await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/report`,
      headers: authHeader(ops.token),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/report/narrative`,
      headers: authHeader(ops.token),
      payload: { reuse: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    const input = await jobInput('report_narrative');
    expect(input.document_ids).toEqual([]);
    expect(input.documents_on_file).toBe(2);
  });
});
