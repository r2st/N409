import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { MAX_COMMENT_BODY } from '../../src/repos/comments.js';

const dbUp = await isDbAvailable();

/**
 * `valuation_comments.body` has two writers too, and only one of them was
 * written against the column.
 *
 * `inboxTicketBounds.test.ts` covers the *unmatched* inbound email, which
 * becomes a `support_messages` row and is cut to that column's bound. A
 * matched email — one that resolves to a valuation — takes a different path
 * (`routes/comments.ts`, `kind: 'email'`) into `valuation_comments.body`, the
 * same column the chat/note writers bound to `MAX_COMMENT_BODY`. `InboxBody`
 * allows an email body up to 100,000 characters, five times that, and nothing
 * on the matched path cut it down — so a long inbound email reached the
 * thread whole, and `GET /valuations/:id/comments` reads up to
 * `COMMENT_PAGE_LIMIT` rows with every body in full.
 */
describe.skipIf(!dbUp)('a matched inbound email becomes a bounded comment', () => {
  let ctx: TestApp;
  let relay: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp();
    relay = await seedUser(ctx, { roles: ['auto'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const owner = await seedUser(ctx, { roles: ['valuation_user'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(owner.token),
      payload: { kind: '409a', company_name: 'Inbox Bounds Co' },
    });
    expect(created.statusCode).toBe(201);
    valuationId = created.json().valuation.id as string;
  }, 60_000);

  afterAll(async () => ctx?.teardown());

  const ingest = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/inbox/email',
      headers: authHeader(relay.token),
      payload: { valuation_id: valuationId, ...payload },
    });

  const commentBody = async (id: string) => {
    const { rows } = await ctx.pool.query<{ body: string }>(
      'SELECT body FROM valuation_comments WHERE id = $1',
      [id],
    );
    return rows[0]!.body;
  };

  it('cuts an oversized matched email to the comment column bound and says it cut it', async () => {
    const res = await ingest({
      from: `client.${Date.now()}@example.com`,
      subject: 'Re: the cap table',
      // Inside InboxBody's own 100,000 cap, five times the comment writer's.
      body: 'x'.repeat(90_000),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().valuation_id).toBe(valuationId);

    const body = await commentBody(res.json().comment.id as string);
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_BODY);
    expect(body).toContain('[truncated');
  });

  it('leaves an ordinary matched email whole', async () => {
    const res = await ingest({
      from: `client.${Date.now()}@example.com`,
      subject: 'Re: the cap table',
      body: 'Attached is the signed engagement letter.',
      message_id: `<ordinary-${Date.now()}@mail.example.com>`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = await commentBody(res.json().comment.id as string);
    expect(body).toBe('Attached is the signed engagement letter.');
    expect(body).not.toContain('[truncated');
  });

  it('is the same bound the chat/note comment writer enforces', async () => {
    const over = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
      payload: { kind: 'note', body: 'x'.repeat(MAX_COMMENT_BODY + 1) },
    });
    expect(over.statusCode).toBe(422);

    const atBound = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/comments`,
      headers: authHeader(ops.token),
      payload: { kind: 'note', body: 'x'.repeat(MAX_COMMENT_BODY) },
    });
    expect(atBound.statusCode, atBound.body).toBe(201);
  });
});
