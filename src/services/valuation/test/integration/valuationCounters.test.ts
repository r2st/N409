import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUlid } from '@n409/shared';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The workspace header counters (design §4.6 and §7.3, P2-17 and P2-18).
 *
 * Every one is a count of outstanding work, and the tests that matter are the
 * ones where a naive query would report the wrong thing: unread comments for
 * the *reader* rather than for the thread, my tasks scoped to the caller, and
 * a calculations badge that does not read 4/4 on a partly-failed run.
 */
describe.skipIf(!dbUp)('valuation header counters', () => {
  let ctx: TestApp;
  let analyst: Awaited<ReturnType<typeof seedUser>>;
  let other: Awaited<ReturnType<typeof seedUser>>;
  let owner: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  const counters = async (token: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(token),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().counters as {
      pending_files: number;
      my_tasks: number;
      all_tasks: number;
      unread_comments: number;
      calculations: { done: number; total: number; missing: string[] };
    };
  };

  const upload = async (filename: string) => {
    const boundary = '----n409counters';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: text/plain\r\n\r\ncontents\r\n--${boundary}--\r\n`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents`,
      headers: {
        ...authHeader(analyst.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(body),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().document.id as string;
  };

  const review = async (documentId: string, reviewed: boolean, token = analyst.token) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/documents/${documentId}/review`,
      headers: authHeader(token),
      payload: { reviewed },
    });

  beforeAll(async () => {
    ctx = await setupTestApp();
    analyst = await seedUser(ctx, { roles: ['admin'] });
    other = await seedUser(ctx, { roles: ['reviewer'] });
    owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Counter Co' },
    });
    valuationId = created.json().valuation.id;
  });
  afterAll(async () => ctx?.teardown());

  it('starts at zero on a fresh engagement', async () => {
    const c = await counters(analyst.token);
    expect(c).toMatchObject({ pending_files: 0, my_tasks: 0, all_tasks: 0, unread_comments: 0 });
  });

  describe('pending files', () => {
    it('counts an upload nobody has cleared, and stops once it is cleared', async () => {
      const docId = await upload('cap-table.txt');
      expect((await counters(analyst.token)).pending_files).toBe(1);

      expect((await review(docId, true)).statusCode).toBe(200);
      expect((await counters(analyst.token)).pending_files).toBe(0);
    });

    it('puts a file back in the pile when the mark is undone', async () => {
      // The counter's value is that it reaches zero; a one-way clear turns a
      // mistaken click into a wrong number nobody can fix.
      const docId = await upload('reopen-me.txt');
      await review(docId, true);
      expect((await counters(analyst.token)).pending_files).toBe(0);
      await review(docId, false);
      expect((await counters(analyst.token)).pending_files).toBe(1);

      await review(docId, true);
    });

    it('does not count a deleted document', async () => {
      const docId = await upload('gone.txt');
      expect((await counters(analyst.token)).pending_files).toBe(1);
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/documents/${docId}`,
        headers: authHeader(analyst.token),
      });
      expect((await counters(analyst.token)).pending_files).toBe(0);
    });

    it('refuses a client marking their own upload reviewed', async () => {
      const docId = await upload('client-cannot-clear.txt');
      expect((await review(docId, true, owner.token)).statusCode).toBe(403);
      await review(docId, true);
    });
  });

  describe('tasks', () => {
    it('separates the caller’s open tasks from the engagement’s', async () => {
      const mine = newUlid();
      const theirs = newUlid();
      await ctx.pool.query(
        `INSERT INTO review_tasks (id, valuation_id, kind, title, status, assignee_id)
         VALUES ($1, $3, 'draft_review', 'Mine', 'open', $5),
                ($2, $3, 'draft_review', 'Theirs', 'open', $4)`,
        [mine, theirs, valuationId, other.id, analyst.id],
      );
      expect(await counters(analyst.token)).toMatchObject({ my_tasks: 1, all_tasks: 2 });
      expect(await counters(other.token)).toMatchObject({ my_tasks: 1, all_tasks: 2 });
    });

    it('drops a task from both counts once it is closed', async () => {
      await ctx.pool.query(
        `UPDATE review_tasks SET status = 'done', completed_at = now() WHERE valuation_id = $1`,
        [valuationId],
      );
      expect(await counters(analyst.token)).toMatchObject({ my_tasks: 0, all_tasks: 0 });
    });
  });

  describe('unread comments', () => {
    const post = async (body: string, token: string, kind = 'chat') =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/comments`,
        headers: authHeader(token),
        payload: { kind, body },
      });

    it('counts everything on a thread the reader has never opened', async () => {
      await post('Where do I upload the cap table?', owner.token);
      await post('And the projections?', owner.token);
      expect((await counters(analyst.token)).unread_comments).toBe(2);
    });

    it('is a property of the reader, not of the thread', async () => {
      // Marking the thread read for one analyst must not clear it for another.
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/inbox/read',
        headers: authHeader(analyst.token),
        payload: { valuation_id: valuationId },
      });
      expect((await counters(analyst.token)).unread_comments).toBe(0);
      expect((await counters(other.token)).unread_comments).toBe(2);
    });

    it('does not clear when the workspace is merely opened', async () => {
      // The engagement's unread marker and the reader's thread read state are
      // different facts. Opening the workspace clears the first, not the second.
      await post('Any update?', owner.token);
      expect((await counters(analyst.token)).unread_comments).toBe(1);
      expect((await counters(analyst.token)).unread_comments).toBe(1);
    });

    it('hides internal notes from a client’s count', async () => {
      const before = (await counters(owner.token)).unread_comments;
      await post('Chased the cap table twice.', analyst.token, 'note');
      expect((await counters(owner.token)).unread_comments).toBe(before);
    });
  });

  describe('calculations badge', () => {
    const store = async (results: unknown, status = 'succeeded') =>
      ctx.pool.query(
        `INSERT INTO calculations (id, valuation_id, engine_version, status, inputs, results)
         VALUES ($1, $2, 'test', $3, '{}'::jsonb, $4::jsonb)`,
        [newUlid(), valuationId, status, JSON.stringify(results)],
      );

    it('reads 0/4 with no weighting and no run', async () => {
      expect((await counters(analyst.token)).calculations).toMatchObject({ done: 0, total: 4 });
    });

    it('narrows the denominator to the approaches the weighting asks for', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/valuations/${valuationId}/params`,
        headers: authHeader(analyst.token),
        payload: { weight_asset: 0, weight_opm: 0.6, weight_income: 0, weight_market: 0.4 },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await counters(analyst.token)).calculations).toEqual({
        done: 0,
        total: 2,
        missing: ['opm', 'market'],
      });
    });

    it('counts an approach with a value and not one that was merely attempted', async () => {
      await store({
        approaches: { opm_backsolve: { equity_value: 12_000_000 }, market: { equity_value: null } },
      });
      expect((await counters(analyst.token)).calculations).toEqual({
        done: 1,
        total: 2,
        missing: ['market'],
      });
    });

    it('ignores a later failed run rather than dropping the badge to zero', async () => {
      // The last good calculation is still the one on screen; a failed re-run
      // must not make the badge disagree with it.
      await store(null, 'failed');
      expect((await counters(analyst.token)).calculations).toMatchObject({ done: 1, total: 2 });
    });

    it('reaches n/n when the missing approach lands', async () => {
      await store({
        approaches: {
          opm_backsolve: { equity_value: 12_000_000 },
          market: { equity_value: 11_500_000 },
        },
      });
      expect((await counters(analyst.token)).calculations).toEqual({
        done: 2,
        total: 2,
        missing: [],
      });
    });
  });
});
