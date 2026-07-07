import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/** Stub upstream (ai/engine) that replays a canned handler per URL. */
async function startStub(
  routes: Record<string, (body: unknown) => Promise<{ status?: number; body: unknown }>>,
) {
  const stub = Fastify({ logger: false });
  for (const [url, handler] of Object.entries(routes)) {
    stub.post(url, async (req, reply) => {
      const { status = 200, body } = await handler(req.body);
      return reply.status(status).send(body);
    });
  }
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('improvement 2 — auto-pipeline on upload', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let pool: pg.Pool;
  let docsDir: string;
  let aiStub: Awaited<ReturnType<typeof startStub>>;
  let engineStub: Awaited<ReturnType<typeof startStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;

  let aiDelayMs = 0;
  let engineShouldFail = false;
  let extractCalls = 0;
  let lastEnginePayload: Record<string, unknown> | null = null;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    docsDir = mkdtempSync(path.join(tmpdir(), 'n409-autopipe-'));

    aiStub = await startStub({
      '/ai/v1/pipelines/extract': async () => {
        extractCalls += 1;
        if (aiDelayMs > 0) await sleep(aiDelayMs);
        return {
          body: {
            model: 'stub-model',
            result: {
              engine_inputs: {
                shares_outstanding_common: 8_000_000,
                volatility: 0.6,
                risk_free_rate: 0.04,
              },
            },
          },
        };
      },
    });
    engineStub = await startStub({
      '/engine/v1/compute': async (body) => {
        lastEnginePayload = body as Record<string, unknown>;
        if (engineShouldFail) {
          return { status: 422, body: { detail: 'volatility is required' } };
        }
        return {
          body: {
            engine_version: 'py-stub',
            results: { equity_value: 18_000_000, fmv_per_share: 1.23, approaches: {} },
          },
        };
      },
    });

    const baseEnv = {
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AI_URL: aiStub.url,
      ENGINE_URL: engineStub.url,
      DOCUMENTS_DIR: docsDir,
    };
    app = buildApp({ config: loadConfig({ ...baseEnv, AUTO_PIPELINE: 'on' }), pool });
    await app.ready();
    offApp = buildApp({ config: loadConfig({ ...baseEnv, AUTO_PIPELINE: 'off' }), pool });
    await offApp.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });
    otherClient = await seedUser(seedCtx, { roles: ['valuation_user'] });
  });

  afterAll(async () => {
    await app?.close();
    await offApp?.close();
    await aiStub?.close();
    await engineStub?.close();
    await db?.teardown();
    rmSync(docsDir, { recursive: true, force: true });
  });

  async function createValuation(token: string, company = 'AutoPipeCo'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  function upload(
    on: FastifyInstance,
    valuationId: string,
    token: string,
    opts: { filename: string; content?: string },
  ) {
    const boundary = '----n409autopipe';
    const payload =
      `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\nincome_statement\r\n` +
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
      `content-type: application/octet-stream\r\n\r\n${opts.content ?? 'revenue,100'}\r\n` +
      `--${boundary}--\r\n`;
    return on.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  }

  async function waitForTerminal(valuationId: string, token: string): Promise<Record<string, any>> {
    for (let i = 0; i < 200; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/pipeline`,
        headers: authHeader(token),
      });
      expect(res.statusCode).toBe(200);
      const { run } = res.json();
      if (run && (run.status === 'ready' || run.status === 'failed')) return run;
      await sleep(25);
    }
    throw new Error('pipeline run never reached a terminal status');
  }

  it('runs extract → param fill → draft calculation after an extractable upload', async () => {
    const valuationId = await createValuation(ops.token);
    const res = await upload(app, valuationId, ops.token, { filename: 'income.csv' });
    expect(res.statusCode).toBe(201);
    const { pipeline_run } = res.json();
    expect(pipeline_run).toBeTruthy();
    expect(pipeline_run.trigger).toBe('upload');

    const run = await waitForTerminal(valuationId, ops.token);
    expect(run.status).toBe('ready');
    expect(run.document_id).toBe(res.json().document.id);

    // Extraction auto-applied the engine inputs onto params …
    const { rows: paramsRows } = await pool.query(
      'SELECT engine_inputs FROM valuation_params WHERE valuation_id = $1',
      [valuationId],
    );
    expect(paramsRows[0].engine_inputs).toMatchObject({ volatility: 0.6 });

    // … and a draft calculation landed with those inputs.
    const calcs = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/calculations`,
      headers: authHeader(ops.token),
    });
    expect(calcs.statusCode).toBe(200);
    const list = calcs.json().calculations;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('succeeded');
    expect((lastEnginePayload?.inputs as Record<string, unknown>).volatility).toBe(0.6);

    // The run left its start/finish on the audit spine.
    const { rows: events } = await pool.query(
      `SELECT type, actor_type FROM valuation_events WHERE valuation_id = $1
       AND type IN ('auto_pipeline_started', 'auto_pipeline_completed') ORDER BY seq`,
      [valuationId],
    );
    expect(events.map((e) => e.type)).toEqual(['auto_pipeline_started', 'auto_pipeline_completed']);
    expect(events[0].actor_type).toBe('system');
  });

  it('does not trigger for non-extractable uploads', async () => {
    const valuationId = await createValuation(ops.token);
    const res = await upload(app, valuationId, ops.token, { filename: 'photo.png' });
    expect(res.statusCode).toBe(201);
    expect(res.json().pipeline_run).toBeNull();
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/pipeline`,
      headers: authHeader(ops.token),
    });
    expect(status.json().run).toBeNull();
  });

  it('respects the per-valuation opt-out (ops-only toggle)', async () => {
    const valuationId = await createValuation(client.token, 'OptOutCo');

    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/pipeline`,
      headers: authHeader(client.token),
      payload: { auto_pipeline: false },
    });
    expect(forbidden.statusCode).toBe(403);

    const toggled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/pipeline`,
      headers: authHeader(ops.token),
      payload: { auto_pipeline: false },
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().auto_pipeline).toBe(false);

    const res = await upload(app, valuationId, client.token, { filename: 'income.csv' });
    expect(res.statusCode).toBe(201);
    expect(res.json().pipeline_run).toBeNull();

    // The toggle is audited.
    const { rows } = await pool.query(
      `SELECT payload FROM valuation_events WHERE valuation_id = $1 AND type = 'auto_pipeline_toggled'`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ enabled: false });
  });

  it('is disabled globally with AUTO_PIPELINE=off (uploads skip, manual trigger 422s)', async () => {
    const valuationId = await createValuation(ops.token, 'GlobalOffCo');
    const res = await upload(offApp, valuationId, ops.token, { filename: 'income.csv' });
    expect(res.statusCode).toBe(201);
    expect(res.json().pipeline_run).toBeNull();

    const manual = await offApp.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/pipeline/runs`,
      headers: authHeader(ops.token),
    });
    expect(manual.statusCode).toBe(422);
  });

  it('records a failed run when the engine rejects the draft calculation', async () => {
    engineShouldFail = true;
    try {
      const valuationId = await createValuation(ops.token, 'FailCo');
      const res = await upload(app, valuationId, ops.token, { filename: 'income.csv' });
      expect(res.statusCode).toBe(201);
      expect(res.json().pipeline_run).toBeTruthy();

      const run = await waitForTerminal(valuationId, ops.token);
      expect(run.status).toBe('failed');
      expect(run.error).toContain('volatility');

      const { rows } = await pool.query(
        `SELECT type FROM valuation_events WHERE valuation_id = $1 AND type = 'auto_pipeline_failed'`,
        [valuationId],
      );
      expect(rows).toHaveLength(1);
    } finally {
      engineShouldFail = false;
    }
  });

  it('never overlaps runs: concurrent uploads and manual triggers are gated', async () => {
    aiDelayMs = 300;
    try {
      const valuationId = await createValuation(ops.token, 'BusyCo');
      const first = await upload(app, valuationId, ops.token, { filename: 'a.csv' });
      expect(first.json().pipeline_run).toBeTruthy();

      // While extraction is in flight: second upload piggy-backs, manual 409s.
      const second = await upload(app, valuationId, ops.token, { filename: 'b.csv' });
      expect(second.statusCode).toBe(201);
      expect(second.json().pipeline_run).toBeNull();

      const manual = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/pipeline/runs`,
        headers: authHeader(ops.token),
      });
      expect(manual.statusCode).toBe(409);

      const run = await waitForTerminal(valuationId, ops.token);
      expect(run.status).toBe('ready');
    } finally {
      aiDelayMs = 0;
    }
  });

  it('supports a manual ops re-run and blocks clients from triggering', async () => {
    const before = extractCalls;
    const valuationId = await createValuation(ops.token, 'ManualCo');
    await upload(app, valuationId, ops.token, { filename: 'income.csv' });
    await waitForTerminal(valuationId, ops.token);

    const clientTrigger = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/pipeline/runs`,
      headers: authHeader(client.token),
    });
    expect(clientTrigger.statusCode).toBe(403);

    const manual = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/pipeline/runs`,
      headers: authHeader(ops.token),
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json().run.trigger).toBe('manual');

    const run = await waitForTerminal(valuationId, ops.token);
    expect(run.status).toBe('ready');
    expect(extractCalls).toBe(before + 2);
  });

  it('scopes pipeline status reads to the valuation owner', async () => {
    const valuationId = await createValuation(client.token, 'ScopedCo');
    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/pipeline`,
      headers: authHeader(client.token),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ enabled: true, auto_pipeline: true, run: null });

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/pipeline`,
      headers: authHeader(otherClient.token),
    });
    expect(foreign.statusCode).toBe(404);
  });
});
