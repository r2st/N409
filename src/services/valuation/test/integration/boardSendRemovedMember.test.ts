import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { findSignoffById, markMemberSent, remintSignoffToken } from '../../src/repos/boardApprovals.js';

const dbUp = await isDbAvailable();

/**
 * The send route's first write, landing on a row that is no longer there.
 *
 * `POST /board/members/:memberId/send` reads the member with `findSignoffById`
 * — its own statement, on its own connection — and then re-mints the token with
 * `UPDATE board_signoffs … WHERE id = $1`. `deleteBoardMember` is a live door in
 * that window, and it is the same window `deleteBoardMember` reasons about
 * itself when it refuses to write a second removal for a double-clicked button.
 *
 * An `UPDATE` that matches nothing is not an error. It wrote nothing, raised
 * nothing, and the route went on to email a director who had been taken off the
 * sign-off list a link whose token hashes to a row that does not exist — then
 * answered `sent: true`. The recipient reads a message about a resolution they
 * are no longer party to, follows the only link in it, and is told it is
 * invalid; the operator is told the send worked.
 *
 * The race is run rather than described. A held transaction deletes the row and
 * does not commit, so `findSignoffById` still sees it and the `UPDATE` behind it
 * blocks on the row lock; committing releases it, and the statement re-evaluates
 * against the committed row and matches nothing. That is the real ordering, not
 * a stub of it.
 */
describe.skipIf(!dbUp)('sending a signing link to a member removed in the same moment', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  async function newMember(
    companyName: string,
    email: string,
  ): Promise<{ valuationId: string; memberId: string }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    const valuationId = created.json().valuation.id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
      payload: { fmv_conclusion: 3.25 },
    });
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Dana Reed', email },
    });
    expect(added.statusCode).toBe(201);
    return { valuationId, memberId: added.json().member.id as string };
  }

  const queuedTo = async (email: string): Promise<number> => {
    const { rows } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM email_outbox WHERE to_email = $1',
      [email],
    );
    return Number(rows[0]!.n);
  };

  it('refuses rather than mailing a link to a row that is gone', async () => {
    const email = 'dana+removed@board.example';
    const { valuationId, memberId } = await newMember('RemovedCo', email);

    const holder = await ctx.pool.connect();
    let send: ReturnType<typeof ctx.app.inject>;
    try {
      await holder.query('BEGIN');
      await holder.query('DELETE FROM board_signoffs WHERE id = $1', [memberId]);
      // In flight while the delete is uncommitted: the lookup reads the row that
      // is still visible, and the re-mint queues behind the lock.
      send = ctx.app.inject({
        method: 'POST',
        url: `/api/v1/valuations/${valuationId}/board/members/${memberId}/send`,
        headers: authHeader(ops.token),
      });
      // Long enough for the handler to have taken its read and reached the
      // UPDATE; the assertion below does not depend on it having done so, only
      // on the outcome once the lock is released.
      await new Promise((r) => setTimeout(r, 150));
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    const res = await send;
    expect(res.statusCode).toBe(404);
    // Nothing was queued, which is the half a 404 alone does not prove: the
    // failure being fixed is a message that left for a real mailbox.
    expect(await queuedTo(email)).toBe(0);
  });

  it('still sends for a member who is on the list', async () => {
    // The discriminator. A guard that refused unconditionally would pass the
    // assertions above and break every send.
    const email = 'dana+present@board.example';
    const { valuationId, memberId } = await newMember('PresentCo', email);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members/${memberId}/send`,
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBe(true);
    expect(await queuedTo(email)).toBe(1);
  });

  it('reports whether each bookkeeping write landed', async () => {
    // Both statements underneath, stated directly: `WHERE id = $1` against a
    // removed row is the third outcome an UPDATE has, and neither of these used
    // to have a way of saying it.
    const email = 'dana+outcomes@board.example';
    const { memberId } = await newMember('OutcomeCo', email);
    const signoff = (await findSignoffById(ctx.pool, memberId))!;
    const actor = { actorType: 'human', actorId: ops.id } as const;
    expect(await remintSignoffToken(ctx.pool, memberId, 'a'.repeat(64))).toBe(true);
    expect(await markMemberSent(ctx.pool, signoff, actor)).toBe(true);

    await ctx.pool.query('DELETE FROM board_signoffs WHERE id = $1', [memberId]);
    expect(await remintSignoffToken(ctx.pool, memberId, 'b'.repeat(64))).toBe(false);
    // The stamp takes the row it is about to write under its own lock, so a
    // removed member is `false` here and writes no `board_resolution_sent`
    // either — the spine must not report a send for a director who is gone.
    expect(await markMemberSent(ctx.pool, signoff, actor)).toBe(false);
  });
});
