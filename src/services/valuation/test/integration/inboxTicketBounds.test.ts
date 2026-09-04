import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { MAX_SUPPORT_MESSAGE_BODY, MAX_SUPPORT_MESSAGE_SUBJECT } from '../../src/repos/support.js';

const dbUp = await isDbAvailable();

/**
 * `support_messages` has two writers, and only one of them was written against
 * the column.
 *
 * The contact form caps `body` at `MAX_SUPPORT_MESSAGE_BODY`. The unmatched-
 * email fallback in `routes/comments.ts` composes a ticket out of
 * `InboxBody.body`, whose cap is 100,000 — and the ops inbox reads that column
 * 200 rows at a time with each body in full, so the size of that page is set by
 * whichever writer allows the most.
 */
describe.skipIf(!dbUp)('an unmatched inbound email becomes a bounded ticket', () => {
  let ctx: TestApp;
  let relay: Awaited<ReturnType<typeof seedUser>>;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp();
    relay = await seedUser(ctx, { roles: ['auto'] });
    ops = await seedUser(ctx, { roles: ['admin'] });
  });
  afterAll(async () => ctx?.teardown());

  const ingest = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/inbox/email',
      headers: authHeader(relay.token),
      payload,
    });

  const ticketBody = async (id: string) => {
    const { rows } = await ctx.pool.query<{ subject: string; body: string }>(
      'SELECT subject, body FROM support_messages WHERE id = $1',
      [id],
    );
    return rows[0]!;
  };

  it('cuts an oversized email body to the column bound and says it cut it', async () => {
    const res = await ingest({
      from: `nobody.${Date.now()}@example.com`,
      subject: 'Nothing this can be routed to',
      // Inside InboxBody's own 100,000 cap, five times the form's.
      body: 'x'.repeat(90_000),
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().matched).toBe(false);

    const row = await ticketBody(res.json().support_message_id as string);
    expect(row.body.length).toBeLessThanOrEqual(MAX_SUPPORT_MESSAGE_BODY);
    expect(row.body).toContain('[truncated');
    // The header block the fallback prepends survives the cut.
    expect(row.body.startsWith('From: ')).toBe(true);
  });

  it('leaves an ordinary email whole, headers and all', async () => {
    const from = `client.${Date.now()}@example.com`;
    const res = await ingest({
      from,
      subject: 'Nothing this can be routed to either',
      body: 'Could someone look at this please?',
      message_id: '<abc@mail.example.com>',
    });
    expect(res.statusCode, res.body).toBe(202);
    const row = await ticketBody(res.json().support_message_id as string);
    expect(row.body).toContain(from);
    expect(row.body).toContain('<abc@mail.example.com>');
    expect(row.body).toContain('Could someone look at this please?');
    expect(row.body).not.toContain('[truncated');
  });

  it('keeps the subject bound it already had', async () => {
    const res = await ingest({
      from: `long.${Date.now()}@example.com`,
      subject: 'S'.repeat(1000),
      body: 'short',
    });
    expect(res.statusCode, res.body).toBe(202);
    const row = await ticketBody(res.json().support_message_id as string);
    expect(row.subject.length).toBeLessThanOrEqual(MAX_SUPPORT_MESSAGE_SUBJECT);
  });

  /**
   * The bound the other writer has always applied, asserted through its own
   * route so the two cannot drift apart again without one of these failing.
   */
  it('is the same bound the contact form enforces', async () => {
    const over = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/support/messages',
      headers: authHeader(ops.token),
      payload: { subject: 'Too long', body: 'x'.repeat(MAX_SUPPORT_MESSAGE_BODY + 1) },
    });
    expect(over.statusCode).toBe(422);

    const atBound = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/support/messages',
      headers: authHeader(ops.token),
      payload: { subject: 'At the bound', body: 'x'.repeat(MAX_SUPPORT_MESSAGE_BODY) },
    });
    expect(atBound.statusCode, atBound.body).toBe(201);
  });

  /**
   * The whole point of the cut: one page of the ops inbox is sized by the
   * largest thing that can be in the column, and every body goes out in full.
   */
  it('bounds what one inbox page can carry', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/support/messages',
      headers: authHeader(ops.token),
    });
    expect(list.statusCode, list.body).toBe(200);
    const messages = list.json().messages as Array<{ body: string }>;
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) expect(m.body.length).toBeLessThanOrEqual(MAX_SUPPORT_MESSAGE_BODY);
  });
});
