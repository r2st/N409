import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  authHeader,
  interceptPoolQueries,
  isDbAvailable,
  seedUser,
  setupTestApp,
  type TestApp,
} from './helpers.js';
import { createPipelineRun, latestPipelineRun, setPipelineRunStatus } from '../../src/repos/pipelineRuns.js';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { retryFailedPipelineRuns } from '../../src/hooks/pipelineRetry.js';
import type { AutoPipelineDeps } from '../../src/pipeline/autoPipeline.js';

const dbUp = await isDbAvailable();
const SYSTEM = { actorType: 'system', actorId: 'test', source: 'auto-pipeline' } as const;

/**
 * One claimed run failing, in a sweep that has more of them behind it.
 *
 * This is the ladder where an uncontained loop costs more than the row it is
 * holding. Claiming is not a read: `claimRetryablePipelineRuns` moves each run
 * to `queued` and clears `next_attempt_at` in the same statement, so by the
 * time the loop sees them they are out of the ladder's reach and nothing is
 * scheduled to come back for them. `hooks/pipelineRetry.ts` says twice what
 * that costs for a single row — "an active run holds the one-per-valuation
 * index — so abandoning it silently would block every new trigger for this
 * valuation until the stale reaper came round" — and the loop had no per-row
 * catch, so one blip abandoned the whole rest of the claim that way.
 *
 * Driven on the settle branch, because it is the one that writes: both
 * engagements are withdrawn, so both runs must be settled rather than resumed,
 * and the first settle is refused. What a deadlock on `setPipelineRunStatus`
 * looks like from here.
 */
describe.skipIf(!dbUp)('one claimed run failing inside the auto-pipeline retry sweep', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let firstId: string;
  let secondId: string;

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

  /** A withdrawn engagement whose run is due for another attempt. */
  async function dueRunOnRetired(company: string, dueMinutesAgo: number): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: company },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().valuation.id as string;
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId: id, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    await setPipelineRunStatus(ctx.pool, run, 'failed', {
      error: 'ai service unavailable',
      actor: SYSTEM,
      failure: { kind: 'transient', reason: 'ai.unavailable', retryable: true },
    });
    await ctx.pool.query(
      `UPDATE pipeline_runs SET status = 'failed',
              next_attempt_at = now() - ($2::text || ' minutes')::interval
        WHERE id = $1`,
      [run.id, String(dueMinutesAgo)],
    );
    await retireValuations(ctx.pool, [id]);
    return id;
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    // The claim orders by `next_attempt_at ASC`, so the older one is the row
    // the sweep reaches first — which is the one the interception refuses.
    firstId = await dueRunOnRetired('RetryRow Refused Co', 30);
    secondId = await dueRunOnRetired('RetryRow Behind It Co', 10);
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  it('reports the stranded run and settles the ones behind it', async () => {
    let refused = 0;
    const restore = interceptPoolQueries(ctx.pool, (sql, phase) => {
      // `setPipelineRunStatus`' UPDATE and nothing else: the claim's own UPDATE
      // on the same table does not write `failure_kind`.
      if (phase === 'before' && sql.includes('failure_kind = $4') && refused === 0) {
        refused += 1;
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }
      return undefined;
    });
    let result: Awaited<ReturnType<typeof retryFailedPipelineRuns>>;
    const logger = log();
    try {
      // Not a rejection. Before the per-row catch this threw out of the sweep
      // with every claimed row behind the failure left `queued`, and the
      // scheduler reported one failed tick over a backlog it had just stranded.
      result = await retryFailedPipelineRuns({ pool: ctx.pool, autoPipeline: deps(logger), limit: 50 });
    } finally {
      restore();
    }
    expect(refused).toBe(1);

    expect(result.claimed).toBeGreaterThanOrEqual(2);
    expect(result.stranded).toBe(1);

    // The row the settle was refused on is still active, because there is
    // nothing here that could safely settle it — whatever just failed is the
    // write that would have to. The count above and the log line are what say
    // so; the stale reaper is what eventually frees the index.
    expect((await latestPipelineRun(ctx.pool, firstId))?.status).toBe('queued');

    // The row behind it. Before the per-row catch the loop stopped at the first
    // throw, so this engagement's run was never looked at at all — left queued,
    // holding its valuation's one-active-run index, with nothing recording it.
    const behind = await latestPipelineRun(ctx.pool, secondId);
    expect(behind?.status).toBe('failed');
    expect(behind?.error).toMatch(/retired/i);
  });

  it('reports nothing stranded on an ordinary pass', async () => {
    // The other side of the pair: `stranded` must be the interleaving and not a
    // number this sweep produces whenever it feels like it. Nothing is due any
    // more — both rows above are settled or claimed — so this is also the proof
    // that a pass which claims nothing strands nothing.
    const result = await retryFailedPipelineRuns({ pool: ctx.pool, autoPipeline: deps(), limit: 50 });
    expect(result.stranded).toBe(0);
  });
});
