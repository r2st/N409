import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A withdrawn comment leaves a trail (R396, methodology M3).
 *
 * `valuation_comments` has no `deleted_at` — the route's DELETE is a hard one —
 * so the row is the only place the body, its author and its kind were ever
 * held. `createComment` records `comment_added` carrying the new id, and the
 * withdrawal recorded nothing at all: the spine named a `comment_id` resolving
 * to no row, and could not say whether it had been taken back out or was simply
 * outside the page the reader was holding. An analyst could remove their own
 * internal note from the working papers and leave a trail on which that had not
 * happened.
 *
 * What the event has to carry is what the row can no longer answer — the
 * author, the kind, and when it was posted — and not the body, which
 * `comment_added` never carried either. `board_member_added` /
 * `board_member_removed` is the pair this follows.
 */
describe.skipIf(!dbUp)('a withdrawn comment on the spine', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    admin = await seedUser(ctx, { roles: ['admin'] });
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Withdrawal Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const events = async (type: string) => {
    const { rows } = await ctx.pool.query<{ payload: Record<string, unknown>; actor_id: string | null }>(
      `SELECT payload, actor_id FROM valuation_events
        WHERE valuation_id = $1 AND type = $2 ORDER BY seq`,
      [valuationId, type],
    );
    return rows;
  };

  const note = async (token: string, body: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(token),
      payload: { kind: 'note', body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().comment.id as string;
  };

  it('records the withdrawal, naming the author and the withdrawer separately', async () => {
    const id = await note(ops.token, 'the discount rate here is the one under discussion');
    const before = (await events('comment_removed')).length;

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(admin.token),
    });
    expect(res.statusCode).toBe(204);

    const rows = await events('comment_removed');
    expect(rows).toHaveLength(before + 1);
    const row = rows[rows.length - 1]!;
    // Who took it out is the actor; who wrote it is on the payload. A single
    // field could only ever say one of the two.
    expect(row.actor_id).toBe(admin.id);
    expect(row.payload.comment_id).toBe(id);
    expect(row.payload.kind).toBe('note');
    expect(row.payload.author_id).toBe(ops.id);
    expect(row.payload.posted_at).toBeTruthy();
  });

  it('does not put the withdrawn body on the trail', async () => {
    const secret = 'the client is disputing the marketability discount';
    const id = await note(ops.token, secret);
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(ops.token),
    });
    const wire = JSON.stringify(await events('comment_removed'));
    expect(wire).not.toContain('disputing');
  });

  it('records nothing for a second withdrawal of the same comment', async () => {
    const id = await note(ops.token, 'withdrawn once');
    const first = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(ops.token),
    });
    expect(first.statusCode).toBe(204);
    const after = (await events('comment_removed')).length;
    const second = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(ops.token),
    });
    expect(second.statusCode).toBe(404);
    expect((await events('comment_removed')).length).toBe(after);
  });

  it('leaves the comment on file when nothing was withdrawn', async () => {
    const id = await note(ops.token, 'still here');
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json().comments as { id: string }[]).map((c) => c.id)).toContain(id);
  });
});

/**
 * An edit that lands after the withdrawal (R418, methodology M4).
 *
 * `PATCH /comments/:id` reads the row through `loadEditable` on one connection
 * and writes it under `FOR UPDATE` on another a few statements later. Two
 * operators on one thread is the ordinary case here — the withdrawal route is
 * right beside the edit — so the row can be gone in between, and `updateComment`
 * says so by returning null.
 *
 * The route used to answer that with a 200 carrying the row as it stood
 * *before* the edit: nothing written, no `comment_edited` on the spine, the
 * editor's own tab redrawing the old body under a saved state, and a live frame
 * telling every other open workspace to re-fetch on account of an edit that had
 * not happened.
 */
describe.skipIf(!dbUp)('editing a comment that has just been withdrawn', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Raced Edit Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  it('refuses the edit rather than reporting the old body as saved', async () => {
    const posted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
      payload: { kind: 'note', body: 'the original wording' },
    });
    expect(posted.statusCode).toBe(201);
    const commentId = posted.json().comment.id as string;

    /*
     * The window itself: the row is withdrawn between the route's own read of
     * it and the locking write. Driven from the read rather than by timing —
     * the authorisation read is a `pool.query`, and the write takes a pooled
     * client of its own, so deleting here puts the route in exactly the state
     * the race produces.
     */
    const realQuery = ctx.pool.query.bind(ctx.pool);
    let armed = true;
    (ctx.pool as { query: unknown }).query = async (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      const result = await (realQuery as (...a: unknown[]) => Promise<unknown>)(...args);
      if (armed && /FROM valuation_comments c/.test(sql) && /c\.id = \$1/.test(sql)) {
        armed = false;
        await (realQuery as (...a: unknown[]) => Promise<unknown>)(
          'DELETE FROM valuation_comments WHERE id = $1',
          [commentId],
        );
      }
      return result;
    };

    try {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/comments/${commentId}`,
        headers: authHeader(ops.token),
        payload: { body: 'the wording nobody will ever read' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      (ctx.pool as { query: unknown }).query = realQuery;
    }

    // And nothing on the spine claims the edit happened.
    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM valuation_events
        WHERE valuation_id = $1 AND type = 'comment_edited' AND payload->>'comment_id' = $2`,
      [valuationId, commentId],
    );
    expect(rows[0]!.n).toBe('0');
  });
});
