import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * The board state machine's middle step, on the trail (R396, methodology M3).
 *
 * `board_resolution_sent` has been declared in `BOARD_EVENT_TYPES` and
 * described in `EVENT_CATALOG` — client-visible, `notice` — since the feature
 * shipped, and nothing wrote it. So the trail read `board_resolution_generated`
 * and then, days later, `board_resolution_approved`, with the step that
 * produced the second missing from between them: the client could not see that
 * their directors had been asked, when, or how often.
 *
 * `board_signoffs.sent_at` is not that record. It is one nullable column on a
 * row `deleteBoardMember` removes and `upsertResolution` discards wholesale, so
 * the fact that a director was asked goes with the row — the same argument
 * `board_member_removed` makes for keeping the address. And it holds one
 * instant, while this route is re-sendable and every re-send kills the link the
 * previous message put in an inbox.
 */
describe.skipIf(!dbUp)('a board resolution going out to a director', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  async function newMember(companyName: string): Promise<{ valuationId: string; memberId: string }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: companyName },
    });
    expect(created.statusCode).toBe(201);
    const valuationId = created.json().valuation.id as string;
    const resolution = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
      payload: { fmv_conclusion: 3.25 },
    });
    expect(resolution.statusCode).toBe(201);
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Dana Director', email: `dana+${companyName}@board.example` },
    });
    expect(added.statusCode).toBe(201);
    return { valuationId, memberId: added.json().member.id as string };
  }

  const sends = async (valuationId: string) => {
    const { rows } = await ctx.pool.query<{ payload: Record<string, unknown>; actor_id: string | null }>(
      `SELECT payload, actor_id FROM valuation_events
        WHERE valuation_id = $1 AND type = 'board_resolution_sent' ORDER BY seq`,
      [valuationId],
    );
    return rows;
  };

  const send = (valuationId: string, memberId: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members/${memberId}/send`,
      headers: authHeader(ops.token),
    });

  it('records the first send, naming the row and not the address', async () => {
    const { valuationId, memberId } = await newMember('FirstSendCo');
    expect((await send(valuationId, memberId)).statusCode).toBe(200);

    const rows = await sends(valuationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(ops.id);
    expect(rows[0]!.payload.signoff_id).toBe(memberId);
    expect(rows[0]!.payload.resolution_id).toBeTruthy();
    // `addBoardMember`'s rule: the spine keeps one copy of a director's
    // address, in `board_member_removed`, because a payload cannot afterwards
    // be edited or removed.
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('board.example');
  });

  it('tells a re-send apart from the first one', async () => {
    const { valuationId, memberId } = await newMember('ResendCo');
    expect((await send(valuationId, memberId)).statusCode).toBe(200);
    expect((await send(valuationId, memberId)).statusCode).toBe(200);

    const rows = await sends(valuationId);
    expect(rows.map((r) => r.payload.resent)).toEqual([false, true]);
  });

  it('records nothing when the director was removed in the same moment', async () => {
    const { valuationId, memberId } = await newMember('GoneCo');
    await ctx.pool.query('DELETE FROM board_signoffs WHERE id = $1', [memberId]);
    const res = await send(valuationId, memberId);
    expect(res.statusCode).toBe(404);
    expect(await sends(valuationId)).toEqual([]);
  });

  it('puts the send between the generation and the approval on the client trail', async () => {
    const { valuationId, memberId } = await newMember('OrderCo');
    expect((await send(valuationId, memberId)).statusCode).toBe(200);

    const { rows } = await ctx.pool.query<{ type: string }>(
      `SELECT type FROM valuation_events
        WHERE valuation_id = $1 AND type LIKE 'board_%' ORDER BY seq`,
      [valuationId],
    );
    const types = rows.map((r) => r.type);
    expect(types.indexOf('board_resolution_generated')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('board_resolution_sent')).toBeGreaterThan(
      types.indexOf('board_resolution_generated'),
    );
  });
});
