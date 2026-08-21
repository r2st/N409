import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createPipelineRun, latestPipelineRun, setPipelineRunStatus } from '../../src/repos/pipelineRuns.js';
import { retryFailedPipelineRuns } from '../../src/hooks/pipelineRetry.js';
import type { AutoPipelineDeps } from '../../src/pipeline/autoPipeline.js';

const dbUp = await isDbAvailable();
const SYSTEM = { actorType: 'system', actorId: 'test', source: 'auto-pipeline' } as const;

/**
 * The sweep that re-runs an orchestration whose dependency has come back.
 *
 * `executeRun` has recorded `next_attempt_at` on a transiently-failed run since
 * migration 0161, and this is the only thing that reads it. It was at 28% —
 * the flag gate was covered by `retrySweepFlags` and the body was not, which
 * is the wrong half: the gate decides whether to start, and the body decides
 * what happens to a run that must not simply be re-run.
 *
 * The two branches worth driving are the ones that *settle* a claimed run
 * rather than resuming it, because claiming has already moved the row to an
 * active status and an active run holds the one-per-valuation index. A branch
 * that walks away from a claimed run leaves that valuation unable to start any
 * new pipeline until the stale reaper comes round — up to
 * AUTO_PIPELINE_STALE_MINUTES of an engagement that cannot be re-run.
 */
describe.skipIf(!dbUp)('the auto-pipeline retry sweep', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    // The orchestration itself is off: this is about what the sweep decides,
    // not about the pipeline it hands work to.
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const log = () =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as AutoPipelineDeps['log'];

  const deps = (logger = log()): AutoPipelineDeps => ({
    pool: ctx.pool,
    aiUrl: 'http://127.0.0.1:1',
    engineUrl: 'http://127.0.0.1:1',
    documentsDir: ctx.documentsDir ?? './data/documents',
    enabled: false,
    log: logger,
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

  /** A run that failed transiently and is due for another attempt now. */
  async function dueRun(valuationId: string) {
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    await setPipelineRunStatus(ctx.pool, run, 'failed', {
      error: 'ai service unavailable',
      actor: SYSTEM,
      failure: { kind: 'transient', reason: 'ai.unavailable', retryable: true },
    });
    await ctx.pool.query(
      `UPDATE pipeline_runs SET status = 'failed', next_attempt_at = now() - interval '1 minute' WHERE id = $1`,
      [run.id],
    );
    return run;
  }

  it('claims a due run and hands it back to the pipeline', async () => {
    const valuationId = await newValuation('RetrySweep Resume Co');
    const run = await dueRun(valuationId);

    const result = await retryFailedPipelineRuns({ pool: ctx.pool, autoPipeline: deps(), limit: 10 });
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.resumed).toBeGreaterThanOrEqual(1);

    // Claimed means queued: the attempt is spent and the row is active, which
    // is what stops a second instance picking the same run up.
    const after = await latestPipelineRun(ctx.pool, valuationId);
    expect(after?.id).toBe(run.id);
    expect(after?.attempts).toBeGreaterThanOrEqual(1);
    expect(after?.next_attempt_at).toBeNull();
  });

  it('settles a run whose valuation has since opted out, rather than abandoning it', async () => {
    const valuationId = await newValuation('RetrySweep OptOut Co');
    const run = await dueRun(valuationId);
    await ctx.pool.query('UPDATE valuations SET auto_pipeline = false WHERE id = $1', [valuationId]);

    const logger = log();
    const result = await retryFailedPipelineRuns({
      pool: ctx.pool,
      autoPipeline: deps(logger),
      limit: 10,
    });
    expect(result.claimed).toBeGreaterThanOrEqual(1);

    const after = await latestPipelineRun(ctx.pool, valuationId);
    expect(after?.id).toBe(run.id);
    // Not left on 'queued'. An active run holds the one-per-valuation index,
    // so walking away would block every new trigger for this engagement.
    expect(after?.status).toBe('failed');
    expect(after?.error).toMatch(/disabled for this valuation/i);
    // `permanent`, so the ladder does not schedule it again: an opt-out is a
    // decision, not an outage.
    expect(after?.next_attempt_at).toBeNull();
    expect(logger.info).toHaveBeenCalled();
  });

  // The `!valuation` branch above the retirement one is not driven here, and
  // deliberately: `valuation_events` blocks DELETE by trigger and its FK is NO
  // ACTION, so a valuation cannot actually be removed on this schema. The
  // branch is a belt against a future hard delete, and a test that faked one
  // would be asserting against a database this codebase does not have.

  it('claims nothing when nothing is due — the vacuity guard', async () => {
    // Everything above asserts the sweep acted. All of it would pass against a
    // sweep that claimed every failed run regardless of `next_attempt_at`.
    const valuationId = await newValuation('RetrySweep NotDue Co');
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    await ctx.pool.query(
      `UPDATE pipeline_runs SET status = 'failed', next_attempt_at = now() + interval '1 hour' WHERE id = $1`,
      [run.id],
    );

    const result = await retryFailedPipelineRuns({ pool: ctx.pool, autoPipeline: deps(), limit: 10 });
    const after = await latestPipelineRun(ctx.pool, valuationId);
    expect(after?.status).toBe('failed');
    expect(after?.next_attempt_at).not.toBeNull();
    expect(result.claimed).toBe(0);
  });
});
