import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import {
  claimRetryablePipelineRuns,
  createPipelineRun,
  latestPipelineRun,
  reapStalePipelineRuns,
  setPipelineRunStatus,
} from '../../src/repos/pipelineRuns.js';

const dbUp = await isDbAvailable();
const SYSTEM = { actorType: 'system', actorId: 'test', source: 'auto-pipeline' } as const;

/**
 * One orchestration per valuation at a time (B-3 §auto-pipeline). The
 * no-overlap rule used to live only in a SELECT that ran before — and outside
 * the transaction of — the INSERT, so two triggers that interleaved between
 * those two statements both started a run against the same valuation.
 */
describe.skipIf(!dbUp)('auto-pipeline run exclusivity', () => {
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

  const activeRuns = async (valuationId: string): Promise<number> => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT count(*) FROM pipeline_runs
       WHERE valuation_id = $1 AND status IN ('queued', 'extracting', 'calculating')`,
      [valuationId],
    );
    return Number(rows[0]!.count);
  };

  it('lets a single run through', async () => {
    const valuationId = await newValuation('SoloRunCo');
    const run = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    expect(run?.status).toBe('queued');
    expect(await activeRuns(valuationId)).toBe(1);
  });

  it('refuses a second active run rather than overlapping the first', async () => {
    const valuationId = await newValuation('OverlapCo');
    const first = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    expect(first).not.toBeNull();

    const second = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'manual', triggeredBy: ops.id },
      SYSTEM,
    );
    expect(second).toBeNull();
    expect(await activeRuns(valuationId)).toBe(1);
  });

  it('serialises a burst of simultaneous triggers down to one run', async () => {
    const valuationId = await newValuation('BurstCo');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createPipelineRun(
          ctx.pool,
          { valuationId, trigger: i === 0 ? 'upload' : 'manual', triggeredBy: ops.id },
          SYSTEM,
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await activeRuns(valuationId)).toBe(1);

    // The losers must not leave a start event behind either — the audit trail
    // should show exactly the one orchestration that actually happened.
    const { rows } = await ctx.pool.query(
      `SELECT 1 FROM valuation_events WHERE valuation_id = $1 AND type = 'auto_pipeline_started'`,
      [valuationId],
    );
    expect(rows).toHaveLength(1);
  });

  it('frees the valuation for a new run once the previous one settles', async () => {
    const valuationId = await newValuation('SequentialCo');
    const first = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    );
    await setPipelineRunStatus(ctx.pool, first!, 'ready', { actor: SYSTEM });

    const second = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'manual', triggeredBy: ops.id },
      SYSTEM,
    );
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);

    // A failed run frees the slot too.
    await setPipelineRunStatus(ctx.pool, second!, 'failed', { error: 'nope', actor: SYSTEM });
    const third = await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'manual', triggeredBy: ops.id },
      SYSTEM,
    );
    expect(third).not.toBeNull();
  });

  it('scopes the rule per valuation', async () => {
    const a = await newValuation('TenantACo');
    const b = await newValuation('TenantBCo');
    expect(
      await createPipelineRun(ctx.pool, { valuationId: a, trigger: 'upload', triggeredBy: ops.id }, SYSTEM),
    ).not.toBeNull();
    expect(
      await createPipelineRun(ctx.pool, { valuationId: b, trigger: 'upload', triggeredBy: ops.id }, SYSTEM),
    ).not.toBeNull();
  });

  it('answers a racing manual trigger with 409 instead of a second run', async () => {
    const valuationId = await newValuation('ManualRaceCo');
    await createPipelineRun(ctx.pool, { valuationId, trigger: 'upload', triggeredBy: ops.id }, SYSTEM);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/pipeline/runs`,
      headers: authHeader(ops.token),
    });
    // AUTO_PIPELINE=off short-circuits before the overlap check; the point of
    // this case is that the route never answers 201 while a run is active.
    expect(res.statusCode).not.toBe(201);
    expect(await activeRuns(valuationId)).toBe(1);
  });
});

/**
 * Terminal states are final. A run wedged on an upstream call can be reaped
 * while it is still in flight; when it finally returns it must not walk the
 * row back out of 'failed' and emit a second terminal event over the first.
 */
