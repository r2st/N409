import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  createPipelineRun,
  setPipelineRunStatus,
  type PipelineRunRow,
} from '../../src/repos/pipelineRuns.js';
import {
  PIPELINE_MAX_ATTEMPTS,
  PIPELINE_RETRY_BACKOFF_MINUTES,
  pipelineRetryWindowMs,
} from '../../src/domain/pipelineRetry.js';

const dbUp = await isDbAvailable();
const SYSTEM = { actorType: 'system', actorId: 'test', source: 'auto-pipeline' } as const;

const TRANSIENT = { kind: 'transient', reason: 'ai.unavailable', retryable: true } as const;
const PERMANENT = { kind: 'permanent', reason: 'params.missing', retryable: false } as const;

/**
 * The retry ladder itself — the arithmetic that decides when a failed run comes
 * back, and whether it comes back at all.
 *
 * `domain/pipelineRetry.ts` is the specification and it is unit-tested. What was
 * not tested is that the database agrees with it. The schedule is stamped by the
 * same UPDATE that records the failure, so the ladder is re-implemented in SQL —
 * a CASE, an `attempts` comparison, and a `random()` — and nothing compared the
 * two. `pipelineRetryWindowMs` exists precisely to make that comparison, and had
 * no callers: the helper was written for a test that was never finished.
 *
 * The sweep test next door looks like it covers this and does not. It fails a
 * run transiently, which does run the ladder, and then immediately overwrites
 * `next_attempt_at` with a hand-written `now() - interval '1 minute'` so that
 * the row is due. The ladder's output is discarded before anything reads it.
 *
 * What that left unguarded is both of the rules the ladder exists to enforce:
 * only transient failures are scheduled, and the ladder is bounded. Losing the
 * first turns every permanently-broken valuation into a recurring upstream call
 * — which for a free-tier LLM quota means the broken runs eat the allowance the
 * healthy ones need. Losing the second is the same thing forever.
 */
