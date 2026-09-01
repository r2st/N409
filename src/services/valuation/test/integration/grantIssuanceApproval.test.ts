import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';

const dbUp = await isDbAvailable();

/**
 * The board approval a grant is issued under, and how long the caller's reading
 * of it stays true.
 *
 * `POST /valuations/:id/grants` refuses unless the board resolution is
 * `approved`, and defaults the exercise price to the `fmv_conclusion` that
 * resolution adopted. Both come from one read on the pool, statements before
 * the INSERT — and 'approved' is a state three doors take back: a director
 * removed, a director's decision recorded, and a regeneration replacing the
 * document outright. Each of those is a control an ops user has open on the
 * board screen while the grants screen is open beside it.
 *
 * What got through was an option struck at a §409A fair market value the board
 * was no longer adopting, which is the failure the entire board workflow exists
 * to prevent, issued by a request that had been told the approval was live.
 *
 * `approved_at` is the generation marker, not the status: a resolution
 * regenerated at a different FMV and signed again is 'approved' too, and it is
 * neither the approval the caller read nor the figure they were shown.
 */
const RESOLUTION_READ = /SELECT \* FROM board_resolutions WHERE valuation_id = \$1$/i;

/** Runs `hook` once, after the route's read of the resolution and before its write. */
function betweenReadAndWrite(pool: pg.Pool, hook: () => Promise<void>): () => void {
  const original = pool.query.bind(pool);
  let armed = true;
  const patched = async (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    // Disarmed before awaiting: the hook drives the board routes, which read
    // the resolution through this same statement.
    if (armed && RESOLUTION_READ.test(text.replace(/\s+/g, ' ').trim())) {
      armed = false;
      await hook();
    }
    return result;
  };
  (pool as unknown as { query: unknown }).query = patched;
  return () => {
    (pool as unknown as { query: unknown }).query = original;
  };
}

describe.skipIf(!dbUp)('issuing a grant while the board approval moves', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  const addMember = (valuationId: string, email: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Chair', email },
    });

  const sign = (token: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/board/sign', payload: { token, decision: 'signed' } });

  /** A valuation approved by a single director, and that director's id. */
  async function approvedBoard(company: string): Promise<{ valuationId: string; memberId: string }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: company },
    });
    const valuationId = created.json().valuation.id as string;
    await createCalculation(
      ctx.pool,
      {
        valuationId,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 3 },
        equityValue: 30_000_000,
        fmvPerShare: 3,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    const resolution = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
      payload: {},
    });
    expect(resolution.statusCode, JSON.stringify(resolution.json())).toBe(201);
    const member = await addMember(valuationId, `chair+${company}@board.example`);
    expect((await sign(member.json().sign_token as string)).statusCode).toBe(200);
    return { valuationId, memberId: member.json().member.id as string };
  }

  const issue = (valuationId: string, name: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: name, grant_date: '2026-02-01', options_count: 1000 },
    });

  const grantCount = async (valuationId: string) =>
    (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/valuations/${valuationId}/grants`,
        headers: authHeader(ops.token),
      })
    ).json().grants.length as number;

  it('refuses when the approval is withdrawn after the route has read it', async () => {
    const { valuationId, memberId } = await approvedBoard('WithdrawnCo');
    const restore = betweenReadAndWrite(ctx.pool, async () => {
      // Removing the sole signatory takes the resolution back to 'pending' and
      // clears `approved_at` — `boardResolutionReopened` covers that move.
      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/board/members/${memberId}`,
        headers: authHeader(ops.token),
      });
      expect(removed.statusCode).toBe(204);
    });
    let res;
    try {
      res = await issue(valuationId, 'TooLate');
    } finally {
      restore();
    }
    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    expect(JSON.stringify(res.json())).toContain('board has approved');
    expect(await grantCount(valuationId)).toBe(0);
  });

  it('refuses when the approval is replaced by a different one', async () => {
    const { valuationId, memberId } = await approvedBoard('ReapprovedCo');
    const restore = betweenReadAndWrite(ctx.pool, async () => {
      // Out of 'approved' and back into it: a second approval, at a second
      // moment, which the status alone cannot tell from the first.
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/valuations/${valuationId}/board/members/${memberId}`,
        headers: authHeader(ops.token),
      });
      const replacement = await addMember(valuationId, 'second@board.example');
      expect((await sign(replacement.json().sign_token as string)).statusCode).toBe(200);
    });
    let res;
    try {
      res = await issue(valuationId, 'Stale');
    } finally {
      restore();
    }
    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    expect(JSON.stringify(res.json())).toContain('changed while the grant was being issued');
    expect(await grantCount(valuationId)).toBe(0);
  });

  it('issues normally when nothing moves', async () => {
    const { valuationId } = await approvedBoard('SteadyCo');
    const res = await issue(valuationId, 'Fine');
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    // The adopted FMV, snapshotted as the exercise price.
    expect(Number(res.json().grant.exercise_price)).toBe(3);
    expect(await grantCount(valuationId)).toBe(1);
  });
});
