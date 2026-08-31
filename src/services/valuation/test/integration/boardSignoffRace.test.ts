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

  /**
   * The other direction into the same row, and the one nothing was watching.
   *
   * `POST /valuations/:id/board/members` refuses to add a director to an
   * approved resolution, because adding one un-approves it: `addBoardMember`
   * ends by recomputing the aggregate, and the recomputation of an approved
   * resolution with a fresh pending member is 'pending' with `approved_at`
   * cleared — a direction `refreshResolutionStatusTx` emits no event for, so
   * the trail records the approval and never records it being taken away.
   *
   * That refusal was a read on the pool, and the fact it read is the one the
   * last outstanding signature changes. The window is "ops adds a director
   * while the last director is signing", which is not exotic: the members
   * screen is what ops has open while the links are out.
   */
  describe('adding a member while the last signature lands', () => {
    /**
     * Somebody is stopped on a row lock. Borrowed from
     * `measurementLinkRace.test.ts`, for the same reason it exists there: it
     * makes "the request reached the write and waited" an assertion rather
     * than a sleep long enough to be probably true.
     */
    const waitForABlockedBackend = async (): Promise<void> => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const { rows } = await ctx.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND pid <> pg_backend_pid()`,
        );
        if ((rows[0]?.n ?? 0) > 0) return;
        if (Date.now() >= deadline) throw new Error('no backend ever blocked on the resolution row');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    it('refuses the addition rather than un-approving the resolution', async () => {
      const { valuationId, token } = await newSignableMember('LateAddCo');
      const resolutionBefore = await findResolutionByValuation(ctx.pool, valuationId);
      expect(resolutionBefore!.status).toBe('pending');

      const holder = await ctx.pool.connect();
      let inFlight: ReturnType<typeof ctx.app.inject> | null = null;
      try {
        // The final signature, in flight and not yet committed. The route's own
        // read below cannot see it, which is the whole point: it sees the same
        // 'pending' an operator's screen is showing.
        await holder.query('BEGIN');
        await holder.query(
          `UPDATE board_signoffs SET status = 'signed', signed_at = now() WHERE resolution_id = $1`,
          [resolutionBefore!.id],
        );
        await holder.query(
          `UPDATE board_resolutions SET status = 'approved', approved_at = now() WHERE id = $1`,
          [resolutionBefore!.id],
        );

        inFlight = ctx.app.inject({
          method: 'POST',
          url: `/api/v1/valuations/${valuationId}/board/members`,
          headers: authHeader(ops.token),
          payload: { name: 'Late Arrival', email: 'late@board.example' },
        });
        await waitForABlockedBackend();
        await holder.query('COMMIT');
      } finally {
        holder.release();
      }

      const added = await inFlight!;
      expect(added.statusCode).toBe(409);

      const resolution = await findResolutionByValuation(ctx.pool, valuationId);
      expect(resolution!.status).toBe('approved');
      // The stamp is the half a re-approval could not put back: it says when
      // the board adopted the FMV, and `refreshResolutionStatusTx` writes NULL
      // on every move out of 'approved'.
      expect(resolution!.approved_at).not.toBeNull();
      const rows = await listBoardMembers(ctx.pool, resolution!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('signed');
      // Unused, so the token minted for the refused member is not left live.
      expect(added.json().sign_token).toBeUndefined();
      expect(token).toBeTruthy();
    });
  });
});
