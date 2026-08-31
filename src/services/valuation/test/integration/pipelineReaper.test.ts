import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  claimRetryablePipelineRuns,
  createPipelineRun,
  latestPipelineRun,
  reapStalePipelineRuns,
} from '../../src/repos/pipelineRuns.js';
import { PIPELINE_MAX_ATTEMPTS, pipelineRetryWindowMs } from '../../src/domain/pipelineRetry.js';

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

  it('puts the reaped run on the retry ladder, because a hang is a transient failure', async () => {
    // The gap this closes: the reap wrote `status = 'failed'` and nothing else,
    // so `failure_kind` and `next_attempt_at` stayed NULL — and the retry sweep
    // selects on `next_attempt_at IS NOT NULL`. A run that failed fast against a
    // down AI service was retried four times; the run that *hung* against the
    // same service was owed nothing. Only the shape of the failure differed.
    const valuationId = await newValuation('ReapLadderCo');
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    await ctx.pool.query(`UPDATE pipeline_runs SET updated_at = now() - interval '2 hours' WHERE id = $1`, [
      run.id,
    ]);

    const [reaped] = await reapStalePipelineRuns(ctx.pool, { olderThanMs: 60_000, actor: SYSTEM });

    expect(reaped?.status).toBe('failed');
    expect(reaped?.failure_kind).toBe('transient');
    expect(reaped?.next_attempt_at).not.toBeNull();
    // Inside the first rung's jitter window, so the schedule is the shared
    // ladder rather than a second set of figures living in the reaper.
    const window = pipelineRetryWindowMs(run.attempts)!;
    const waitMs = reaped!.next_attempt_at!.getTime() - reaped!.updated_at.getTime();
    expect(waitMs).toBeGreaterThanOrEqual(window.minMs - 2_000);
    expect(waitMs).toBeLessThanOrEqual(window.maxMs + 2_000);

    // And the sweep can actually see it — the column is only worth writing if
    // the thing that reads it agrees.
    await ctx.pool.query(
      `UPDATE pipeline_runs SET next_attempt_at = now() - interval '1 minute'
                          WHERE id = $1`,
      [run.id],
    );
    const claimed = await claimRetryablePipelineRuns(ctx.pool, { actor: SYSTEM });
    expect(claimed.map((r) => r.id)).toContain(run.id);
  });

  it('stops scheduling once the run is out of attempts', async () => {
    // The ladder is bounded, and the reaper is not allowed its own ceiling: a
    // valuation that wedges a worker every time would otherwise be permanent
    // load rather than a permanent failure somebody is told about.
    const valuationId = await newValuation('ReapExhaustedCo');
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    await ctx.pool.query(
      `UPDATE pipeline_runs SET updated_at = now() - interval '2 hours', attempts = $2 WHERE id = $1`,
      [run.id, PIPELINE_MAX_ATTEMPTS],
    );

    const [reaped] = await reapStalePipelineRuns(ctx.pool, { olderThanMs: 60_000, actor: SYSTEM });
    expect(reaped?.status).toBe('failed');
    expect(reaped?.next_attempt_at).toBeNull();

    const { rows } = await ctx.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'auto_pipeline_failed' ORDER BY seq DESC LIMIT 1`,
      [valuationId],
    );
    // "reaped" alone reads as an ending whether or not anything is coming back
    // for it; the spine has to say which.
    expect(rows[0]!.payload).toMatchObject({ reaped: true, retry_scheduled: false });
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