describe.skipIf(!dbUp)('the auto-pipeline retry ladder as the database applies it', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
  }, 60_000);

  afterAll(async () => ctx?.teardown());

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

  async function newRun(company: string): Promise<PipelineRunRow> {
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId: await newValuation(company), trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    expect(run).not.toBeNull();
    return run!;
  }

  /**
   * Fail a run as if it had already been attempted `attemptsMade` times.
   *
   * The count lives in two places on purpose and the repo reads both: the
   * delay comes from the row the worker is holding, and the ceiling is checked
   * against the column, which may have moved on since. Setting them together is
   * the ordinary case; they are separated in the last test below.
   *
   * A run that is already `failed` is excluded by the UPDATE's own WHERE, so
   * each rung starts from an active status the way a real re-attempt does.
   */
  async function failAt(
    run: PipelineRunRow,
    attemptsMade: number,
    failure: typeof TRANSIENT | typeof PERMANENT = TRANSIENT,
  ): Promise<PipelineRunRow> {
    await ctx.pool.query(`UPDATE pipeline_runs SET status = 'extracting', attempts = $2 WHERE id = $1`, [
      run.id,
      attemptsMade,
    ]);
    const settled = await setPipelineRunStatus(ctx.pool, { ...run, attempts: attemptsMade }, 'failed', {
      error: 'upstream said no',
      actor: SYSTEM,
      failure,
    });
    expect(settled).not.toBeNull();
    return settled!;
  }

  /** Milliseconds from now until the stamped attempt. */
  const waitMs = (row: PipelineRunRow) => row.next_attempt_at!.getTime() - Date.now();

  it('schedules a transient failure inside the window the ladder specifies', async () => {
    const settled = await failAt(await newRun('Ladder First Co'), 1);
    const window = pipelineRetryWindowMs(1)!;

    expect(settled.next_attempt_at).not.toBeNull();
    // A second of slack for the round trip; the window's own steps are minutes.
    expect(waitMs(settled)).toBeGreaterThan(window.minMs - 1_000);
    expect(waitMs(settled)).toBeLessThanOrEqual(window.maxMs);
  });

  it('walks every rung of the ladder, not just the first', async () => {
    // A CASE that returned a constant would pass the test above. Each step has
    // to land in its own window, and the windows do not overlap.
    const run = await newRun('Ladder Every Rung Co');
    for (let attemptsMade = 1; attemptsMade < PIPELINE_MAX_ATTEMPTS; attemptsMade += 1) {
      const settled = await failAt(run, attemptsMade);
      const window = pipelineRetryWindowMs(attemptsMade)!;
      expect(settled.next_attempt_at, `attempt ${attemptsMade} must be scheduled`).not.toBeNull();
      expect(waitMs(settled), `attempt ${attemptsMade} too soon`).toBeGreaterThan(window.minMs - 1_000);
      expect(waitMs(settled), `attempt ${attemptsMade} too late`).toBeLessThanOrEqual(window.maxMs);
    }
  });

  it('leaves a permanent failure unscheduled', async () => {
    // Rule 1. A run that failed because the valuation has no params row fails
    // identically every time; scheduling it is a machine for spending quota.
    const settled = await failAt(await newRun('Ladder Permanent Co'), 1, PERMANENT);
    expect(settled.next_attempt_at).toBeNull();
    expect(settled.failure_kind).toBe('permanent');
  });

  it('stops scheduling once the attempts are spent', async () => {
    // Rule 2. At the ceiling the row stays failed and only an operator moves it.
    const settled = await failAt(await newRun('Ladder Exhausted Co'), PIPELINE_MAX_ATTEMPTS);
    expect(settled.status).toBe('failed');
    expect(settled.next_attempt_at).toBeNull();
  });

  it('gives the last attempt a schedule and the one after it none', async () => {
    // The boundary itself: off by one here is either a wasted attempt or a
    // silently dropped one, and both look like the ladder working.
    const last = await failAt(await newRun('Ladder Boundary Co'), PIPELINE_MAX_ATTEMPTS - 1);
    expect(last.next_attempt_at).not.toBeNull();
    const past = await failAt(last, PIPELINE_MAX_ATTEMPTS);
    expect(past.next_attempt_at).toBeNull();
  });

  it('jitters, so one outage does not come back as one thundering batch', async () => {
    // Equal jitter is why the window is a range rather than a point. Dropping
    // the `random()` from the CASE still lands inside every window above, and
    // hands a just-recovered AI service the whole backlog in one moment.
    const stamps: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const settled = await failAt(await newRun(`Ladder Jitter ${i} Co`), 3);
      stamps.push(settled.next_attempt_at!.getTime());
    }
    const spread = Math.max(...stamps) - Math.min(...stamps);
    const step = PIPELINE_RETRY_BACKOFF_MINUTES[2]! * 60_000;
    // Eight uniform draws over half a 30-minute step span minutes, not seconds.
    expect(spread).toBeGreaterThan(step * 0.1);
  });

  it('checks the ceiling against the column, not the row the worker is holding', async () => {
    // The repo comments on this deliberately: a worker can hold a row for
    // minutes while other attempts are recorded. The delay may come from the
    // stale copy, but whether there is a delay at all must not.
    const run = await newRun('Ladder Stale Row Co');
    await ctx.pool.query(`UPDATE pipeline_runs SET status = 'extracting', attempts = $2 WHERE id = $1`, [
      run.id,
      PIPELINE_MAX_ATTEMPTS,
    ]);
    const settled = await setPipelineRunStatus(
      ctx.pool,
      { ...run, attempts: 1 }, // stale: this worker thinks one attempt has been made
      'failed',
      { error: 'upstream said no', actor: SYSTEM, failure: TRANSIENT },
    );
    expect(settled?.next_attempt_at).toBeNull();
  });
});
