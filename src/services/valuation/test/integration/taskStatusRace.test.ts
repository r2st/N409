import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { patchTask } from '../../src/repos/tasks.js';

const dbUp = await isDbAvailable();

/**
 * The review-task board under two people working the same queue.
 *
 * `PATCH /api/v1/tasks/:id` loads the task, decides everything from that row —
 * whether the status is changing, whether the clock starts, whether completion
 * is stamped or cleared, and what the audit event says the task moved *from* —
 * and then wrote by primary key alone. The tasks board is a shared ops worklist
 * with a status control on every row, so a second operator holding a row read a
 * moment earlier is the ordinary case, not the exotic one.
 *
 * `terminalStatusWrites` marks this table unguarded and is right about the
 * question it asks: a task is meant to move both ways, so there is no terminal
 * state to protect. "Is this still the status I read" is a different question
 * and nothing was asking it.
 *
 * What that cost is not a duplicate row. `review_task_updated` carries a
 * `changes.status.from`, and the loser's event named the status it read rather
 * than the one the task was actually in — a transition that never happened,
 * written to an append-only spine a compliance reader is entitled to believe.
 */
describe.skipIf(!dbUp)('review task status under concurrency', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'TaskRaceCo' },
    });
    valuationId = created.json().valuation.id as string;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const newTask = async (title: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/tasks`,
      headers: authHeader(ops.token),
      payload: { kind: 'other', title, assignee_id: ops.id },
    });
    expect(res.statusCode).toBe(201);
    return res.json().task.id as string;
  };

  const patch = (id: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${id}`,
      headers: authHeader(ops.token),
      payload: body,
    });

  const statusEvents = async (): Promise<Array<{ from: string | null; to: string }>> => {
    const { rows } = await ctx.pool.query<{
      payload: { changes?: { status?: { from: string; to: string } } };
    }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'review_task_updated' ORDER BY seq`,
      [valuationId],
    );
    return rows
      .map((r) => r.payload.changes?.status)
      .filter((c): c is { from: string; to: string } => Boolean(c));
  };

  it('lets one of two simultaneous moves through and tells the other where the task went', async () => {
    const id = await newTask('Contended task');
    // One read, two operators — which is what the board hands out: the route
    // loads the row on its own connection and every decision below is made
    // from that copy.
    const { rows } = await ctx.pool.query(`SELECT * FROM review_tasks WHERE id = $1`, [id]);
    const shared = rows[0]! as never;
    const actor = { actorType: 'human', actorId: ops.id, source: 'test' } as const;

    const settled = await Promise.allSettled([
      patchTask(ctx.pool, shared, { status: 'in_progress' }, actor),
      patchTask(ctx.pool, shared, { status: 'blocked' }, actor),
    ]);
    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const landed = (won[0] as PromiseFulfilledResult<{ status: string }>).value.status;
    const refusal = (lost[0] as PromiseRejectedResult).reason as { status: number; detail: string };
    expect(refusal.status).toBe(409);
    // The refusal names where the task actually went — that is what decides the
    // caller's next move — and names it the way the board does, not by column
    // value.
    expect(refusal.detail).toContain(landed === 'in_progress' ? 'In progress' : 'Blocked');
    expect(refusal.detail).not.toContain(landed);

    // One transition, one event, and its `from` is the status that really was.
    const moves = (await statusEvents()).filter((m) => m.to === 'in_progress' || m.to === 'blocked');
    expect(moves).toEqual([{ from: 'open', to: landed }]);
  });

  it('leaves no trail behind a refused move', async () => {
    const id = await newTask('Stale mover');
    expect((await patch(id, { status: 'done' })).statusCode).toBe(200);

    const before = await statusEvents();
    // A second operator whose copy of the row still says 'open'. The route
    // re-reads, so drive the repo the way a stale caller reaches it.
    const { rows } = await ctx.pool.query(`SELECT * FROM review_tasks WHERE id = $1`, [id]);
    const stale = { ...rows[0]!, status: 'open' };
    await expect(
      patchTask(
        ctx.pool,
        stale as never,
        { status: 'cancelled' },
        {
          actorType: 'human',
          actorId: ops.id,
          source: 'test',
        },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(await statusEvents()).toEqual(before);
    const { rows: after } = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM review_tasks WHERE id = $1`,
      [id],
    );
    expect(after[0]!.status).toBe('done');
  });

  it('does not restart the clock for a caller whose copy predates it starting', async () => {
    // `started_at` stamps only the *first* start — `!current.started_at` — and
    // that read was of the caller's row, not of the row being written. Reopening
    // a task returns it to a status an older copy still names, so a caller
    // holding the pre-start row passes the guard and the SLA clock is moved
    // forward to now: a task started at 09:00 reports 11:00 and buys itself two
    // hours. COALESCE asks the row instead.
    const id = await newTask('Clock task');
    const { rows: opened } = await ctx.pool.query(`SELECT * FROM review_tasks WHERE id = $1`, [id]);
    const preStart = opened[0]! as never;
    const actor = { actorType: 'human', actorId: ops.id, source: 'test' } as const;

    const started = await patchTask(ctx.pool, preStart, { status: 'in_progress' }, actor);
    const startedAt = started.started_at;
    expect(startedAt).toBeTruthy();

    // Reopened, so 'open' is the live status again and the stale copy matches.
    await patchTask(ctx.pool, started, { status: 'open' }, actor);
    const restarted = await patchTask(ctx.pool, preStart, { status: 'in_progress' }, actor);
    expect(restarted.started_at).toEqual(startedAt);
  });

  it('refuses resurrection of a done task at the route level', async () => {
    const id = await newTask('Terminal task');
    expect((await patch(id, { status: 'done' })).statusCode).toBe(200);

    const res = await patch(id, { status: 'open' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('Done');
  });

  it('refuses resurrection of a cancelled task at the route level', async () => {
    const id = await newTask('Cancelled terminal');
    expect((await patch(id, { status: 'cancelled' })).statusCode).toBe(200);

    const res = await patch(id, { status: 'in_progress' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('Cancelled');
  });

  it('does not refuse an edit that clobbers nothing', async () => {
    // Only the status move is conditional. A reassignment sets its own column,
    // so failing it because a colleague moved the status would be a refusal
    // with no lost write behind it.
    const id = await newTask('Reassigned task');
    const other = await seedUser(ctx, { roles: ['reviewer'] });
    expect((await patch(id, { status: 'in_progress' })).statusCode).toBe(200);

    const res = await patch(id, { assignee_id: other.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.assignee_id).toBe(other.id);
    expect(res.json().task.status).toBe('in_progress');
  });
});
