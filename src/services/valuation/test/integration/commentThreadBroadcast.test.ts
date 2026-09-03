import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValuationHub } from '../../src/realtime/hub.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * A comment thread is pushed, not polled — so every change to it owes a frame
 * (R396, methodology M3).
 *
 * `deps.hub.broadcast(valuationId, 'comment', …)` is the only thing that makes
 * an open workspace re-read the thread: the frontend's stream hook turns the
 * frame into a tick and the tick into a re-fetch, and nothing else on the page
 * asks again. Three doors create a comment and all three sent one. The two
 * that change a comment after the fact — the edit and the withdrawal — sent
 * none, so their effect reached exactly the tab that made it.
 *
 * The withdrawal is the one with teeth. A sticky note is deleted when it
 * should stop being read, and every other open workspace went on displaying it
 * for as long as nobody navigated.
 *
 * The frame is asserted rather than the socket: the SSE plumbing is
 * `stream.test.ts`'s subject, and what is missing here is the call.
 */
class RecordingHub extends ValuationHub {
  readonly frames: { valuationId: string; event: string; data: unknown }[] = [];
  override broadcast(valuationId: string, event: string, data: unknown): void {
    this.frames.push({ valuationId, event, data });
    super.broadcast(valuationId, event, data);
  }
}

describe.skipIf(!dbUp)('a changed comment reaches the open thread', () => {
  let ctx: TestApp;
  let hub: RecordingHub;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    hub = new RecordingHub();
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' }, { hub });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Broadcast Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  /** A fresh sticky note, and the frames its own creation emitted, discarded. */
  const note = async (body: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
      payload: { kind: 'note', body },
    });
    expect(res.statusCode).toBe(201);
    hub.frames.length = 0;
    return res.json().comment.id as string;
  };

  const commentFrames = () => hub.frames.filter((f) => f.event === 'comment');

  it('announces an edited comment to the room', async () => {
    const id = await note('first draft of the note');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(ops.token),
      payload: { body: 'corrected note' },
    });
    expect(res.statusCode).toBe(200);
    expect(commentFrames()).toEqual([
      { valuationId, event: 'comment', data: { comment_id: id, kind: 'note' } },
    ]);
  });

  it('announces a withdrawn comment to the room', async () => {
    const id = await note('said in front of the wrong audience');
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(204);
    expect(commentFrames()).toEqual([
      { valuationId, event: 'comment', data: { comment_id: id, kind: 'note' } },
    ]);
  });

  it('carries no comment body on the wire', async () => {
    const id = await note('internal: the client is disputing the discount');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(ops.token),
      payload: { body: 'internal: still disputing' },
    });
    const wire = JSON.stringify(commentFrames());
    expect(wire).not.toContain('disputing');
  });

  it('does not announce a second deletion of the same comment', async () => {
    const id = await note('withdrawn twice');
    const first = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(ops.token),
    });
    expect(first.statusCode).toBe(204);
    expect(commentFrames()).toHaveLength(1);
    hub.frames.length = 0;
    // The row is gone, so `loadEditable` refuses before the delete — which is
    // the ordinary racing case (two operators on one worklist row) and must
    // not put a second tick on every open thread.
    const second = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${id}`,
      headers: authHeader(ops.token),
    });
    expect(second.statusCode).toBe(404);
    expect(commentFrames()).toEqual([]);
  });
});
