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
