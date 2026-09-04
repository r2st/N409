import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { restoreValuations, retireValuations } from '../../src/repos/valuationPurge.js';

const dbUp = await isDbAvailable();

/**
 * The task queue's clock across a retirement (R408).
 *
 * `engagementRestoreClock.test.ts` is the same test one table over, and the
 * argument is identical: retirement moves `archived_at` and nothing else, so
 * the *readers* were filtered and the clock was not. R342 took a withdrawn
 * engagement's tasks out of the ops worklist and deliberately left them on the
 * engagement's own panel — which is exactly what hides this, because nothing
 * chases a task while the file is withdrawn and `due_at` runs unwatched.
 *
 * So an engagement retired in error and restored months later rejoined the
 * queue with every open task late by the length of the withdrawal, sorted to
 * the top of it (`ORDER BY due_at ASC`) and counted in the overdue tab. No work
 * was owed for any of those hours: R89 refused every write to the file.
 */
describe.skipIf(!dbUp)('restoring an engagement credits back its tasks’ due dates', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  async function seedValuation(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(created.statusCode).toBe(201);
    return created.json().valuation.id as string;
  }

  /**
   * A task created `createdAgo` ago and due at `due` (a signed interval from
   * now — `-89 days` is a due date 89 days in the past).
   *
   * Backdated in SQL rather than by waiting: what the repair is measured
   * against is the ordering `created_at < archived_at < due_at`, which is a
   * task that still had time left when the firm withdrew the file.
   */
  async function seedTask(
    valuationId: string,
    title: string,
    opts: { createdAgo: string; due: string; status?: string },
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/tasks`,
      headers: authHeader(ops.token),
      payload: { kind: 'data_review', title, sla_hours: 24, assignee_id: ops.id },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().task.id as string;
    await pool.query(
      `UPDATE review_tasks
          SET due_at = now() + $2::interval,
              created_at = now() - $3::interval,
              status = $4::review_task_status
        WHERE id = $1`,
      [id, opts.due, opts.createdAgo, opts.status ?? 'open'],
    );
    return id;
  }

  const dueAt = async (taskId: string): Promise<Date> => {
    const { rows } = await pool.query<{ due_at: Date }>('SELECT due_at FROM review_tasks WHERE id = $1', [
      taskId,
    ]);
    return rows[0]!.due_at;
  };

  /** Retire, backdate the withdrawal to `ago`, then restore. */
  async function withdrawAndRestore(valuationId: string, ago: string) {
    await retireValuations(pool, [valuationId]);
    await pool.query(`UPDATE valuations SET archived_at = now() - $2::interval WHERE id = $1`, [
      valuationId,
      ago,
    ]);
    return restoreValuations(pool, [valuationId]);
  }

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    admin = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  it('does not hand back a task ninety days late for a day it had left to run', async () => {
    const id = await seedValuation('Withdrawn Tasks Co');
    // Created 92 days ago, due 89 days ago, withdrawn 90 days ago: one day of
    // its SLA was still to run when the firm stopped work on the file.
    const taskId = await seedTask(id, 'Collect the cap table', {
      createdAgo: '92 days',
      due: '-89 days',
    });
    const before = await dueAt(taskId);

    const result = await withdrawAndRestore(id, '90 days');
    expect(result.restored).toEqual([id]);

    const after = await dueAt(taskId);
    // Moved forward by the withdrawal, not reset: the day it had left is still
    // a day, and the ninety it spent withdrawn are not held against it.
    const shiftedDays = (after.getTime() - before.getTime()) / 86_400_000;
    expect(shiftedDays).toBeGreaterThan(89.9);
    expect(shiftedDays).toBeLessThan(90.1);
    const hoursLeft = (after.getTime() - Date.now()) / 3_600_000;
    expect(hoursLeft).toBeGreaterThan(23);
    expect(hoursLeft).toBeLessThan(25);
  });

  it('does not put it at the top of the queue it just rejoined', async () => {
    const id = await seedValuation('Overdue Tab Co');
    const taskId = await seedTask(id, 'Reconcile the financials', {
      createdAgo: '62 days',
      due: '-59 days',
    });
    await withdrawAndRestore(id, '60 days');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks?overdue=true&per_page=100',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().tasks as { id: string }[]).map((t) => t.id);
    expect(ids).not.toContain(taskId);

    const all = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${id}/tasks`,
      headers: authHeader(ops.token),
    });
    const task = (all.json().tasks as { id: string; overdue: boolean }[]).find((t) => t.id === taskId);
    expect(task?.overdue).toBe(false);
  });

  it('leaves a task that was already closed before the withdrawal alone', async () => {
    const id = await seedValuation('Closed Task Co');
    const taskId = await seedTask(id, 'Already done', {
      createdAgo: '32 days',
      due: '-29 days',
      status: 'done',
    });
    const before = await dueAt(taskId);
    await withdrawAndRestore(id, '30 days');
    // Its clock stopped when it closed. Rewriting the due date of a finished
    // record to tidy a number nothing reads would falsify the record.
    expect((await dueAt(taskId)).getTime()).toBe(before.getTime());
  });

  it('leaves a task raised after the withdrawal alone', async () => {
    const id = await seedValuation('Late Task Co');
    // `created_at` inside the withdrawal: it has not been waiting through it,
    // and a repair meant to be neutral must not push it into the future.
    const taskId = await seedTask(id, 'Raised during the withdrawal', {
      createdAgo: '1 minute',
      due: '1 day',
    });
    const before = await dueAt(taskId);
    await withdrawAndRestore(id, '30 days');
    expect((await dueAt(taskId)).getTime()).toBe(before.getTime());
  });

  it('reports the credit rather than moving the clock in silence', async () => {
    const id = await seedValuation('Reported Task Credit Co');
    await seedTask(id, 'One', { createdAgo: '32 days', due: '-29 days' });
    await seedTask(id, 'Two', { createdAgo: '32 days', due: '-28 days' });
    await retireValuations(pool, [id]);
    await pool.query(`UPDATE valuations SET archived_at = now() - interval '30 days' WHERE id = $1`, [id]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/retention/valuations/${id}/restore`,
      headers: authHeader(admin.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const credited = res.json().tasks_credited as {
      valuation_id: string;
      tasks: number;
      credited_seconds: number;
    }[];
    expect(credited).toHaveLength(1);
    expect(credited[0]!.valuation_id).toBe(id);
    // Per engagement with a count, the grain the retention trail already speaks
    // in — a two-hundred-id batch must not put a row per task on the ledger.
    expect(credited[0]!.tasks).toBe(2);
    const days = credited[0]!.credited_seconds / 86_400;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM admin_events WHERE type = 'valuation_restored' AND subject_id = $1`,
      [id],
    );
    expect(rows[0]!.payload.tasks_credited).toEqual([
      { valuation_id: id, tasks: 2, credited_seconds: credited[0]!.credited_seconds },
    ]);
  });
});