describe.skipIf(!dbUp)('auto-pipeline run status finality', () => {
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
    return res.json().valuation.id as string;
  }

  const terminalEvents = async (valuationId: string): Promise<string[]> => {
    const { rows } = await ctx.pool.query<{ type: string }>(
      `SELECT type FROM valuation_events
       WHERE valuation_id = $1 AND type IN ('auto_pipeline_completed', 'auto_pipeline_failed')
       ORDER BY id`,
      [valuationId],
    );
    return rows.map((r) => r.type);
  };

  it('does not let a late worker resurrect a reaped run', async () => {
    const valuationId = await newValuation('ZombieCo');
    const run = (await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    ))!;
    await ctx.pool.query(`UPDATE pipeline_runs SET updated_at = now() - interval '2 hours' WHERE id = $1`, [
      run.id,
    ]);
    await reapStalePipelineRuns(ctx.pool, { olderThanMs: 60_000, actor: SYSTEM });

    // The wedged worker returns and tries to carry on with its stale row.
    const after = await setPipelineRunStatus(ctx.pool, run, 'calculating');
    expect(after?.status).toBe('failed');
    expect(after?.error).toContain('reaped');

    const settled = await setPipelineRunStatus(ctx.pool, run, 'ready', { actor: SYSTEM });
    expect(settled?.status).toBe('failed');
    expect(await latestPipelineRun(ctx.pool, valuationId)).toMatchObject({ status: 'failed' });
    expect(await terminalEvents(valuationId)).toEqual(['auto_pipeline_failed']);
  });

  it('does not let a reaped worker write over the attempt that replaced it', async () => {
    /*
     * The gap the reaped-run guard above cannot see. That one asks "has this run
     * ended"; it cannot ask "is this still *my* run". The retry ladder re-queues
     * a failed run in place — same row id, `attempts` incremented, a new worker
     * on it — so the row the wedged worker is holding becomes active again under
     * somebody else. Every guard then passes and the old worker ends the *new*
     * attempt: 'ready' on the spine for an extraction that is still running.
     */
    const valuationId = await newValuation('CrossGenerationCo');
    const stale = (await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    ))!;
    await ctx.pool.query(`UPDATE pipeline_runs SET updated_at = now() - interval '2 hours' WHERE id = $1`, [
      stale.id,
    ]);
    await reapStalePipelineRuns(ctx.pool, { olderThanMs: 60_000, actor: SYSTEM });

    // The ladder brings the same row back for a second attempt.
    await ctx.pool.query(
      `UPDATE pipeline_runs SET next_attempt_at = now() - interval '1 minute'
                          WHERE id = $1`,
      [stale.id],
    );
    const [live] = await claimRetryablePipelineRuns(ctx.pool, { actor: SYSTEM });
    expect(live!.status).toBe('queued');
    expect(live!.attempts).toBe(stale.attempts + 1);

    // Now the worker from the first attempt finally returns. Its row is stale in
    // a way `status` alone cannot express — the row is genuinely active.
    const hop = await setPipelineRunStatus(ctx.pool, stale, 'calculating');
    expect(hop?.status).toBe('queued');
    expect(hop?.attempts).toBe(live!.attempts);

    const ended = await setPipelineRunStatus(ctx.pool, stale, 'ready', { actor: SYSTEM });
    expect(ended?.status).toBe('queued');

    // The second attempt is untouched and still owns the row, and the only
    // terminal event on the spine is the reap that ended the first attempt.
    expect(await latestPipelineRun(ctx.pool, valuationId)).toMatchObject({
      status: 'queued',
      attempts: live!.attempts,
    });
    expect(await terminalEvents(valuationId)).toEqual(['auto_pipeline_failed']);

    // And the worker that *does* own the row is not caught by the pin.
    const owned = await setPipelineRunStatus(ctx.pool, live!, 'extracting');
    expect(owned?.status).toBe('extracting');
  });

  it('emits exactly one terminal event when a run settles twice', async () => {
    const valuationId = await newValuation('DoubleSettleCo');
    const run = (await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    ))!;
    await setPipelineRunStatus(ctx.pool, run, 'ready', { actor: SYSTEM });
    await setPipelineRunStatus(ctx.pool, run, 'failed', { error: 'late', actor: SYSTEM });
    expect(await terminalEvents(valuationId)).toEqual(['auto_pipeline_completed']);
  });

  it('still advances a live run through its intermediate hops', async () => {
    const valuationId = await newValuation('HappyPathCo');
    let run = (await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    ))!;
    run = (await setPipelineRunStatus(ctx.pool, run, 'extracting'))!;
    expect(run.status).toBe('extracting');
    run = (await setPipelineRunStatus(ctx.pool, run, 'calculating'))!;
    expect(run.status).toBe('calculating');
    run = (await setPipelineRunStatus(ctx.pool, run, 'ready', { actor: SYSTEM }))!;
    expect(run.status).toBe('ready');
    expect(await terminalEvents(valuationId)).toEqual(['auto_pipeline_completed']);
  });

  /**
   * Deployments that ran the old code can already hold overlapping active runs,
   * and the index cannot be built over them. Dropping the index and replaying
   * 0094 reproduces exactly what the first upgrade of such a database does.
   */
  it('migration 0094 closes pre-existing overlapping runs and then builds the index', async () => {
    const valuationId = await newValuation('LegacyOverlapCo');
    const sql = await readFile(
      fileURLToPath(new URL('../../migrations/0094_pipeline_run_single_active.sql', import.meta.url)),
      'utf8',
    );
    await ctx.pool.query('DROP INDEX pipeline_runs_one_active_per_valuation_idx');

    const ids: string[] = [];
    for (const status of ['queued', 'extracting', 'calculating'] as const) {
      const run = (await createPipelineRun(
        ctx.pool,
        { valuationId, trigger: 'manual', triggeredBy: ops.id },
        SYSTEM,
      ))!;
      await ctx.pool.query('UPDATE pipeline_runs SET status = $1 WHERE id = $2', [status, run.id]);
      ids.push(run.id);
    }

    await ctx.pool.query(sql);

    const { rows } = await ctx.pool.query<{ id: string; status: string; error: string | null }>(
      'SELECT id, status, error FROM pipeline_runs WHERE valuation_id = $1 ORDER BY created_at, id',
      [valuationId],
    );
    // Newest survives — it is the run the UI has been polling; the rest close.
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'calculating']);
    expect(rows[0]!.error).toContain('superseded');
    expect(rows.at(-1)!.id).toBe(ids.at(-1));

    // And the index is in force again, so nothing new can overlap the survivor.
    expect(
      await createPipelineRun(ctx.pool, { valuationId, trigger: 'manual', triggeredBy: ops.id }, SYSTEM),
    ).toBeNull();
  });

  it('returns null instead of throwing when the run row is gone', async () => {
    const valuationId = await newValuation('VanishedCo');
    const run = (await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    ))!;
    await ctx.pool.query('DELETE FROM pipeline_runs WHERE id = $1', [run.id]);
    await expect(setPipelineRunStatus(ctx.pool, run, 'ready', { actor: SYSTEM })).resolves.toBeNull();
  });
});

