import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { runAiPipeline } from '../../src/routes/ai.js';
import { findValuationById } from '../../src/repos/valuations.js';
import { findParams } from '../../src/repos/params.js';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Auto-applying an extraction onto an engagement retired while the run was out.
 *
 * `refuseIfRetired` fires on the route before the payload is assembled and on
 * the auto-pipeline immediately before the call — and then the AI service is
 * given up to three minutes. R232 closed this shape one step earlier, where a
 * queued run held a copy of the engagement as old as the queue. The step after
 * it is the one that writes: nobody is watching, it lands as `params_updated`
 * with an `ai` actor, and it is the write every button in the product has
 * stopped accepting.
 *
 * The stub retires the engagement while it is holding the request, which is
 * exactly the window.
 */
describe.skipIf(!dbUp)('auto-apply re-reads the engagement before it writes', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let aiStub: { url: string; close: () => Promise<void> };
  /** Set by each test: what the stub does to the engagement mid-flight. */
  let midFlight: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    pool = ctx.pool;
    await migrate(pool);
    ops = await seedUser(ctx, { roles: ['admin'] });

    const stub = Fastify({ logger: false });
    stub.post('/ai/v1/pipelines/extract', async (_req, reply) => {
      if (midFlight) await midFlight();
      return reply.status(200).send({ model: 'stub-model', result: { engine_inputs: { volatility: 0.62 } } });
    });
    await stub.listen({ port: 0, host: '127.0.0.1' });
    const address = stub.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    aiStub = { url: `http://127.0.0.1:${port}`, close: () => stub.close() };
  });

  afterAll(async () => {
    await aiStub?.close();
    await ctx?.teardown();
  });

  const newValuation = async (): Promise<string> =>
    (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/valuations',
        headers: authHeader(ops.token),
        payload: { kind: '409a', company_name: 'RetiredCo' },
      })
    ).json().valuation.id as string;

  const runExtract = async (valuationId: string) => {
    const valuation = (await findValuationById(pool, valuationId))!;
    return runAiPipeline(
      { pool, aiUrl: aiStub.url, documentsDir: './data/documents', log: ctx.app.log },
      {
        valuation,
        pipeline: 'extract',
        anonymize: true,
        autoApply: true,
        createdBy: ops.id,
        actor: { actorType: 'ai', actorId: ops.id, source: 'ai-service' },
      },
    );
  };

  it('applies the extraction on a live engagement', async () => {
    midFlight = null;
    const id = await newValuation();
    const { job, appliedInputs } = await runExtract(id);
    expect(job.status).toBe('succeeded');
    expect(appliedInputs).toMatchObject({ volatility: 0.62 });
    expect((await findParams(pool, id))!.engine_inputs).toMatchObject({ volatility: 0.62 });
  });

  it('writes nothing when the engagement is retired while the run is out', async () => {
    const id = await newValuation();
    // The production path, so the read cache is invalidated exactly as a real
    // withdrawal invalidates it.
    midFlight = async () => {
      await retireValuations(pool, [id]);
    };
    const { job, appliedInputs } = await runExtract(id);
    midFlight = null;

    // The run itself finished and is recorded as such — turning a completed run
    // into an error would lose that. What is refused is the write.
    expect(job.status).toBe('succeeded');
    expect(appliedInputs).toBeNull();
    expect((await findParams(pool, id))!.engine_inputs).not.toHaveProperty('volatility');
    const { rows } = await pool.query(
      `SELECT 1 FROM valuation_events WHERE valuation_id = $1 AND type = 'params_updated'`,
      [id],
    );
    expect(rows).toHaveLength(0);
  });
});
