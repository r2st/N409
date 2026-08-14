import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';
import type pg from 'pg';

const dbUp = await isDbAvailable();

/** Stub AI/engine upstream that records the last payload per URL. */
async function startStub(routes: Record<string, (body: unknown) => { status?: number; body: unknown }>) {
  const stub = Fastify({ logger: false });
  for (const [url, handler] of Object.entries(routes)) {
    stub.post(url, async (req, reply) => {
      const { status = 200, body } = handler(req.body);
      return reply.status(status).send(body);
    });
  }
  stub.get('/ai/v1/models', async () => ({ models: ['stub/model-a', 'stub/model-b'] }));
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('P1/P2 features API', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let aiStub: Awaited<ReturnType<typeof startStub>>;
  let engineStub: Awaited<ReturnType<typeof startStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;
  let otherClient: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  let lastTestPayload: Record<string, unknown> | null = null;
  let lastEnginePayload: Record<string, unknown> | null = null;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);

    aiStub = await startStub({
      '/ai/v1/test': (body) => {
        lastTestPayload = body as Record<string, unknown>;
        return {
          body: {
            model: 'stub/model-a',
            content: '{"ok": true}',
            anonymization: { applied: true, redacted: { emails: 2 }, enforced: false },
          },
        };
      },
    });
    engineStub = await startStub({
      '/engine/v1/compute': (body) => {
        lastEnginePayload = body as Record<string, unknown>;
        const recompute = (body as { recompute?: string[] }).recompute;
        return {
          body: {
            engine_version: 'py-stub',
            results: {
              equity_value: 20_000_000,
              fmv_per_share: 1.5,
              approaches: {
                opm_backsolve: { equity_value: 20_000_000, weight: 1, method: 'post_money' },
              },
              ...(recompute ? { recomputed: recompute } : {}),
            },
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
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: 'ProfileCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await engineStub?.close();
    await db?.teardown();
  });

  // ── Bot prompts registry ────────────────────────────────────────────────────
  describe('bot prompts', () => {
    let extractPromptId: string;

    it('seeds one prompt per pipeline', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/prompts',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const { prompts } = res.json();
      expect(prompts.map((p: { pipeline: string }) => p.pipeline).sort()).toEqual([
        'assumptions',
        'audit_defense',
        'cap_table',
        'comp_selection',
        // The web-grounded research prompt for a *guideline* company (0116/0117)
        // and the agent that drafts the subject's own profile from its uploaded
        // documents (0151/0152). Two rows on purpose: they sit on opposite
        // sides of the trust boundary — see domain/pipeline.ts.
        'company_overview',
        'company_profile',
        'comparables',
        'competitor_analysis',
        'extract',
        'industry_finder',
        'industry_outlook',
        'industry_overview',
        'market_research',
        'missing_data',
        'report_narrative',
        'roll_forward',
        'summarize',
      ]);
      const extract = prompts.find((p: { pipeline: string }) => p.pipeline === 'extract');
      expect(extract.system_prompt).toContain('Never invent numbers');
      expect(extract.model).toBeNull();
      extractPromptId = extract.id;
    });

    it('is ops-only', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/prompts',
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it('edits the system prompt and pins a model', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/prompts/${extractPromptId}`,
        headers: authHeader(ops.token),
        payload: { system_prompt: 'Extract numbers. JSON only.', model: 'stub/model-b' },
      });
      expect(res.statusCode).toBe(200);
      const { prompt } = res.json();
      expect(prompt.system_prompt).toBe('Extract numbers. JSON only.');
      expect(prompt.model).toBe('stub/model-b');
      expect(prompt.updated_by).toBe(ops.id);
    });

    it('rejects an empty patch shape violation', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/prompts/${extractPromptId}`,
        headers: authHeader(ops.token),
        payload: { system_prompt: '' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('lists model options from the AI service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/prompts/models',
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().models).toEqual(['stub/model-a', 'stub/model-b']);
    });

    it('dry-runs a prompt against the AI service with the pinned model', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/prompts/${extractPromptId}/test`,
        headers: authHeader(ops.token),
        payload: { input: 'Company: Acme. Docs: cap_table.csv' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().test).toEqual({
        model: 'stub/model-a',
        content: '{"ok": true}',
        // Passed through, not summarised away: ops is reading the model's
        // answer to text the AI service redacted on the way out, and has to be
        // told which parts of their sample never arrived.
        anonymization: { applied: true, redacted: { emails: 2 }, enforced: false },
      });
      expect(lastTestPayload).toMatchObject({
        system: 'Extract numbers. JSON only.',
        user: 'Company: Acme. Docs: cap_table.csv',
        model: 'stub/model-b',
      });
    });
  });

  // ── Company profile ─────────────────────────────────────────────────────────
  describe('company profile', () => {
    it('reads as null before the first save', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/company-profile`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().profile).toBeNull();
      expect(res.json().company_name).toBe('ProfileCo');
    });

    it('lets the owning client save their profile', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/company-profile`,
        headers: authHeader(client.token),
        payload: {
          legal_name: 'ProfileCo, Inc.',
          industry: 'B2B SaaS',
          founded_on: '2021-03-15',
          employee_count: 42,
          revenue_range: '1m_10m',
          city: 'Austin',
          country: 'US',
          cap_table_summary: '8M common, 2M Series A preferred',
        },
      });
      expect(res.statusCode).toBe(200);
      const { profile } = res.json();
      expect(profile.legal_name).toBe('ProfileCo, Inc.');
      expect(profile.founded_on).toBe('2021-03-15');
      expect(profile.employee_count).toBe(42);
    });

    it('upserts on subsequent saves and audits the change', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/company-profile`,
        headers: authHeader(ops.token),
        payload: { employee_count: 55 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().profile.employee_count).toBe(55);
      expect(res.json().profile.legal_name).toBe('ProfileCo, Inc.');

      const events = await pool.query(
        `SELECT * FROM valuation_events WHERE valuation_id = $1 AND type = 'company_profile_updated'`,
        [valuationId],
      );
      expect(events.rowCount).toBe(2);
    });

    it('is invisible to unrelated clients (404, not 403)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/company-profile`,
        headers: authHeader(otherClient.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects an invalid revenue range', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/company-profile`,
        headers: authHeader(client.token),
        payload: { revenue_range: 'a_lot' },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  // ── Per-approach recalculation ──────────────────────────────────────────────
  describe('per-approach recalculate', () => {
    it('requires a prior successful calculation', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(ops.token),
        payload: { weight_asset: 0, weight_opm: 1, weight_income: 0, weight_market: 0 },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
        payload: { approach: 'opm' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('full calculation');
    });

    it('rejects recalculating a zero-weight approach', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
        payload: { approach: 'market' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toContain('zero weight');
    });

    it('ships recompute + prior approaches to the engine', async () => {
      const full = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
        payload: { inputs: { last_round_post_money: 20_000_000 } },
      });
      expect(full.statusCode).toBe(201);
      expect(lastEnginePayload).not.toHaveProperty('recompute');

      const partial = await app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/calculations`,
        headers: authHeader(ops.token),
        payload: { approach: 'opm', inputs: { last_round_post_money: 25_000_000 } },
      });
      expect(partial.statusCode).toBe(201);
      expect(lastEnginePayload).toMatchObject({
        recompute: ['opm_backsolve'],
        prior_approaches: {
          opm_backsolve: { equity_value: 20_000_000 },
        },
      });
      expect(partial.json().calculation.results.recomputed).toEqual(['opm_backsolve']);
    });
  });

  // ── Package explorer ────────────────────────────────────────────────────────
  describe('package explorer', () => {
    it('aggregates the full engagement package for ops', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/package`,
        headers: authHeader(ops.token),
      });
      expect(res.statusCode).toBe(200);
      const { package: pkg } = res.json();
      expect(pkg.valuation.id).toBe(valuationId);
      expect(pkg.company_profile.legal_name).toBe('ProfileCo, Inc.');
      expect(pkg.params).toBeTruthy();
      expect(Array.isArray(pkg.documents)).toBe(true);
      expect(pkg.calculations.length).toBeGreaterThanOrEqual(2);
      // summaries only — no result payloads in the tree
      expect(pkg.calculations[0]).not.toHaveProperty('results');
      expect(pkg.report).toBeNull();
      expect(Array.isArray(pkg.tasks)).toBe(true);
      expect(Array.isArray(pkg.funding_rounds)).toBe(true);
    });

    it('is ops-only', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/package`,
        headers: authHeader(client.token),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Support messages ────────────────────────────────────────────────────────
  describe('support messages', () => {
    let messageId: string;

    it('lets any signed-in user send a message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/support/messages',
        headers: authHeader(client.token),
        payload: { subject: 'Stuck on documents', body: 'Upload keeps failing.', page_path: '/valuations' },
      });
      expect(res.statusCode).toBe(201);
      messageId = res.json().message.id;
      expect(res.json().message.status).toBe('open');
    });

    it('scopes listings: clients see their own, ops see all', async () => {
      const mine = await app.inject({
        method: 'GET',
        url: '/api/v1/support/messages',
        headers: authHeader(client.token),
      });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().messages).toHaveLength(1);

      const others = await app.inject({
        method: 'GET',
        url: '/api/v1/support/messages',
        headers: authHeader(otherClient.token),
      });
      expect(others.json().messages).toHaveLength(0);

      const inbox = await app.inject({
        method: 'GET',
        url: '/api/v1/support/messages?status=open',
        headers: authHeader(ops.token),
      });
      expect(inbox.json().messages).toHaveLength(1);
      expect(inbox.json().messages[0].user_email).toBe(client.email);
    });

    it('lets ops resolve and reopen; clients cannot triage', async () => {
      const forbidden = await app.inject({
        method: 'PATCH',
        url: `/api/v1/support/messages/${messageId}`,
        headers: authHeader(client.token),
        payload: { status: 'resolved' },
      });
      expect(forbidden.statusCode).toBe(403);

      const resolved = await app.inject({
        method: 'PATCH',
        url: `/api/v1/support/messages/${messageId}`,
        headers: authHeader(ops.token),
        payload: { status: 'resolved' },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().message.status).toBe('resolved');
      expect(resolved.json().message.resolved_by).toBe(ops.id);
      expect(resolved.json().message.resolved_at).toBeTruthy();

      const reopened = await app.inject({
        method: 'PATCH',
        url: `/api/v1/support/messages/${messageId}`,
        headers: authHeader(ops.token),
        payload: { status: 'open' },
      });
      expect(reopened.json().message.status).toBe('open');
      expect(reopened.json().message.resolved_at).toBeNull();
    });

    it('rejects an empty subject', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/support/messages',
        headers: authHeader(client.token),
        payload: { subject: '', body: 'help' },
      });
      expect(res.statusCode).toBe(422);
    });
  });
});
