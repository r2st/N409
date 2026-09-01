import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuation, findValuationById, patchValuation } from '../../src/repos/valuations.js';
import { createTask, findTaskById, patchTask } from '../../src/repos/tasks.js';
import { softDeleteUser } from '../../src/repos/adminUsers.js';
import { forceState, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Closing an account has to let go of the work that account was holding.
 *
 * R334 made an assignment to a closed account impossible to *create*, because
 * the write succeeds while every consumer downstream silently drops the
 * assignee. This is the same state reached from the other side, and it is the
 * ordinary one: the analyst leaves, an administrator closes the account, and
 * every engagement already on their name stays on it.
 *
 * The attention queue is what makes it invisible. It flags an engagement in
 * review or drafting with nobody's name on it by asking whether
 * `assigned_reviewer_id` is null — so a released engagement is flagged and one
 * still naming a closed account is not.
 */
describe.skipIf(!dbUp)('closing an account releases the work it was holding', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let leaver: Awaited<ReturnType<typeof seedUser>>;

  const actor = () => ({ actorType: 'human' as const, actorId: admin.id, source: 'test' });

  const engagement = async (name: string, state?: string): Promise<string> => {
    const v = await createValuation(ctx.pool, { kind: '409a', companyName: name, userId: admin.id }, actor());
    await patchValuation(ctx.pool, v, { assigned_reviewer_id: leaver.id }, actor());
    if (state) await forceState(ctx, v.id, state);
    return v.id;
  };

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    admin = await seedUser(ctx, { roles: ['admin'] });
    leaver = await seedUser(ctx, { roles: ['reviewer'] });
  });
  afterAll(async () => ctx?.teardown());

  it('clears the reviewer on live engagements, and reports which ones', async () => {
    const live = await engagement('Released Co', 'review');
    const before = await findValuationById(ctx.pool, live);
    const released = await softDeleteUser(ctx.pool, leaver.id, actor());

    expect(released?.valuations).toContain(live);
    const after = await findValuationById(ctx.pool, live);
    expect(after?.assigned_reviewer_id).toBeNull();
    // `assigned_reviewer_id` is an ops-patchable field, so an operator holding
    // the form has to be told — see `lockCounterDiscipline.test.ts`.
    expect(after!.version).toBe(before!.version + 1);
  });

  it('leaves the reviewer on a published engagement, which is a record of who reviewed it', async () => {
    const done = await engagement('Published Co', 'published');
    const other = await seedUser(ctx, { roles: ['reviewer'] });
    await patchValuation(
      ctx.pool,
      (await findValuationById(ctx.pool, done))!,
      { assigned_reviewer_id: other.id },
      actor(),
    );
    const released = await softDeleteUser(ctx.pool, other.id, actor());

    expect(released?.valuations).not.toContain(done);
    expect((await findValuationById(ctx.pool, done))?.assigned_reviewer_id).toBe(other.id);
  });

  it('clears the assignee on unfinished tasks and leaves finished ones alone', async () => {
    const assignee = await seedUser(ctx, { roles: ['reviewer'] });
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Task Co', userId: admin.id },
      actor(),
    );
    const open = await createTask(
      ctx.pool,
      { valuationId: v.id, kind: 'data_review', title: 'Open', assigneeId: assignee.id, createdBy: admin.id },
      actor(),
    );
    const finished = await createTask(
      ctx.pool,
      { valuationId: v.id, kind: 'data_review', title: 'Done', assigneeId: assignee.id, createdBy: admin.id },
      actor(),
    );
    await patchTask(ctx.pool, finished, { status: 'done' }, actor());

    const released = await softDeleteUser(ctx.pool, assignee.id, actor());
    expect(released?.reviewTasks).toEqual([open.id]);
    expect((await findTaskById(ctx.pool, open.id))?.assignee_id).toBeNull();
    expect((await findTaskById(ctx.pool, finished.id))?.assignee_id).toBe(assignee.id);
  });

  it('puts each release on the engagement its own spine, in the shape the change log reads', async () => {
    const reviewer = await seedUser(ctx, { roles: ['reviewer'] });
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Spine Co', userId: admin.id },
      actor(),
    );
    await patchValuation(ctx.pool, v, { assigned_reviewer_id: reviewer.id }, actor());
    await softDeleteUser(ctx.pool, reviewer.id, actor());

    const { rows } = await ctx.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM valuation_events
        WHERE valuation_id = $1 AND type = 'valuation_updated'
        ORDER BY seq DESC LIMIT 1`,
      [v.id],
    );
    expect(rows[0]?.payload).toEqual({
      changes: { assigned_reviewer_id: { from: reviewer.id, to: null } },
      reason: 'account_closed',
    });
  });

  it('closes an account holding nothing without inventing work to release', async () => {
    const idle = await seedUser(ctx, { roles: ['reviewer'] });
    expect(await softDeleteUser(ctx.pool, idle.id, actor())).toEqual({ valuations: [], reviewTasks: [] });
    // And a second close is still a no-op rather than a second release.
    expect(await softDeleteUser(ctx.pool, idle.id, actor())).toBeNull();
  });
});
