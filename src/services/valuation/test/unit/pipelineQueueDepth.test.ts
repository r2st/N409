import { beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { PipelineRunRow } from '../../src/repos/pipelineRuns.js';
import type { ValuationRow } from '../../src/repos/valuations.js';

/**
 * What the reaper is told this process is still holding (round 268, M5).
 *
 * `pipeline_runs.updated_at` moves when a run changes status, and a run waiting
 * for a semaphore slot changes none — so a queue deeper than
 * `AUTO_PIPELINE_STALE_MINUTES` is failed for a wedge that is not happening.
 * `pipelineRunsAwaitingSlot` is the answer to "which of these has not started
 * yet", and the two things it must get right are the two ends: a run that has
 * been given a slot leaves the set immediately (or an executing run could never
 * be reaped, which is the case the reaper exists for), and a run still queued
 * stays in it.
 *
 * Driven against the real semaphore with the concurrency set to one, and a pool
 * whose queries never settle — which is what a run wedged on the AI service
 * looks like from here.
 */
describe('runs the auto-pipeline has queued but not started', () => {
  let mod: typeof import('../../src/pipeline/autoPipeline.js');

  beforeAll(async () => {
    vi.resetModules();
    process.env.AUTO_PIPELINE_MAX_CONCURRENT = '1';
    mod = await import('../../src/pipeline/autoPipeline.js');
  });

  const wedgedPool = { query: () => new Promise(() => {}) } as unknown as pg.Pool;

  const deps = () =>
    ({
      pool: wedgedPool,
      aiUrl: 'http://127.0.0.1:1',
      engineUrl: 'http://127.0.0.1:1',
      documentsDir: '.',
      enabled: false,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }) as unknown as Parameters<typeof mod.resumePipelineRun>[0];

  const run = (id: string) =>
    ({ id, valuation_id: 'V', attempts: 1, triggered_by: 'u' }) as unknown as PipelineRunRow;
  const valuation = { id: 'V' } as unknown as ValuationRow;

  it('holds the ones waiting and releases the one that got the slot', async () => {
    expect(mod.pipelineRunsAwaitingSlot()).toEqual([]);

    mod.resumePipelineRun(deps(), run('A'), valuation);
    mod.resumePipelineRun(deps(), run('B'), valuation);
    mod.resumePipelineRun(deps(), run('C'), valuation);

    // The acquire resolves on a microtask, so let the first one through.
    await Promise.resolve();
    await Promise.resolve();

    const waiting = mod.pipelineRunsAwaitingSlot();
    // A took the only slot and is now executing — wedged on the pool, which is
    // exactly the run the reaper must still be allowed to take.
    expect(waiting).not.toContain('A');
    expect(waiting).toEqual(expect.arrayContaining(['B', 'C']));
    expect(mod.autoPipelineConcurrency()).toMatchObject({ active: 1, pending: 2 });
  });

  /*
   * And the other half of the same fact: the retry sweep does not add to a
   * queue that is already that deep.
   *
   * The two rates are unrelated — twenty claimed every five minutes against
   * four running at a time — so an outage's backlog moves out of `failed`,
   * where the ladder holds it and a restart costs nothing, into `queued`, where
   * it is an in-memory list and every row holds its valuation's
   * one-active-run index.
   *
   * Depends on the case above having left two runs queued, and the pool that
   * never answers is the assertion: a sweep that claimed anything would reach
   * it and this would never settle.
   */
  it('claims nothing while the queue is already that deep', async () => {
    expect(mod.autoPipelineConcurrency().pending).toBe(2);
    const { retryFailedPipelineRuns } = await import('../../src/hooks/pipelineRetry.js');
    await expect(
      retryFailedPipelineRuns({ pool: wedgedPool, autoPipeline: deps(), limit: 2 }),
    ).resolves.toEqual({ claimed: 0, resumed: 0 });
  });
});
