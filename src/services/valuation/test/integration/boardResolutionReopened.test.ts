import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { listEvents } from '../../src/events/record.js';

const dbUp = await isDbAvailable();

/**
 * The board resolution going back to undecided, and the trail saying so.
 *
 * `refreshResolutionStatusTx` emitted an event on the way *into* 'approved' and
 * on the way into 'rejected', and nothing at all on the way back out. R288 shut
 * the door `addBoardMember` opened onto that direction — an addition landing
 * beside the last signature — by refusing under the resolution's row lock.
 *
 * `deleteBoardMember` opens the same door and cannot be shut the same way:
 * removing a director is a thing ops is allowed to do, and the recomputation
 * that follows takes an approved resolution with one director back to
 * 'pending' with `approved_at` cleared, or a rejected one back to 'pending'
 * once the rejecting director is gone. The trail said the board adopted the
 * FMV, then said a member was removed, and never said the adoption had been
 * withdrawn — leaving a reader to re-derive the aggregate from the sign-off
 * list as it stood at that instant, which is the one thing an audit spine
 * exists so nobody has to do.
 */
describe.skipIf(!dbUp)('board resolution reopened', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  /** A valuation with a generated resolution and one board member on it. */
  async function newBoard(companyName: string): Promise<{
    valuationId: string;
    memberId: string;
    token: string;
  }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    const valuationId = created.json().valuation.id as string;
    const resolution = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
      payload: { fmv_conclusion: 4.5 },
    });
    expect(resolution.statusCode).toBe(201);
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Dana Reed', email: `dana+${companyName}@board.example` },
    });
    expect(added.statusCode).toBe(201);
    return {
      valuationId,
      memberId: added.json().member.id as string,
      token: added.json().sign_token as string,
    };
  }

  const sign = (token: string, decision: 'signed' | 'rejected') =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/board/sign', payload: { token, decision } });

  const removeMember = (valuationId: string, memberId: string) =>
    ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${valuationId}/board/members/${memberId}`,
      headers: authHeader(ops.token),
    });

  const board = async (valuationId: string) =>
    (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/board`,
        headers: authHeader(ops.token),
      })
    ).json().resolution as { status: string; approved_at: string | null };

  const spine = async (valuationId: string, type: string) =>
    (await listEvents(ctx.pool, valuationId)).filter((e) => e.type === type);

  it('records the withdrawal when removing the sole director un-approves', async () => {
    const { valuationId, memberId, token } = await newBoard('ReopenCo');
    expect((await sign(token, 'signed')).statusCode).toBe(200);

    const approved = await board(valuationId);
    expect(approved.status).toBe('approved');
    expect(approved.approved_at).toBeTruthy();
    expect(await spine(valuationId, 'board_resolution_approved')).toHaveLength(1);

    expect((await removeMember(valuationId, memberId)).statusCode).toBe(204);

    // The row really did move back, `approved_at` and all.
    const after = await board(valuationId);
    expect(after.status).toBe('pending');
    expect(after.approved_at).toBeNull();

    // ...and the trail says so, rather than leaving `board_resolution_approved`
    // as the last word on whether the board adopted this FMV.
    const reopened = await spine(valuationId, 'board_resolution_reopened');
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.payload).toMatchObject({ from: 'approved' });
  });

  it('records it for a rejection withdrawn the same way', async () => {
    const { valuationId, memberId, token } = await newBoard('UnrejectCo');
    // A second director who never decides, so removing the first leaves the
    // resolution genuinely undecided rather than empty.
    const other = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Sam Vale', email: 'sam+unreject@board.example' },
    });
    expect(other.statusCode).toBe(201);

    expect((await sign(token, 'rejected')).statusCode).toBe(200);
    expect((await board(valuationId)).status).toBe('rejected');
    expect(await spine(valuationId, 'board_resolution_rejected')).toHaveLength(1);

    expect((await removeMember(valuationId, memberId)).statusCode).toBe(204);
    expect((await board(valuationId)).status).toBe('pending');

    const reopened = await spine(valuationId, 'board_resolution_reopened');
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.payload).toMatchObject({ from: 'rejected' });
  });

  it('says nothing when the removal does not move the aggregate', async () => {
    const { valuationId, memberId } = await newBoard('QuietCo');
    // Nobody has signed, so the resolution is 'pending' before and after.
    expect((await removeMember(valuationId, memberId)).statusCode).toBe(204);
    expect((await board(valuationId)).status).toBe('pending');
    expect(await spine(valuationId, 'board_resolution_reopened')).toHaveLength(0);
  });
});
