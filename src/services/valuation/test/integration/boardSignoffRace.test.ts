import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { listBoardMembers, findResolutionByValuation } from '../../src/repos/boardApprovals.js';
import { listEvents } from '../../src/events/record.js';
import { BOARD_EVENT_TYPES } from '../../src/domain/boardResolution.js';

const dbUp = await isDbAvailable();

/**
 * A board member's decision under concurrency.
 *
 * `POST /api/v1/board/sign` refuses a member who has already decided —
 * `if (member.status !== 'pending') throw conflict`. That read is its own
 * statement, so two requests carrying the same token both saw 'pending', and
 * the UPDATE behind them named only the row id. Both wrote; the last one won.
 *
 * The stakes are not "a duplicate row". A sign-off is the evidentiary record
 * that a director adopted the FMV: once every member has signed, the resolution
 * flips to 'approved', stamps `approved_at` and emits an approval event. A
 * second write arriving alongside the first can rewrite a recorded signature to
 * 'rejected' *after* that has happened, leaving two contradictory
 * `signoff_recorded` events for one member and an audit trail with no answer to
 * "which decision stood".
 *
 * Moving the `status = 'pending'` predicate into the UPDATE makes the check and
 * the write one step: the loser blocks on the winner's row lock, re-evaluates
 * against the committed row, matches nothing, and is told what it would have
 * been told a moment later.
 */
describe.skipIf(!dbUp)('board sign-off under concurrency', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  /** A valuation with a generated resolution and one board member's token. */
  async function newSignableMember(companyName: string): Promise<{ valuationId: string; token: string }> {
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
      payload: { name: 'Dana Reed', email: `dana+${companyName}@board.example` },
    });
    expect(added.statusCode).toBe(201);
    return { valuationId, token: added.json().sign_token as string };
  }

  const sign = (token: string, decision: 'signed' | 'rejected', comment?: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token, decision, ...(comment ? { comment } : {}) },
    });

  it('lets exactly one of two simultaneous decisions win', async () => {
    const { valuationId, token } = await newSignableMember('RaceCo');

    // Both are in flight before either has committed — the window the status
    // read alone could not close.
    const [first, second] = await Promise.all([
      sign(token, 'signed', 'I approve.'),
      sign(token, 'rejected', 'I do not.'),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const winner = first.statusCode === 200 ? first : second;

    // The resolution agrees with whichever decision was admitted — it is not
    // left reflecting the one that was refused.
    const resolution = await findResolutionByValuation(ctx.pool, valuationId);
    const rows = await listBoardMembers(ctx.pool, resolution!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(winner.json().signoff.status);
    expect(resolution!.status).toBe(winner.json().resolution_status);
  });

  it('records one signoff event, not one per attempt', async () => {
    const { valuationId, token } = await newSignableMember('EventCo');

    await Promise.all([sign(token, 'signed'), sign(token, 'rejected'), sign(token, 'signed')]);

    const recorded = await listEvents(ctx.pool, valuationId, {
      types: [BOARD_EVENT_TYPES.signoffRecorded],
    });
    // A refused attempt writes nothing, so it leaves no event behind. Two
    // contradictory records for one member is the audit-trail failure.
    expect(recorded).toHaveLength(1);
  });

  it('keeps an approved resolution from being un-signed by a late duplicate', async () => {
    const { valuationId, token } = await newSignableMember('ApprovedCo');

    const signed = await sign(token, 'signed');
    expect(signed.statusCode).toBe(200);
    expect(signed.json().resolution_status).toBe('approved');

    // The same token again, now that approval has been reached and stamped.
    const late = await sign(token, 'rejected', 'changed my mind');
    expect(late.statusCode).toBe(409);

    const resolution = await findResolutionByValuation(ctx.pool, valuationId);
    expect(resolution!.status).toBe('approved');
    expect(resolution!.approved_at).not.toBeNull();
    const rows = await listBoardMembers(ctx.pool, resolution!.id);
    expect(rows[0]!.status).toBe('signed');
    expect(rows[0]!.comment).toBeNull();
  });
});
