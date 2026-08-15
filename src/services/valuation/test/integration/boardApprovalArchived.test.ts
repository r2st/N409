import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCalculation } from '../../src/repos/calculations.js';
import { retireValuations } from '../../src/repos/valuationPurge.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Board sign-off on a retired engagement.
 *
 * The auditor portal already settled the shape of this: a link minted per
 * outside party, sitting in their inbox, redeemed at a time nobody controls, so
 * `archived_at` has to be checked when the link is minted *and* when it is
 * redeemed. Nothing revokes outstanding links when a valuation is archived, and
 * nothing could — the retention sweep does not know they exist.
 *
 * The board flow is the same shape and had neither check. It is the worse of
 * the two for what the link asks: not "here is the deliverable" but "sign this
 * resolution adopting the FMV as the board's own" — a dated governance record,
 * created by a director outside the firm, for work the firm has withdrawn.
 * `POST /board/members/:memberId/send` re-mints the token every time it is
 * called, so a retired engagement went on issuing fresh signing links with
 * fresh deadlines indefinitely, and each one still worked.
 *
 * Reads stay open on purpose — see the note beside `refuseIfRetired`.
 */
describe.skipIf(!dbUp)('board sign-off on a retired engagement', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let client: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['reviewer'] });
    client = await seedUser(ctx, { roles: ['valuation_user'] });
  });
  afterAll(async () => ctx?.teardown());

  const as = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    ctx.app.inject({ method, url, headers: authHeader(ops.token), ...(payload ? { payload } : {}) });

  /** A valuation with a concluded FMV, a resolution, and one member holding a token. */
  async function engagementWithSignoff(
    name: string,
  ): Promise<{ id: string; memberId: string; token: string }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(client.token),
      payload: { kind: '409a', company_name: name },
    });
    const id = created.json().valuation.id as string;

    await createCalculation(
      ctx.pool,
      {
        valuationId: id,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3.5 },
        equityValue: 35_000_000,
        fmvPerShare: 3.5,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );

    expect(
      (await as('POST', `/api/v1/valuations/${id}/board`, { valuation_date: '2026-05-01' })).statusCode,
    ).toBe(201);

    const member = await as('POST', `/api/v1/valuations/${id}/board/members`, {
      name: 'Dana Director',
      email: 'dana@boardco.example',
    });
    expect(member.statusCode).toBe(201);
    return { id, memberId: member.json().member.id, token: member.json().sign_token };
  }

  /**
   * Retire through the production path, not a raw UPDATE.
   *
   * `findValuationById` is read through a 5-second TTL cache, and correctness
   * rests on every writer invalidating the row rather than on the TTL —
   * `retireValuations` does. A test that stamped `archived_at` in SQL would
   * spend those five seconds being served the pre-retirement row and would
   * report these gates as absent when they are present.
   */
  const retire = async (id: string) => {
    const { retired } = await retireValuations(ctx.pool, [id]);
    expect(retired).toEqual([id]);
  };

  it('refuses to email a fresh signing link for a retired engagement', async () => {
    const { id, memberId } = await engagementWithSignoff('SendCo');
    // The send works while the engagement is live — so a 409 below is the
    // retirement and not a broken fixture.
    expect((await as('POST', `/api/v1/valuations/${id}/board/members/${memberId}/send`)).statusCode).toBe(
      200,
    );

    await retire(id);

    const res = await as('POST', `/api/v1/valuations/${id}/board/members/${memberId}/send`);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('retired');
  });

  it('refuses to mint a token for a new board member on a retired engagement', async () => {
    const { id } = await engagementWithSignoff('MintCo');
    await retire(id);

    const res = await as('POST', `/api/v1/valuations/${id}/board/members`, {
      name: 'Erin Director',
      email: 'erin@mintco.example',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('retired');
  });

  it('refuses a sign-off redeemed after the engagement was retired', async () => {
    const { id, token } = await engagementWithSignoff('RedeemCo');
    await retire(id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token, decision: 'signed' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain('retired');

    // And nothing was recorded — the point is the absence of the governance
    // record, not the status code.
    const { rows } = await ctx.pool.query<{ status: string; signed_at: Date | null }>(
      'SELECT status, signed_at FROM board_signoffs WHERE valuation_id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'pending', signed_at: null });
  });

  it('still serves the resolution a live token points at, and still removes members', async () => {
    // The deliberate exceptions. Reading back the document a director was
    // already sent discloses nothing new, and tidying the member list is the
    // one thing ops should keep being able to do on a withdrawn file.
    const { id, memberId, token } = await engagementWithSignoff('ReadCo');
    await retire(id);

    const view = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/board/resolution',
      payload: { token },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().resolution.body_html).toContain('ReadCo');

    expect((await as('DELETE', `/api/v1/valuations/${id}/board/members/${memberId}`)).statusCode).toBe(204);
  });
});
