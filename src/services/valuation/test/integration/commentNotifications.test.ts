import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Who hears that a message landed on an engagement thread (R218).
 *
 * The thread was the one inbound message on this platform that announced
 * itself to nobody: the row was written, `last_comment_at` bumped, an SSE
 * frame sent to whoever already had the page open, and 201 returned. So what
 * this pins is not that a notification exists but who it reaches — the routing
 * is the whole of the fix, and each branch of it is a way to get it wrong that
 * is invisible from the response.
 *
 * The `note` case is the one with teeth. `visibleCommentKinds` gives a client
 * `chat` only, so a notification quoting an internal note into the owner's
 * inbox would publish, in 300 characters, a comment the API would refuse to
 * show them.
 */
describe.skipIf(!dbUp)('comment notifications', () => {
  let ctx: TestApp;
  let pool: pg.Pool;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let reviewer: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    pool = ctx.pool;
    ops = await seedUser(ctx, { roles: ['admin'] });
    reviewer = await seedUser(ctx, { roles: ['reviewer'] });
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  /** A fresh engagement owned by a new client, optionally assigned. */
  const engagement = async (opts: { assign?: boolean } = {}) => {
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Thread Co' },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().valuation.id as string;
    if (opts.assign) {
      await pool.query('UPDATE valuations SET assigned_reviewer_id = $2 WHERE id = $1', [id, reviewer.id]);
      const { invalidateValuation } = await import('../../src/repos/valuations.js');
      invalidateValuation(id);
    }
    return { id, owner };
  };

  const post = async (id: string, token: string, kind: 'chat' | 'note', body: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${id}/comments`,
      headers: authHeader(token),
      payload: { kind, body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().comment.id as string;
  };

  const notifications = async (userId: string, valuationId: string) => {
    const { rows } = await pool.query<{ type: string; title: string; body: string }>(
      `SELECT type, title, body FROM notifications
        WHERE user_id = $1 AND valuation_id = $2 AND type = 'comment_posted'`,
      [userId, valuationId],
    );
    return rows;
  };

  it("sends a client's message to the assigned reviewer, and not to the client", async () => {
    const { id, owner } = await engagement({ assign: true });
    await post(id, owner.token, 'chat', 'Can you look at the option pool?');

    const toReviewer = await notifications(reviewer.id, id);
    expect(toReviewer).toHaveLength(1);
    expect(toReviewer[0]!.title).toContain('Thread Co');
    expect(toReviewer[0]!.body).toContain('option pool');
    // The author is never their own audience.
    expect(await notifications(owner.id, id)).toHaveLength(0);
  });

  it("sends the analyst's reply to the engagement owner", async () => {
    const { id, owner } = await engagement({ assign: true });
    await post(id, ops.token, 'chat', 'Looked at it — the pool is fine.');

    const toOwner = await notifications(owner.id, id);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]!.body).toContain('the pool is fine');
    expect(await notifications(ops.id, id)).toHaveLength(0);
  });

  it('keeps an internal note away from the client it is about', async () => {
    const { id, owner } = await engagement({ assign: true });
    await post(id, ops.token, 'note', 'Client is slow with documents; chase weekly.');

    expect(await notifications(owner.id, id)).toHaveLength(0);
    const toReviewer = await notifications(reviewer.id, id);
    expect(toReviewer).toHaveLength(1);
    expect(toReviewer[0]!.title).toContain('internal note');
  });

  it('falls back to the administrative roles when nobody is assigned', async () => {
    const { id, owner } = await engagement();
    await post(id, owner.token, 'chat', 'Nobody is on this file.');

    // `ops` holds `admin`, which is in CLIENT_MESSAGE_ROLES.
    expect(await notifications(ops.id, id)).toHaveLength(1);
    expect(await notifications(reviewer.id, id)).toHaveLength(0);
  });

  it('honours an in-app opt-out for the event type', async () => {
    const { id, owner } = await engagement({ assign: true });
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/notification-preferences',
      headers: authHeader(owner.token),
      payload: { preferences: [{ event_type: 'comment_posted', in_app: false, email: false }] },
    });
    expect(res.statusCode).toBe(200);

    await post(id, ops.token, 'chat', 'Anyone there?');
    expect(await notifications(owner.id, id)).toHaveLength(0);
  });

  it('announces an inbound email once, however many times it is redelivered', async () => {
    const { id, owner } = await engagement({ assign: true });
    const payload = {
      from: owner.email,
      subject: 'Re: your valuation',
      body: 'Here are the financials you asked for.',
      message_id: 'redelivered@example.com',
      valuation_id: id,
    };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/inbox/email',
      headers: authHeader(ops.token),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/inbox/email',
      headers: authHeader(ops.token),
      payload,
    });
    expect(replay.statusCode).toBe(200);

    const toReviewer = await notifications(reviewer.id, id);
    expect(toReviewer).toHaveLength(1);
    expect(toReviewer[0]!.title).toContain('New email on');
    // Ops-only kind: the client who sent it is not told about their own mail.
    expect(await notifications(owner.id, id)).toHaveLength(0);
  });

  /** Puts the `ignored` row on an account without touching what it already has. */
  const suspend = async (userId: string) => {
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'ignored'
       ON CONFLICT DO NOTHING`,
      [userId],
    );
  };

  /**
   * Assigns a reviewer who is then taken away, one way or the other.
   *
   * The two ways are the whole point of running this twice: a deactivation is a
   * column on `users` and a suspension is an extra row in `user_roles`, and the
   * push half of this platform could see neither.
   */
  const engagementWithDepartedReviewer = async (depart: (userId: string) => Promise<void>) => {
    const { id, owner } = await engagement();
    const leaver = await seedUser(ctx, { roles: ['reviewer'] });
    await pool.query('UPDATE valuations SET assigned_reviewer_id = $2 WHERE id = $1', [id, leaver.id]);
    const { invalidateValuation } = await import('../../src/repos/valuations.js');
    invalidateValuation(id);
    await depart(leaver.id);
    return { id, owner, leaver };
  };

  it('does not write to a deactivated reviewer, and tells the fallback roles instead', async () => {
    const { id, owner, leaver } = await engagementWithDepartedReviewer((userId) =>
      pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [userId]).then(() => undefined),
    );

    await post(id, owner.token, 'chat', 'Still waiting on someone.');
    expect(await notifications(leaver.id, id)).toHaveLength(0);
    // The half this used to miss. `CLIENT_MESSAGE_ROLES` was reached only when
    // the engagement named no reviewer at all, so a file whose reviewer had
    // left was exactly the case the fallback exists for and exactly the case it
    // did not cover — the client's message landed nowhere, silently.
    expect(await notifications(ops.id, id)).toHaveLength(1);
  });

  /**
   * A suspension takes the reader's access away and left the writing alone.
   *
   * `ignored` is additive — the account keeps its `reviewer` row — so nothing
   * that reads an id off the engagement could tell. `valuationScope` answers
   * `{ kind: 'none' }` for them: they can open no engagement, no report and no
   * comment thread. They could still sign in, and `GET /notifications` is
   * authenticated and nothing more, so an excerpt of what a client wrote was
   * waiting there for an account whose access had been revoked.
   */
  it('does not write to a suspended reviewer, and tells the fallback roles instead', async () => {
    const { id, owner, leaver } = await engagementWithDepartedReviewer(suspend);

    await post(id, owner.token, 'chat', 'The cap table is attached.');
    expect(await notifications(leaver.id, id)).toHaveLength(0);
    expect(await notifications(ops.id, id)).toHaveLength(1);
  });

  /**
   * And the fallback set itself, which is chosen by role rather than by id.
   *
   * `listUserIdsWithRoles` joins on the role rows, and a suspended supervisor
   * still holds theirs — so the group addressed when nobody is assigned
   * included an account `isOps` answers false for. It is also capped at 25 in
   * `created_at` order, which is why the subtraction has to happen in the query
   * rather than to its result: filtered afterwards, a suspended administrator
   * would go on displacing a working one from the page.
   */
  it('leaves a suspended administrator out of the fallback group', async () => {
    const suspended = await seedUser(ctx, { roles: ['supervisor'] });
    await suspend(suspended.id);
    const { id, owner } = await engagement();

    await post(id, owner.token, 'chat', 'Is anyone there?');
    expect(await notifications(suspended.id, id)).toHaveLength(0);
    expect(await notifications(ops.id, id)).toHaveLength(1);
  });

  it('does not write to a suspended owner', async () => {
    const { id, owner } = await engagement({ assign: true });
    await suspend(owner.id);

    // An analyst answering: the audience is the owner, and there is no fallback
    // for a reply to somebody who can no longer read the thread it is on.
    await post(id, reviewer.token, 'chat', 'Here is the answer to your question.');
    expect(await notifications(owner.id, id)).toHaveLength(0);
    expect(await notifications(ops.id, id)).toHaveLength(0);
  });
});
