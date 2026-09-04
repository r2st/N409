import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The middle verb (R416, methodology M3).
 *
 * `createComment` writes `comment_added` and R396 gave the hard `DELETE` its
 * `comment_removed`, on the argument that afterwards the spine names a
 * `comment_id` resolving to no row without saying it was withdrawn or by whom.
 * `PATCH /comments/:commentId` is the same act with the row left in place — it
 * replaces up to twenty thousand characters of body — and it wrote nothing, so
 * a thread the client or an auditor had already read could be rewritten with
 * the trail still showing one `comment_added` at the original time.
 *
 * The event carries what the row can no longer answer about the version that
 * was replaced, and not the text: `comment_added` has never carried a body and
 * the spine is not where a superseded one is restored.
 */
describe.skipIf(!dbUp)('an edited comment on the spine', () => {
  let ctx: TestApp;
  let author: Awaited<ReturnType<typeof seedUser>>;
  let editor: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    author = await seedUser(ctx, { roles: ['admin'] });
    editor = await seedUser(ctx, { roles: ['admin'] });
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Edited Thread Co' },
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

  const note = async (body: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(author.token),
      payload: { kind: 'note', body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().comment.id as string;
  };

  const patch = (id: string, token: string, payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'PATCH', url: `/api/v1/comments/${id}`, headers: authHeader(token), payload });

  it('records the rewrite, naming the author and the editor separately', async () => {
    const id = await note('the discount rate here is 12%');
    const before = (await events('comment_edited')).length;

    const res = await patch(id, editor.token, { body: 'the discount rate here is 18%' });
    expect(res.statusCode).toBe(200);
    expect(res.json().comment.body).toBe('the discount rate here is 18%');

    const rows = await events('comment_edited');
    expect(rows).toHaveLength(before + 1);
    const row = rows[rows.length - 1]!;
    // Who changed it is the actor; who wrote it is on the payload — one field
    // could only ever say one of the two, exactly as for the withdrawal.
    expect(row.actor_id).toBe(editor.id);
    expect(row.payload.comment_id).toBe(id);
    expect(row.payload.kind).toBe('note');
    expect(row.payload.author_id).toBe(author.id);
    expect(row.payload.posted_at).toBeTruthy();
    expect(row.payload.fields).toEqual(['body']);
  });

  it('puts neither the old body nor the new one on the trail', async () => {
    const id = await note('the client is disputing the marketability discount');
    await patch(id, author.token, { body: 'the client has accepted the marketability discount' });
    const wire = JSON.stringify(await events('comment_edited'));
    expect(wire).not.toContain('disputing');
    expect(wire).not.toContain('accepted');
  });

  it('carries the from/to for a pin, which has no content to withhold', async () => {
    const id = await note('pin me');
    const before = (await events('comment_edited')).length;
    expect((await patch(id, author.token, { pinned: true })).statusCode).toBe(200);
    const rows = await events('comment_edited');
    expect(rows).toHaveLength(before + 1);
    const row = rows[rows.length - 1]!;
    expect(row.payload.fields).toEqual(['pinned']);
    expect(row.payload.changes).toEqual({ pinned: { from: false, to: true } });
  });

  it('records nothing for a save that changes nothing', async () => {
    const id = await note('unchanged');
    const before = (await events('comment_edited')).length;
    const res = await patch(id, author.token, { body: 'unchanged', pinned: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().comment.body).toBe('unchanged');
    expect((await events('comment_edited')).length).toBe(before);
  });

  it('leaves updated_at alone when nothing changed', async () => {
    const id = await note('idle');
    const stamp = async () => {
      const { rows } = await ctx.pool.query<{ updated_at: Date }>(
        'SELECT updated_at FROM valuation_comments WHERE id = $1',
        [id],
      );
      return rows[0]!.updated_at.toISOString();
    };
    const before = await stamp();
    await patch(id, author.token, { body: 'idle' });
    expect(await stamp()).toBe(before);
  });
});