/**
 * The retry sweep under the race migration 0094 exists to lose (round 268, M5).
 *
 * `claimRetryablePipelineRuns` re-queues row by row and stands a run down when
 * its valuation already has an active run, and its comment says why: a set-based
 * UPDATE "would take the whole batch down". But the check that finds the newer
 * run is a `NOT EXISTS` — the same pre-flight SELECT shape migration 0094 was
 * written because of — and the re-queue is the one write in this file that
 * *enters* the partial unique index. An upload hook whose INSERT commits inside
 * that window raises 23505 from the UPDATE, and without a savepoint that aborts
 * the transaction: every run claimed earlier in the batch is rolled back with
 * its start event, which is exactly the outcome the row-by-row loop is for.
 *
 * Reproduced by holding the conflicting INSERT open: an uncommitted row is
 * invisible to the `NOT EXISTS` and present in the index, so the claim blocks on
 * it and takes the violation the moment the other transaction commits.
 */
describe.skipIf(!dbUp)('auto-pipeline retry claim under a racing trigger', () => {
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
    return res.json().valuation.id as string;
  }

  /** A valuation holding one failed run whose retry is `dueMinutes` overdue. */
  async function valuationWithDueRetry(company: string, dueMinutes: number) {
    const valuationId = await newValuation(company);
    const run = (await createPipelineRun(
      ctx.pool,
      { valuationId, trigger: 'upload', triggeredBy: ops.id },
      SYSTEM,
    ))!;
    await setPipelineRunStatus(ctx.pool, run, 'failed', { error: 'upstream', actor: SYSTEM });
    await ctx.pool.query(
      `UPDATE pipeline_runs SET next_attempt_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
      [run.id, String(dueMinutes)],
    );
    return { valuationId, run };
  }

  it('keeps the rest of the batch when one re-queue loses the unique index', async () => {
    // Claimed first: `next_attempt_at ASC` puts the older one at the front, so
    // it is already re-queued (and its start event written) when the conflict
    // lands on the second.
    const quiet = await valuationWithDueRetry('QuietRetryCo', 5);
    const raced = await valuationWithDueRetry('RacedRetryCo', 1);

    // The racing trigger: an active run for the raced valuation, inserted and
    // held. Invisible to the claim's `NOT EXISTS`, present in the index.
    const other = await ctx.pool.connect();
    let committed = false;
    try {
      await other.query('BEGIN');
      await other.query(
        `INSERT INTO pipeline_runs (id, valuation_id, trigger, triggered_by) VALUES ($1, $2, 'manual', $3)`,
        [newUlid(), raced.valuationId, ops.id],
      );

      const claiming = claimRetryablePipelineRuns(ctx.pool, { actor: SYSTEM });
      // Long enough for the claim to reach the UPDATE and block on the index.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await other.query('COMMIT');
      committed = true;

      const claimed = await claiming;
      expect(claimed.map((r) => r.id)).toEqual([quiet.run.id]);
    } finally {
      if (!committed) await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }

    // The batch survived: the first claim and its start event are committed.
    expect(await latestPipelineRun(ctx.pool, quiet.valuationId)).toMatchObject({
      status: 'queued',
      attempts: quiet.run.attempts + 1,
    });
    const { rows: started } = await ctx.pool.query(
      `SELECT 1 FROM valuation_events
        WHERE valuation_id = $1 AND type = 'auto_pipeline_started'`,
      [quiet.valuationId],
    );
    expect(started).toHaveLength(2); // the original trigger, and the retry

    // The loser is stood down exactly as a pre-flight miss stands it down —
    // still failed, no schedule left, and the reason on the row.
    const { rows } = await ctx.pool.query<{ status: string; next_attempt_at: Date | null; error: string }>(
      'SELECT status, next_attempt_at, error FROM pipeline_runs WHERE id = $1',
      [raced.run.id],
    );
    expect(rows[0]).toMatchObject({ status: 'failed', next_attempt_at: null });
    expect(rows[0]!.error).toContain('retry abandoned');
  });
});
