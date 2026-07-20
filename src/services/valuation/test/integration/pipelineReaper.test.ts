import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createPipelineRun, latestPipelineRun, reapStalePipelineRuns } from '../../src/repos/pipelineRuns.js';

const dbUp = await isDbAvailable();
const SYSTEM = { actorType: 'system', actorId: 'test', source: 'auto-pipeline' } as const;

describe.skipIf(!dbUp)('auto-pipeline reaper (B-3)', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  async function newValuation(company: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  }

  it('fails runs stuck in an active status past the threshold', async () => {
    const valuationId = await newValuation('ReaperCo');
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    // Backdate so it looks orphaned (as after a mid-run restart).
    await ctx.pool.query(`UPDATE pipeline_runs SET updated_at = now() - interval '2 hours' WHERE id = $1`, [
      run.id,
    ]);

    const reaped = await reapStalePipelineRuns(ctx.pool, {
      olderThanMs: 30 * 60_000,
      actor: SYSTEM,
    });
    expect(reaped.map((r) => r.id)).toContain(run.id);

    const after = await latestPipelineRun(ctx.pool, valuationId);
    expect(after?.status).toBe('failed');
    expect(after?.error).toContain('reaped');

    // The reap is on the audit spine and flagged as reaped.
    const { rows } = await ctx.pool.query(
      `SELECT payload FROM valuation_events
       WHERE valuation_id = $1 AND type = 'auto_pipeline_failed'`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ reaped: true, run_id: run.id });
  });

  it('leaves fresh active runs alone', async () => {
    const valuationId = await newValuation('FreshCo');
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );

    const reaped = await reapStalePipelineRuns(ctx.pool, {
      olderThanMs: 30 * 60_000,
      actor: SYSTEM,
    });
    expect(reaped.map((r) => r.id)).not.toContain(run.id);

    const after = await latestPipelineRun(ctx.pool, valuationId);
    expect(after?.status).toBe('queued');
  });

  it('is idempotent — a second sweep reaps nothing new', async () => {
    const valuationId = await newValuation('DoubleReapCo');
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    await ctx.pool.query(`UPDATE pipeline_runs SET updated_at = now() - interval '2 hours' WHERE id = $1`, [
      run.id,
    ]);
    const first = await reapStalePipelineRuns(ctx.pool, { olderThanMs: 60_000, actor: SYSTEM });
    expect(first.map((r) => r.id)).toContain(run.id);
    const second = await reapStalePipelineRuns(ctx.pool, { olderThanMs: 60_000, actor: SYSTEM });
    expect(second.map((r) => r.id)).not.toContain(run.id);
  });
});
