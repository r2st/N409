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

/** Stub upstream (ai/engine) that replays a canned handler per URL. */
async function startStub(routes: Record<string, (body: unknown) => { status?: number; body: unknown }>) {
  const stub = Fastify({ logger: false });
  for (const [url, handler] of Object.entries(routes)) {
    stub.post(url, async (req, reply) => {
      const { status = 200, body } = handler(req.body);
      return reply.status(status).send(body);
    });
  }
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('M1 core pipeline API', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let docsDir: string;
  let aiStub: Awaited<ReturnType<typeof startStub>>;
  let engineStub: Awaited<ReturnType<typeof startStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;
  let clientValuationId: string;

  let lastAiPayload: Record<string, unknown> | null = null;
  let lastEnginePayload: Record<string, unknown> | null = null;
  let engineShouldFail = false;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    docsDir = mkdtempSync(path.join(tmpdir(), 'n409-docs-'));

    aiStub = await startStub({
      '/ai/v1/pipelines/missing_data': (body) => {
        lastAiPayload = body as Record<string, unknown>;
        return { body: { model: 'stub-model', result: { missing: ['cap_table'] } } };
      },
      '/ai/v1/pipelines/extract': () => ({
        body: {
          model: 'stub-model',
          result: {
            engine_inputs: {
              shares_outstanding_common: 8_000_000,
              shares_outstanding_preferred: 2_000_000,
              liquidation_preference: 5_000_000,
              last_round_post_money: 20_000_000,
              volatility: 0.6,
              risk_free_rate: 0.04,
            },
          },
        },
      }),
      '/ai/v1/pipelines/comparables': () => ({
        body: {
          model: 'stub-model',
          result: {
            comparables: [
              { name: 'CompCo A', ticker: 'CCA', revenue_multiple: 6.0, ebitda_multiple: 18 },
              { name: 'CompCo B', ticker: 'CCB', revenue_multiple: 4.0, ebitda_multiple: 12 },
            ],
          },
        },
      }),
    });
    engineStub = await startStub({
      '/engine/v1/compute': (body) => {
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

    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'integration-test-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
      AI_URL: aiStub.url,
      ENGINE_URL: engineStub.url,
      DOCUMENTS_DIR: docsDir,
    });
    app = buildApp({ config, pool });
    await app.ready();

    const seedCtx = { app, pool, teardown: async () => {} };
    ops = await seedUser(seedCtx, { roles: ['reviewer'] });
    client = await seedUser(seedCtx, { roles: ['valuation_user'] });
    otherClient = await seedUser(seedCtx, { roles: ['valuation_user'] });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'PipelineCo' },
    });
    valuationId = created.json().valuation.id;

    const clientCreated = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'ClientCo' },
    });
    clientValuationId = clientCreated.json().valuation.id;
  });

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await engineStub?.close();
    await db?.teardown();
    rmSync(docsDir, { recursive: true, force: true });
  });

  // ── Review tasks ────────────────────────────────────────────────────────────
  describe('review tasks', () => {
    let taskId: string;

    it('creates a typed task with an SLA-derived due date', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/tasks`,
        headers: authHeader(ops.token),
        payload: { kind: 'cap_table', title: 'Verify cap table', assignee_id: ops.id, sla_hours: 48 },
      });
      expect(res.statusCode).toBe(201);
      const { task } = res.json();
      taskId = task.id;
      expect(task.status).toBe('open');
      expect(task.overdue).toBe(false);
      expect(task.due_at).toBeTruthy();
      const hours = (new Date(task.due_at).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(47);
      expect(hours).toBeLessThan(49);
    });

    it('rejects an unknown assignee', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/tasks`,
        headers: authHeader(ops.token),
        payload: { kind: 'other', title: 'x', assignee_id: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('is ops-only', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('lists "assigned to me" and filters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tasks?assignee=me&status=open',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const { tasks, total } = res.json();
      expect(total).toBe(1);
      expect(tasks[0].id).toBe(taskId);
    });

    it('moves status and stamps started/completed timestamps', async () => {
      const start = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${taskId}`,
        headers: authHeader(ops.token),
        payload: { status: 'in_progress' },
      });
      expect(start.statusCode).toBe(200);
      expect(start.json().task.started_at).toBeTruthy();

      const done = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${taskId}`,
        headers: authHeader(ops.token),
        payload: { status: 'done' },
      });
      expect(done.json().task.completed_at).toBeTruthy();
    });

    it('detects overdue tasks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/tasks`,
        headers: authHeader(ops.token),
        payload: {
          kind: 'draft_review',
          title: 'Late review',
          due_at: new Date(Date.now() - 3_600_000).toISOString(),
        },
      });
      expect(res.json().task.overdue).toBe(true);

      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/tasks?overdue=true',
        headers: authHeader(ops.token),
      });
      expect(list.json().total).toBe(1);
      expect(list.json().tasks[0].title).toBe('Late review');
    });

    it('wrote task events to the audit spine', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/events`,
        headers: authHeader(ops.token),
      });
      const types = res.json().events.map((e: { type: string }) => e.type);
      expect(types).toContain('review_task_created');
      expect(types).toContain('review_task_updated');
    });
  });

  // ── Documents ───────────────────────────────────────────────────────────────
  describe('documents', () => {
    let documentId: string;

    function multipartUpload(url: string, token: string, opts: { filename: string; kind?: string; content: string }) {
      const boundary = '----n409test';
      const parts = [
        ...(opts.kind
          ? [
              `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\n${opts.kind}\r\n`,
            ]
          : []),
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${opts.filename}"\r\ncontent-type: text/csv\r\n\r\n${opts.content}\r\n`,
        `--${boundary}--\r\n`,
      ].join('');
      return app.inject({
        method: 'POST',
        url,
        headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: parts,
      });
    }

    it('uploads a document with a kind', async () => {
      const res = await multipartUpload(`/api/v1/valuations/${valuationId}/documents`, ops.token, {
        filename: 'cap-table.csv',
        kind: 'cap_table',
        content: 'holder,shares\nFounders,8000000\nSeriesA,2000000',
      });
      expect(res.statusCode).toBe(201);
      const { document } = res.json();
      documentId = document.id;
      expect(document.kind).toBe('cap_table');
      expect(document.filename).toBe('cap-table.csv');
      expect(Number(document.size_bytes)).toBeGreaterThan(10);
      expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects an unknown kind', async () => {
      const res = await multipartUpload(`/api/v1/valuations/${valuationId}/documents`, ops.token, {
        filename: 'x.csv',
        kind: 'passport',
        content: 'x',
      });
      expect(res.statusCode).toBe(422);
    });

    it('lists and downloads the document', async () => {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/documents`,
        headers: authHeader(ops.token),
      });
      expect(list.json().documents).toHaveLength(1);

      const dl = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/documents/${documentId}/download`,
        headers: authHeader(ops.token),
      });
      expect(dl.statusCode).toBe(200);
      expect(dl.body).toContain('Founders,8000000');
      expect(dl.headers['content-disposition']).toContain('cap-table.csv');
    });

    it('scopes documents: a stranger gets 404, the owner can upload', async () => {
      const strangers = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${clientValuationId}/documents`,
        headers: authHeader(otherClient.token),
      });
      expect(strangers.statusCode).toBe(404);

      const own = await multipartUpload(`/api/v1/valuations/${clientValuationId}/documents`, client.token, {
        filename: 'projections.csv',
        kind: 'projections',
        content: 'year,revenue\n2027,1000000',
      });
      expect(own.statusCode).toBe(201);
    });

    it('client cannot delete an ops upload; ops can', async () => {
      const denied = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/documents/${documentId}`,
        headers: authHeader(client.token),
      });
      // client can't even see this valuation → 404
      expect(denied.statusCode).toBe(404);

      const ok = await app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/documents/${documentId}`,
        headers: authHeader(ops.token),
      });
      expect(ok.statusCode).toBe(204);

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/documents`,
        headers: authHeader(ops.token),
      });
      expect(list.json().documents).toHaveLength(0);
    });
  });

  // ── Params ──────────────────────────────────────────────────────────────────
  describe('valuation params', () => {
    it('reads the params row created at valuation birth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().params.valuation_id).toBe(valuationId);
      expect(res.json().params.weight_opm).toBeNull();
    });

    it('rejects weights that do not sum to 1', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(ops.token),
        payload: { weight_asset: 0.5, weight_opm: 0.2, weight_income: 0.2, weight_market: 0.2 },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('sum to 1');
    });

    it('rejects a partial weight set', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(ops.token),
        payload: { weight_opm: 1 },
      });
      expect(res.statusCode).toBe(422);
    });

    it('requires dlom_qualitative for the qualitative method', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(ops.token),
        payload: { dlom_method: 'qualitative' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('saves a full methodology config and audits it', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(ops.token),
        payload: {
          weight_asset: 0,
          weight_opm: 0.6,
          weight_income: 0.15,
          weight_market: 0.25,
          dloc: 0.1,
          dlom_method: 'finnerty',
          revenue_status: 'post_revenue',
          exit_timeline: '2029-06-30',
          market_method: 'revenue',
          market_horizon: 'ltm',
        },
      });
      expect(res.statusCode).toBe(200);
      const { params } = res.json();
      expect(Number(params.weight_opm)).toBe(0.6);
      expect(params.dlom_method).toBe('finnerty');
      expect(params.exit_timeline).toContain('2029-06-30');

      const events = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/events`,
        headers: authHeader(ops.token),
      });
      const types = events.json().events.map((e: { type: string }) => e.type);
      expect(types).toContain('params_updated');
    });

    it('params editing is ops-only', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${clientValuationId}/params`,
        headers: authHeader(client.token),
        payload: { dloc: 0.1 },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── AI pipelines ────────────────────────────────────────────────────────────
  describe('AI pipelines', () => {
    it('runs missing_data and persists a succeeded ai_job', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/ai/missing_data`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(201);
      const { job } = res.json();
      expect(job.status).toBe('succeeded');
      expect(job.model).toBe('stub-model');
      expect(job.result.missing).toEqual(['cap_table']);
      expect(job.latency_ms).toBeGreaterThanOrEqual(0);
      // Payload carried valuation context + params to the AI service.
      expect(lastAiPayload).toBeTruthy();
      expect((lastAiPayload!.valuation as { company_name: string }).company_name).toBe('PipelineCo');
      expect(lastAiPayload!.params).toBeTruthy();
    });

    it('extract requires at least one document', async () => {
      const fresh = await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: 'fmv', company_name: 'EmptyCo' },
      });
      const empty = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${fresh.json().valuation.id}/ai/extract`,
        headers: authHeader(ops.token),
      });
      expect(empty.statusCode).toBe(422);
    });

    it('runs extract + comparables to seed the calculation', async () => {
      // PipelineCo's cap-table doc was deleted in the documents suite — upload
      // a fresh one so extraction has something to read.
      const boundary = '----n409ai';
      const upload = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/documents`,
        headers: { ...authHeader(ops.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload:
          `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\nincome_statement\r\n` +
          `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="pnl.csv"\r\ncontent-type: text/csv\r\n\r\nrevenue,5000000\r\n` +
          `--${boundary}--\r\n`,
      });
      expect(upload.statusCode).toBe(201);

      const extract = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/ai/extract`,
        headers: authHeader(ops.token),
      });
      expect(extract.statusCode).toBe(201);
      expect(extract.json().job.result.engine_inputs.shares_outstanding_common).toBe(8_000_000);

      const comps = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/ai/comparables`,
        headers: authHeader(ops.token),
      });
      expect(comps.statusCode).toBe(201);
      expect(comps.json().job.result.comparables).toHaveLength(2);
    });

    it('is ops-only and 404s on unknown pipelines', async () => {
      const forbidden = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${clientValuationId}/ai/missing_data`,
        headers: authHeader(client.token),
      });
      expect(forbidden.statusCode).toBe(403);

      const unknown = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/ai/summarize`,
        headers: authHeader(ops.token),
      });
      expect(unknown.statusCode).toBe(404);
    });

    it('lists jobs with provenance and audit events', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/ai`,
        headers: authHeader(ops.token),
      });
      expect(res.json().jobs.length).toBeGreaterThanOrEqual(2);

      const events = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/events`,
        headers: authHeader(ops.token),
      });
      const aiEvents = events
        .json()
        .events.filter((e: { type: string }) => e.type === 'ai_job_completed');
      expect(aiEvents.length).toBeGreaterThanOrEqual(2);
      expect(aiEvents[0].actor_type).toBe('ai');
    });
  });

  // ── Calculations ────────────────────────────────────────────────────────────
  describe('calculations', () => {
    it('merges AI results + explicit inputs and persists the engine response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
        payload: { inputs: { volatility: 0.55, market: { metric: 3_000_000 } } },
      });
      expect(res.statusCode).toBe(201);
      const { calculation } = res.json();
      expect(calculation.status).toBe('succeeded');
      expect(calculation.engine_version).toBe('py-stub');
      expect(Number(calculation.fmv_per_share)).toBeCloseTo(1.23);
      expect(Number(calculation.equity_value)).toBe(18_000_000);

      // Engine payload: params from the DB + comparables multiples + overrides.
      expect(lastEnginePayload).toBeTruthy();
      const payload = lastEnginePayload as {
        params: Record<string, unknown>;
        inputs: Record<string, unknown>;
      };
      expect(payload.params.dlom_method).toBe('finnerty');
      expect(payload.params.weight_opm).toBe(0.6);
      expect(payload.inputs.volatility).toBe(0.55);
      expect((payload.inputs.market as { multiples: number[] }).multiples).toEqual([6.0, 4.0]);
    });

    it('records a failed calculation when the engine rejects inputs', async () => {
      engineShouldFail = true;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
      });
      engineShouldFail = false;
      expect(res.statusCode).toBe(422);

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
      });
      const { calculations } = list.json();
      expect(calculations.length).toBeGreaterThanOrEqual(2);
      expect(calculations[0].status).toBe('failed');
      expect(calculations[0].error).toContain('volatility');
    });

    it('is ops-only', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${clientValuationId}/calculations`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
