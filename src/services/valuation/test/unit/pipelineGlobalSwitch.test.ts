import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { retryFailedPipelineRuns } from '../../src/hooks/pipelineRetry.js';

/**
 * `AUTO_PIPELINE=off` against the third door onto an orchestration (R440, M3).
 *
 * Two doors *start* a run and both read the switch: `maybeStartAutoPipeline`
 * returns null on `deps.enabled` before it creates a row, and
 * `POST /valuations/:id/pipeline/runs` answers 422 naming the switch. The retry
 * sweep resumes a run that already exists, which is the same work — an AI
 * extraction auto-applied to the params row, then a draft calculation recorded
 * against the engagement — and it did not look at the switch at all. A failure
 * from before the flip keeps its `next_attempt_at`, so turning the pipeline off
 * and restarting had the boot sweep pick that backlog straight back up.
 *
 * Asserted the way `retrySweepFlags.test.ts` asserts its own gate, and for the
 * same reason: the pool throws on contact, so "claimed nothing" is proven by
 * the sweep never issuing the query rather than by a zero it could also have
 * reached after taking the rows. A claim is a write here — it moves the run to
 * an active status, spends a rung of the ladder, and takes the valuation's
 * one-active-run index — so a gate below it would be a slow loss rather than a
 * pause, and turning the switch back on would find runs with nothing left.
 */

/** A pool that fails the test if anything asks it for anything. */
const hostilePool = {
  query: () => {
    throw new Error('the sweep queried the database while AUTO_PIPELINE was off');
  },
  connect: () => {
    throw new Error('the sweep took a connection while AUTO_PIPELINE was off');
  },
} as unknown as pg.Pool;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const deps = (enabled: boolean) =>
  ({
    pool: hostilePool,
    autoPipeline: { pool: hostilePool, enabled, log },
  }) as unknown as Parameters<typeof retryFailedPipelineRuns>[0];

afterEach(() => {
  delete process.env.FLAG_RETRY_LADDERS;
  vi.clearAllMocks();
});

describe('AUTO_PIPELINE=off — the pipeline retry sweep', () => {
  it('claims nothing, so no failed run is resumed on a deployment with the pipeline off', async () => {
    await expect(retryFailedPipelineRuns(deps(false))).resolves.toEqual({
      claimed: 0,
      resumed: 0,
      stranded: 0,
    });
  });

  it('is gated inside the driver, not at the interval', async () => {
    // The timer is not the only caller — the sweep is an exported function and
    // the boot run calls it directly. A switch wired only to the scheduler
    // would leave every other entry point running the thing it turned off.
    await expect(
      retryFailedPipelineRuns({ ...deps(false), limit: 500 } as never),
    ).resolves.toEqual({ claimed: 0, resumed: 0, stranded: 0 });
  });

  it('leaves the backlog in the ladder rather than settling it', async () => {
    // The distinction against the per-valuation opt-out, which settles the run
    // `permanent` and takes it out of the ladder for good. That opt-out is a
    // decision about one engagement; this is a deployment-wide pause, and the
    // rows must keep their schedule and their remaining attempts so switching
    // back on finds the backlog intact. Not writing at all is what makes that
    // true — proven by the hostile pool above, and said here so a future edit
    // that "tidies up" the claimed rows fails a test that names the reason.
    await expect(retryFailedPipelineRuns(deps(false))).resolves.toEqual({
      claimed: 0,
      resumed: 0,
      stranded: 0,
    });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('reaches its claim when the pipeline is on', async () => {
    // The other direction, proven by reaching the database: with the switch on
    // the gate must fall through, or this guard would be an outage of its own.
    await expect(retryFailedPipelineRuns(deps(true))).rejects.toThrow(/the sweep/);
  });
});
