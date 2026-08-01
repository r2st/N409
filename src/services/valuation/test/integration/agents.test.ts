import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/** Records the last payload each agent endpoint received, and replays a canned
 * result so the route completes without a real AI service. */
async function startAiStub(seen: Record<string, unknown>) {
  const stub = Fastify({ logger: false });
  const agents = [
    'cap_table',
    'comp_selection',
    'report_narrative',
    'assumptions',
    'audit_defense',
    'roll_forward',
  ];
  for (const name of agents) {
    stub.post(`/ai/v1/pipelines/${name}`, async (req, reply) => {
      seen[name] = req.body;
      return reply.status(200).send({ model: 'stub-model', result: { ok: true, agent: name } });
    });
  }
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('analyst agent wiring', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let aiStub: Awaited<ReturnType<typeof startAiStub>>;
  const seen: Record<string, unknown> = {};
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const runAgent = (pipeline: string, token = ops.token, body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/${pipeline}`,
      headers: authHeader(token),
      payload: body,
    });

  const listPromptsRaw = async () =>
    (await app.inject({ method: 'GET', url: '/api/v1/admin/prompts', headers: authHeader(ops.token) })).json()
      .prompts as Array<{ id: string; pipeline: string; enabled: boolean }>;

  const promptFor = async (pipeline: string) =>
    (await listPromptsRaw()).find((p) => p.pipeline === pipeline)!;

  const patchPrompt = (id: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/prompts/${id}`,
      headers: authHeader(ops.token),
      payload: body,
    });

  const versions = async (id: string) =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/admin/prompts/${id}/versions`,
        headers: authHeader(ops.token),
      })
    ).json().versions as Array<{ version: number }>;

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    aiStub = await startAiStub(seen);
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

    ops = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['reviewer'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'AgentCo' },
    });
    valuationId = created.json().valuation.id;
  });

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await db?.teardown();
  });

  it('seeds an enabled Bot Prompt row for every agent', async () => {
    const prompts = await listPromptsRaw();
    for (const pipeline of [
      'cap_table',
      'comp_selection',
      'report_narrative',
      'assumptions',
      'audit_defense',
      'roll_forward',
    ]) {
      const row = prompts.find((p) => p.pipeline === pipeline);
      expect(row, `${pipeline} prompt seeded`).toBeDefined();
      expect(row!.enabled).toBe(true);
    }
  });

  it('runs an agent with no doc/calc dependency and passes context + prompt through', async () => {
    const res = await runAgent('comp_selection', ops.token, {
      context: { comp_context: { industry: 'APM', revenue: 5_000_000, stage: 'post_revenue' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().job.status).toBe('succeeded');
    const payload = seen['comp_selection'] as Record<string, any>;
    expect(payload.comp_context).toMatchObject({ industry: 'APM' });
    // The registry prompt (system + model) rides along.
    expect(payload.prompt).toHaveProperty('system');
    expect(payload.valuation).toMatchObject({ company_name: 'AgentCo' });
  });

  it('honors the on/off toggle: a disabled agent is refused before the AI call', async () => {
    const prompt = await promptFor('assumptions');
    delete seen['assumptions'];

    const disabled = await patchPrompt(prompt.id, { enabled: false });
    expect(disabled.statusCode).toBe(200);

    const blocked = await runAgent('assumptions');
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().detail).toMatch(/disabled/i);
    expect(seen['assumptions']).toBeUndefined(); // AI service never called

    // Re-enabling lets it run again.
    await patchPrompt(prompt.id, { enabled: true });
    const ok = await runAgent('assumptions');
    expect(ok.statusCode).toBe(201);
    expect(seen['assumptions']).toBeDefined();
  });

  it('does not append a prompt version when only the toggle changes', async () => {
    const prompt = await promptFor('roll_forward');
    const before = (await versions(prompt.id)).length;
    await patchPrompt(prompt.id, { enabled: false });
    await patchPrompt(prompt.id, { enabled: true });
    const after = (await versions(prompt.id)).length;
    expect(after).toBe(before); // toggling is operational, not a content edit
  });

  it('selects the pinned model for an agent', async () => {
    const prompt = await promptFor('audit_defense');
    await patchPrompt(prompt.id, { model: 'stub/pinned-model' });
    delete seen['audit_defense'];
    // audit_defense is calculation-dependent — with no calc it 422s before the call.
    const noCalc = await runAgent('audit_defense');
    expect(noCalc.statusCode).toBe(422);
    expect(noCalc.json().detail).toMatch(/calculation/i);
    // But the pinned model is what the registry now stores.
    const stored = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/admin/prompts/${prompt.id}`,
        headers: authHeader(ops.token),
      })
    ).json().prompt as { model: string };
    expect(stored.model).toBe('stub/pinned-model');
  });

  it('requires documents for the cap-table agent', async () => {
    const res = await runAgent('cap_table');
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/document/i);
  });

  it('requires a calculation for narration/defense agents', async () => {
    for (const pipeline of ['report_narrative', 'audit_defense']) {
      const res = await runAgent(pipeline);
      expect(res.statusCode, pipeline).toBe(422);
      expect(res.json().detail).toMatch(/calculation/i);
    }
  });

  it('still refuses qa through the generic route', async () => {
    const res = await runAgent('qa');
    expect(res.statusCode).toBe(422);
  });
});
