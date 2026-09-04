import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The ops task queue, and the second way an engagement stops.
 *
 * R342 took withdrawn engagements' tasks out of `GET /api/v1/tasks` — "the one
 * queue on this platform that still offered work on engagements the firm had
 * withdrawn" — and left them on the engagement's own panel, because a caller
 * naming one file is asking for that file's history.
 *
 * `cancelled`, `timeout` and `ignored` are the other way work stops, and R400
 * established that pair across five subsystems: the pipeline board, the overdue
 * sweep, the pay panel, the monitor list and the connector cards all ask both
 * questions now. `listTasks` asked only about `archived_at`, so the queue an
 * operator works from — its status tabs, its overdue tab, and the total under
 * them — went on offering the open tasks of engagements that had been called
 * off, sorted to the top by `due_at ASC` as they went past due.
 */
describe.skipIf(!dbUp)('the task queue and an engagement that was called off', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  let closedId: string;
  let liveId: string;
  let closedTaskId: string;
  let liveTaskId: string;

  async function seedValuation(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    return created.json().valuation.id as string;
  }

  /** An open task, an hour past its due date. */
  async function seedOverdueTask(valuationId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/tasks`,
      headers: authHeader(ops.token),
      payload: {
        kind: 'data_review',
        title: 'Chase the cap table',
        assignee_id: ops.id,
        due_at: new Date(Date.now() - 3_600_000).toISOString(),
      },
    });
    if (res.statusCode !== 201) throw new Error(`task create failed: ${res.body}`);
    return res.json().task.id as string;
  }

  const queue = async (query = ''): Promise<{ tasks: { id: string }[]; total: number }> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks?per_page=100${query}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { tasks: { id: string }[]; total: number };
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });

    closedId = await seedValuation('Called Off Co');
    closedTaskId = await seedOverdueTask(closedId);
    liveId = await seedValuation('Still Live Co');
    liveTaskId = await seedOverdueTask(liveId);

    const cancelled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${closedId}`,
      headers: authHeader(ops.token),
      payload: { state: 'cancelled' },
    });
    if (cancelled.statusCode !== 200) throw new Error(`cancel failed: ${cancelled.body}`);
  });
  afterAll(async () => ctx?.teardown());

  it('drops the called-off engagement’s task from the queue, and from its total', async () => {
    const { tasks, total } = await queue();
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(liveTaskId);
    expect(ids).not.toContain(closedTaskId);
    // The count under the tabs is the other half: a page that hides the row
    // while the total still counts it is a queue that never empties.
    expect(total).toBe(tasks.length);
  });

  it('keeps it out of the overdue tab, which is where it would sort first', async () => {
    const { tasks } = await queue('&overdue=true');
    expect(tasks.map((t) => t.id)).toEqual([liveTaskId]);
  });

  it('keeps it out of the status tabs as well', async () => {
    const { tasks } = await queue('&status=open');
    expect(tasks.map((t) => t.id)).not.toContain(closedTaskId);
  });

  it('still shows it on the engagement’s own panel', async () => {
    // R342's carve-out: a caller naming one engagement has already been handed
    // the id and looked the row up, and a called-off file's own page showing
    // its own history is the point.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${closedId}/tasks`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().tasks as { id: string }[]).map((t) => t.id)).toContain(closedTaskId);
  });

  it('puts it back when the engagement is restarted', async () => {
    const restart = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${closedId}/workflow/restart`,
      headers: authHeader(ops.token),
    });
    expect(restart.statusCode).toBe(200);
    const { tasks } = await queue();
    expect(tasks.map((t) => t.id)).toContain(closedTaskId);
    // And it comes back with the clock it had, not the one that ran while
    // nobody was working the file — see `creditClocksForReopen`.
    const { rows } = await pool.query<{ due_at: Date }>('SELECT due_at FROM review_tasks WHERE id = $1', [
      closedTaskId,
    ]);
    expect(rows[0]!.due_at.getTime()).toBeGreaterThan(Date.now() - 2 * 3_600_000);
  });
});
