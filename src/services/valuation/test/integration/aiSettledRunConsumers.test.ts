import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { reapStaleAiJobs } from '../../src/repos/aiJobs.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();
const actor = { actorType: 'engine' as const, actorId: 'test', source: 'test' };

/**
 * What the two agents that *read* a result do when the run was closed under them.
 *
 * `completeAiJob` refuses to write a second terminal state over the first and
 * hands back the ending that stands, so a run the reaper closed comes back
 * `failed` with no result on it. R232 taught the extraction auto-apply to check
 * that before writing; the check lived in that branch, so neither caller that
 * reads `job.result` afterwards ever got it.
 *
 * Both then presented the empty result of a closed run as the agent's answer:
 * the QA route filed a review whose AI half was silently absent — and that
 * review is what the publish gate consults — and the narrative route answered
 * `changed: false`, which reads as "the agent had nothing to add".
 *
 * The stub reaps the job while it is holding the request, which is the window.
 */
async function startAiStub(state: { duringRun: (() => Promise<void>) | null }) {
  const stub = Fastify({ logger: false });
  for (const [name, result] of [
    ['qa', { findings: [], assessment: 'Clean.', verdict: 'pass' }],
    [
      'report_narrative',
      {
        sections: [
          {
            key: 'company_overview',
            title: 'Company Overview',
            body:
              'Northwind Robotics is set out at length here, in the professional register a reviewing ' +
              'auditor expects, with the figures the calculation produced and nothing invented beside them.',
          },
        ],
      },
    ],
  ] as const) {
    stub.post(`/ai/v1/pipelines/${name}`, async (_req, reply) => {
      if (state.duringRun) await state.duringRun();
      return reply.status(200).send({ model: 'stub-model', result });
    });
  }
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('an agent run closed while it was out', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let aiStub: Awaited<ReturnType<typeof startAiStub>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  const state: { duringRun: (() => Promise<void>) | null } = { duringRun: null };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    aiStub = await startAiStub(state);
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
  });

  afterAll(async () => {
    state.duringRun = null;
    await app?.close();
    await aiStub?.close();
    await db?.teardown();
  });

  /** A 409A engagement with a finished calculation and an instantiated report. */
  async function engagement(company: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: company },
    });
    const id = created.json().valuation.id as string;
    await createCalculation(
      pool,
      {
        valuationId: id,
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
    await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    return id;
  }

  /**
   * The real reaper, over a row aged past its window.
   *
   * Backdating the row rather than shrinking `olderThanMs` — the floor of one
   * second in `reapStaleAiJobs` means no argument can make a row created
   * milliseconds ago stale, and the point is to run the production predicate.
   */
  const reapEverything = async () => {
    await pool.query("UPDATE ai_jobs SET created_at = now() - interval '1 hour' WHERE status = 'running'");
    await reapStaleAiJobs(pool);
  };

  const runQa = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/qa`,
      headers: authHeader(ops.token),
      payload: { ai: true },
    });

  const draft = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/report/narrative`,
      headers: authHeader(ops.token),
      payload: { reuse: false },
    });

  const reviewCount = async (id: string): Promise<number> =>
    Number(
      (await pool.query('SELECT count(*)::int AS n FROM qa_reviews WHERE valuation_id = $1', [id])).rows[0]!
        .n,
    );

  it('files no QA review — the reviewer whose verdict gates publishing never spoke', async () => {
    const id = await engagement('Reaped QA, Inc.');
    state.duringRun = reapEverything;
    const res = await runQa(id);
    state.duringRun = null;

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/closed while it was out/i);
    // The whole point: an AI review that did not happen must not leave a row
    // the publish gate reads as a satisfied quality gate.
    expect(await reviewCount(id)).toBe(0);
  });

  it('refuses the narrative draft rather than reporting that nothing was drafted', async () => {
    const id = await engagement('Reaped Narrative, Inc.');
    state.duringRun = reapEverything;
    const res = await draft(id);
    state.duringRun = null;

    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/run the agent again/i);
    // No version written, and — the part that was wrong — no 200 saying the
    // agent had nothing to add.
    const report = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/report`,
      headers: authHeader(ops.token),
    });
    expect(report.json().version.version).toBe(1);
  });

  it('leaves the uninterrupted runs exactly as they were', async () => {
    const id = await engagement('Ordinary, Inc.');
    expect((await runQa(id)).statusCode).toBe(201);
    expect(await reviewCount(id)).toBe(1);

    const drafted = await draft(id);
    expect(drafted.statusCode).toBe(200);
    expect(drafted.json().changed).toBe(true);
  });
});
