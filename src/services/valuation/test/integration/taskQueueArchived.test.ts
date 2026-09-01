import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The last work queue that offered retired engagements — and the only one whose
 * rows an operator was then forbidden to clear.
 *
 * `archived_at` is the platform's soft delete for a valuation, and every list
 * that builds its own WHERE over the table has been swept into agreement with
 * it: the reviewer sign-off queue and the pay-now list (`queuesArchived`), the
 * two remediation queues, the shared inbox and its badge, the re-filing queue
 * (`queuesArchivedRemaining`), the monitor scan, the drip campaigns, the SLA
 * sweep. `review_tasks` never joined `valuations` at all, so `GET
 * /api/v1/tasks` — an operator's own worklist, its status tabs and its overdue
 * filter — kept listing tasks belonging to files nothing else in the product
 * shows.
 *
 * Worse here than in the queues those rounds finished, because of what happened
 * when somebody acted on the row. `refuseIfSubjectRetired` reaches a task
 * through its own id, so moving one of these to `done` or `cancelled` is
 * answered 409. The rows were permanent: not workable, not clearable, `open`
 * past their `due_at` forever — and `overdue` is computed from exactly that. A
 * queue built to show what is late accumulated a floor of work nobody was
 * allowed to finish. That refusal is asserted below beside the filter, because
 * the two together are the argument for it.
 *
 * The engagement's own tasks panel is the deliberate exception, and the same
 * carve-out `buildValuationWhere` makes: a caller who names one engagement has
 * already been handed its id, and a retirement is reversible (R90), so a
 * withdrawn file's own page showing its own history is the point. What it must
 * not do is put that history in somebody else's queue.
 */
describe.skipIf(!dbUp)('the task queue drops retired engagements', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  let liveId: string;
  let retiredId: string;
  let liveTaskId: string;
  let retiredTaskId: string;

  const seedValuation = async (company: string, archived: boolean): Promise<string> => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO valuations (id, kind, company_name, user_id, state, archived_at)
       VALUES ($1, '409a', $2, $3, 'drafted', $4)`,
      [id, company, client.id, archived ? new Date() : null],
    );
    return id;
  };

  /** Identical but for the parent's `archived_at`: same kind, assignee, overdue. */
  const seedTask = async (valuationId: string): Promise<string> => {
    const id = newUlid();
    await ctx.pool.query(
      `INSERT INTO review_tasks (id, valuation_id, kind, status, title, assignee_id, due_at)
       VALUES ($1, $2, 'cap_table', 'open', 'Recheck the option pool', $3, now() - interval '2 days')`,
      [id, valuationId, ops.id],
    );
    return id;
  };

  const get = async (url: string) => {
    const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(ops.token) });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    ctx = await setupTestApp();
    ops = await seedUser(ctx, { roles: ['admin'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });

    liveId = await seedValuation('Halverson Optics', false);
    retiredId = await seedValuation('Bellweather Freight', true);
    liveTaskId = await seedTask(liveId);
    retiredTaskId = await seedTask(retiredId);
  });

  afterAll(async () => ctx?.teardown());

  it('keeps the withdrawn engagement’s task out of the console', async () => {
    const page = await get('/api/v1/tasks');
    const ids = page.tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain(liveTaskId);
    expect(ids).not.toContain(retiredTaskId);
    // The total is a separate query over the same WHERE, so it can report a
    // depth the page does not show — the failure `queuesArchived` names.
    expect(page.total).toBe(page.tasks.length);
  });

  it('keeps it out of an operator’s own worklist and the overdue filter', async () => {
    for (const url of [
      '/api/v1/tasks?assignee=me',
      '/api/v1/tasks?overdue=true',
      '/api/v1/tasks?status=open',
    ]) {
      const page = await get(url);
      const ids = page.tasks.map((t: { id: string }) => t.id);
      expect(ids, url).toContain(liveTaskId);
      expect(ids, url).not.toContain(retiredTaskId);
    }
  });

  it('cannot be cleared either, which is why leaving it in the queue was permanent', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${retiredTaskId}`,
      headers: authHeader(ops.token),
      payload: { status: 'cancelled' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('still shows it on the withdrawn engagement’s own page', async () => {
    // The carve-out. Retirement is reversible, and the file's own history is
    // what its page is for.
    const byValuation = await get(`/api/v1/valuations/${retiredId}/tasks`);
    expect(byValuation.tasks.map((t: { id: string }) => t.id)).toEqual([retiredTaskId]);
    // And the console filtered to that engagement answers the same way, so the
    // two doors that name one file cannot disagree about what it holds.
    const filtered = await get(`/api/v1/tasks?valuation_id=${retiredId}`);
    expect(filtered.tasks.map((t: { id: string }) => t.id)).toEqual([retiredTaskId]);
  });
});
