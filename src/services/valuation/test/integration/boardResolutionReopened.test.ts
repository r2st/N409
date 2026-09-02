import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { listEvents } from '../../src/events/record.js';
import { deleteBoardMember, findSignoffById } from '../../src/repos/boardApprovals.js';

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

  it('records the removal once when two deletes race off one read', async () => {
    // The route loads the sign-off, then deletes it, and those are two
    // statements on two connections — so a double-clicked button reaches the
    // repo twice with the same row. `board_member_removed` is the one event on
    // this spine that keeps a director's address, and a second copy of it
    // describes a removal that happened once (round 356, methodology M3).
    const { valuationId, memberId } = await newBoard('DoubleRemoveCo');
    const signoff = await findSignoffById(ctx.pool, memberId);
    expect(signoff).not.toBeNull();
    const actor = { actorType: 'human' as const, actorId: ops.id };
    await deleteBoardMember(ctx.pool, signoff!, actor);
    await deleteBoardMember(ctx.pool, signoff!, actor);

    const removals = await spine(valuationId, 'board_member_removed');
    expect(removals).toHaveLength(1);
    expect(removals[0]!.payload).toMatchObject({ signoff_id: memberId });
  });

  it('says nothing when the removal does not move the aggregate', async () => {
    const { valuationId, memberId } = await newBoard('QuietCo');
    // Nobody has signed, so the resolution is 'pending' before and after.
    expect((await removeMember(valuationId, memberId)).statusCode).toBe(204);
    expect((await board(valuationId)).status).toBe('pending');
    expect(await spine(valuationId, 'board_resolution_reopened')).toHaveLength(0);
  });

  /*
   * REGENERATION IS THE THIRD DOOR ONTO THE SAME DIRECTION (round 312).
   *
   * `POST /valuations/:id/board` upserts over whatever is there, and its
   * `DO UPDATE` writes `status = 'pending'`, `approved_at = NULL` and deletes
   * every sign-off — without going through `refreshResolutionStatusTx`, which
   * is where the event above is emitted. So the one door that destroys the
   * board's adoption outright was the one that said nothing about it: the trail
   * showed `board_resolution_approved`, then `board_resolution_generated`,
   * which is also what a first generation writes.
   */
  const regenerate = (valuationId: string, fmv: number) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
      payload: { fmv_conclusion: fmv },
    });

  it('records the withdrawal when a regeneration replaces an approved resolution', async () => {
    const { valuationId, memberId, token } = await newBoard('RegenCo');
    expect((await sign(token, 'signed')).statusCode).toBe(200);
    expect((await board(valuationId)).status).toBe('approved');

    expect((await regenerate(valuationId, 6.25)).statusCode).toBe(201);

    const after = await board(valuationId);
    expect(after.status).toBe('pending');
    expect(after.approved_at).toBeNull();

    const reopened = await spine(valuationId, 'board_resolution_reopened');
    expect(reopened).toHaveLength(1);
    // Named, not counted: the `board_member_added` and `board_signoff_recorded`
    // rows carrying this same id are still on the spine, so an auditor can say
    // whose signature the regeneration threw away.
    expect(reopened[0]!.payload).toMatchObject({
      from: 'approved',
      discarded_signoffs: [memberId],
    });
  });

  it('names the discarded sign-offs even when the resolution had not been decided', async () => {
    const { valuationId, memberId } = await newBoard('PartSignedCo');
    // Nobody signed: the aggregate does not move, so there is nothing to
    // withdraw — but the director on the list is still deleted, and the
    // operator who pressed Generate is not the person who loses their link.
    expect((await regenerate(valuationId, 3.1)).statusCode).toBe(201);

    expect(await spine(valuationId, 'board_resolution_reopened')).toHaveLength(0);
    const generated = await spine(valuationId, 'board_resolution_generated');
    expect(generated).toHaveLength(2);
    expect(generated[1]!.payload).toMatchObject({ discarded_signoffs: [memberId] });
  });

  it('discards nothing on a first generation', async () => {
    const { valuationId } = await newBoard('FirstGenCo');
    const generated = await spine(valuationId, 'board_resolution_generated');
    expect(generated).toHaveLength(1);
    expect(generated[0]!.payload).toMatchObject({ discarded_signoffs: [] });
  });
});
