import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Withdrawing a comment rolls back the thread's last-activity stamp (R418, M4).
 *
 * `createComment` stamps `valuations.last_comment_at` in the same transaction as
 * the insert, because it is the denormalised answer to "when did this thread
 * last move" and no reader of it joins the comments table. The hard DELETE
 * beside it did not un-stamp it, so a withdrawn comment went on being counted:
 * the engagement list's unread mark and its `?unread=true` filter are
 * `last_comment_at > <reader>_read_at`, the nav badge counts the same rows, the
 * firm dashboard prints it as last activity, and `staleEngagements` measures
 * silence from it.
 *
 * The reader who never saw the withdrawn comment is the one who feels it: the
 * engagement stays flagged for a message they can open it and not find.
 */
describe.skipIf(!dbUp)('last activity after a comment is withdrawn', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const engagement = async (name: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().valuation.id as string;
  };

  const note = async (valuationId: string, body: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
      payload: { kind: 'chat', body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().comment.id as string;
  };

  const withdraw = async (commentId: string): Promise<void> => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${commentId}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(204);
  };

  const lastCommentAt = async (valuationId: string): Promise<Date | null> => {
    const { rows } = await ctx.pool.query<{ last_comment_at: Date | null }>(
      'SELECT last_comment_at FROM valuations WHERE id = $1',
      [valuationId],
    );
    return rows[0]!.last_comment_at;
  };

  it('clears the stamp when the only comment is withdrawn', async () => {
    const id = await engagement('Withdrawn Only Co');
    const comment = await note(id, 'a question about the option pool');
    expect(await lastCommentAt(id)).not.toBeNull();

    await withdraw(comment);

    // NULL is the state the column was in before the first comment, and the
    // only honest answer once the last one is taken back out.
    expect(await lastCommentAt(id)).toBeNull();
  });

  it('rolls the stamp back onto the comment that is left', async () => {
    const id = await engagement('Two Comments Co');
    await note(id, 'the first thing said');
    const second = await note(id, 'the second thing said');
    const claimedBySecond = await lastCommentAt(id);

    await withdraw(second);

    const rolled = await lastCommentAt(id);
    // Back onto the surviving comment rather than to NULL — the thread did
    // move, just not as recently as the withdrawn one claimed — and strictly
    // earlier than the stamp the withdrawn comment left, which is the value
    // this column kept before.
    expect(rolled).not.toBeNull();
    expect(rolled!.getTime()).toBeLessThan(claimedBySecond!.getTime());
  });

  it('clears the unread mark of a reader who never saw the withdrawn comment', async () => {
    const id = await engagement('Unread Ghost Co');
    const unreadIds = async (): Promise<string[]> => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/valuations?unread=true&per_page=100',
        headers: authHeader(owner.token),
      });
      expect(res.statusCode).toBe(200);
      return (res.json().valuations as { id: string }[]).map((v) => v.id);
    };

    const comment = await note(id, 'please confirm the grant date');
    expect(await unreadIds()).toContain(id);

    await withdraw(comment);

    // Read through the API rather than the column, which is also what proves
    // the valuation row cache was dropped: the list is served from it.
    expect(await unreadIds()).not.toContain(id);
  });
});
