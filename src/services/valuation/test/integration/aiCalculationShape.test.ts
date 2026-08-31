import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { authHeader, isDbAvailable, seedUser, setupTestDb, type TestDb } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Which calculation the narrating agents are shown.
 *
 * `explain`, `report_narrative` and `audit_defense` all write prose about the
 * concluded figure, and all three were handed `latestSucceededCalculation` —
 * the newest run of *any* shape. A specialty engagement carries two shapes: the
 * Calculations tab offers the ordinary 409A compute on every kind, so an EMI
 * file whose analyst pressed that button holds a `{ approaches, ... }` row
 * interleaved with its `{ kind, specialty }` ones. Whichever ran last is what
 * the agent read, so the EMI report's own narrative could be drafted from a
 * §409A conclusion that is not this engagement's answer.
 *
 * The staleness gate could not catch it either: `currentExplanation` compares
 * the finished job against `latestCalculationForKind`, which is a different row
 * from the one the agent was given, so a job newer than the specialty run it
 * was never shown passed as current.
 */
async function startAiStub(seen: Record<string, unknown>) {
  const stub = Fastify({ logger: false });
  for (const name of ['explain', 'report_narrative', 'audit_defense']) {
    stub.post(`/ai/v1/pipelines/${name}`, async (req, reply) => {
      seen[name] = req.body;
      return reply.status(200).send({ model: 'stub-model', result: { summary: 'ok' } });
    });
  }
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const address = stub.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
}

describe.skipIf(!dbUp)('narrating agents read the run their kind is reported on', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let aiStub: Awaited<ReturnType<typeof startAiStub>>;
  const seen: Record<string, unknown> = {};
  let ops: Awaited<ReturnType<typeof seedUser>>;

  const SPECIALTY_RESULTS = { kind: 'emi', specialty: { unrestricted_market_value: 4_200_000 } };
  const FOUR_O_NINE_A_RESULTS = { approaches: { opm: { equity_value: 20_000_000 } }, discounts: {} };

  beforeAll(async () => {
    db = await setupTestDb();
    pool = db.pool;
    await migrate(pool);
    aiStub = await startAiStub(seen);
    app = buildApp({
      config: loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        JWT_SECRET: 'integration-test-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
        AI_URL: aiStub.url,
        AUTO_PIPELINE: 'off',
      }),
      pool,
    });
    await app.ready();
    ops = await seedUser({ app, pool, teardown: async () => {} }, { roles: ['reviewer'] });
  });

  afterAll(async () => {
    await app?.close();
    await aiStub?.close();
    await db?.teardown();
  });

  const newValuation = async (kind: string): Promise<string> =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind, company_name: 'ShapeCo' },
      })
    ).json().valuation.id as string;

  const addCalculation = (valuationId: string, results: Record<string, unknown>) =>
    createCalculation(
      pool,
      {
        valuationId,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results,
        equityValue: 4_200_000,
        fmvPerShare: 1.5,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );

  const run = (valuationId: string, pipeline: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/ai/${pipeline}`,
      headers: authHeader(ops.token),
      payload: {},
    });

  it('shows a specialty engagement its specialty run, not the 409A run that landed after it', async () => {
    const id = await newValuation('emi');
    await addCalculation(id, SPECIALTY_RESULTS);
    // The ordinary 409A compute, pressed second. This is the row that used to
    // be narrated.
    await addCalculation(id, FOUR_O_NINE_A_RESULTS);

    for (const pipeline of ['explain', 'report_narrative', 'audit_defense']) {
      delete seen[pipeline];
      const res = await run(id, pipeline);
      expect(res.statusCode, pipeline).toBe(201);
      const payload = seen[pipeline] as { calculation: { results: Record<string, unknown> } };
      expect(payload.calculation.results, pipeline).toMatchObject(SPECIALTY_RESULTS);
      expect(payload.calculation.results, pipeline).not.toHaveProperty('approaches');
    }
  });

  it('refuses, naming the kind, when a specialty engagement has only a 409A run', async () => {
    const id = await newValuation('emi');
    await addCalculation(id, FOUR_O_NINE_A_RESULTS);

    delete seen['audit_defense'];
    const res = await run(id, 'audit_defense');
    expect(res.statusCode).toBe(422);
    // A 409A run is sitting there succeeded, so "run a calculation" against a
    // Calculations tab that plainly shows one is a refusal nobody can act on.
    // The kind is named by its label, which is what the Calculations tab shows
    // — the assertion used to spell it `EMI calculation`, an adjacency the
    // sentence has never had, and so failed on a refusal that says exactly what
    // it is supposed to say.
    const detail = res.json().detail as string;
    expect(detail).toMatch(/EMI scheme valuation/i);
    expect(detail).toMatch(/calculation/i);
    expect(seen['audit_defense']).toBeUndefined();
  });

  it('leaves a 409A engagement reading the plain newest run', async () => {
    const id = await newValuation('409a');
    await addCalculation(id, FOUR_O_NINE_A_RESULTS);

    delete seen['explain'];
    expect((await run(id, 'explain')).statusCode).toBe(201);
    const payload = seen['explain'] as { calculation: { results: Record<string, unknown> } };
    expect(payload.calculation.results).toMatchObject(FOUR_O_NINE_A_RESULTS);
  });
});
