import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';
import { createCalculation } from '../../src/repos/calculations.js';
import { listEvents } from '../../src/events/record.js';

const dbUp = await isDbAvailable();

/**
 * A cancelled grant is finished, and the door that says so is a read.
 *
 * R296 shut `PATCH /valuations/:id/grants/:grantId` on a cancelled grant: the
 * row is the record of a security issued and then withdrawn, so the grantee,
 * the count, the grant date and the whole vesting schedule stop being editable
 * once `cancelGrant` has run. That refusal reads `option_grants` on the pool and
 * `updateGrant` then wrote `WHERE id = $1` — two statements, with the cancel
 * button sitting on the same screen as the save button in between them.
 *
 * The window is not a contrived one. Cancelling is `DELETE` on the grant the
 * edit form is open over, so "cancel this and save what I typed" is a sequence
 * an ops user produces by hand, and a retried save produces on its own. What
 * landed was an ordinary `grant_updated` against a security that no longer
 * exists — visible in the auditor workbook, which prints cancelled rows.
 *
 * Staged on the statement rather than on the clock, the way `stateMachineDoors`
 * stages the valuation-state races: the hook runs after the route's read of the
 * grant has come back and before it judges it, which is exactly the window.
 */
const GRANT_READ = /SELECT \* FROM option_grants WHERE id = \$1$/i;

/** Runs `hook` once, in the window between the route's read of a grant and its write. */
function betweenReadAndWrite(pool: pg.Pool, hook: () => Promise<void>): () => void {
  const original = pool.query.bind(pool);
  let armed = true;
  const patched = async (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
    // The latch is set before awaiting so the hook's own request — which reads
    // the same row through the same statement — cannot re-enter here.
    if (armed && GRANT_READ.test(text.replace(/\s+/g, ' ').trim())) {
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

describe.skipIf(!dbUp)('editing a grant that is being cancelled', () => {
  let ctx: TestApp;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let valuationId: string;

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off' });
    ops = await seedUser(ctx, { roles: ['admin'] });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/valuations',
      headers: authHeader(ops.token),
      payload: { kind: '409a', company_name: 'CancelRaceCo' },
    });
    valuationId = created.json().valuation.id as string;
    await createCalculation(
      ctx.pool,
      {
        valuationId,
        engineVersion: 'test',
        status: 'succeeded',
        inputs: {},
        results: { fmv_per_share: 2.5 },
        equityValue: 25_000_000,
        fmvPerShare: 2.5,
        createdBy: ops.id,
      },
      { actorType: 'human', actorId: ops.id },
    );
    // Grants may only be issued off an approved board resolution.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board`,
      headers: authHeader(ops.token),
      payload: {},
    });
    const member = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/board/members`,
      headers: authHeader(ops.token),
      payload: { name: 'Chair', email: 'chair@cancelrace.example' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/board/sign',
      payload: { token: member.json().sign_token as string, decision: 'signed' },
    });
  }, 60_000);
  afterAll(async () => ctx?.teardown());

  async function issueGrant(name: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/valuations/${valuationId}/grants`,
      headers: authHeader(ops.token),
      payload: { grantee_name: name, grant_date: '2026-01-01', options_count: 1000 },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    return res.json().grant.id as string;
  }

  const cancel = (grantId: string) =>
    ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
    });

  const edit = (grantId: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
      payload,
    });

  const updates = async (grantId: string) =>
    (await listEvents(ctx.pool, valuationId)).filter(
      (e) => e.type === 'grant_updated' && (e.payload as { grant_id?: string }).grant_id === grantId,
    );

  it('refuses the edit when the cancel lands after the route has read the grant', async () => {
    const grantId = await issueGrant('Raced');
    const restore = betweenReadAndWrite(ctx.pool, async () => {
      expect((await cancel(grantId)).statusCode).toBe(200);
    });
    let res;
    try {
      res = await edit(grantId, { options_count: 9999, grantee_name: 'Rewritten' });
    } finally {
      restore();
    }
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain('cancelled');

    // The security is untouched, and the spine holds no edit of it. The throw
    // rolls the transaction back, so a lost race writes no event either.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/valuations/${valuationId}/grants/${grantId}`,
      headers: authHeader(ops.token),
    });
    expect(after.json().grant).toMatchObject({
      status: 'cancelled',
      options_count: 1000,
      grantee_name: 'Raced',
    });
    expect(await updates(grantId)).toHaveLength(0);
  });

  it('still edits a grant nothing is racing', async () => {
    const grantId = await issueGrant('Quiet');
    const res = await edit(grantId, { options_count: 2500 });
    expect(res.statusCode).toBe(200);
    expect(res.json().grant.options_count).toBe(2500);
    expect(await updates(grantId)).toHaveLength(1);
  });

  it('answers the uncontended cancelled edit with the same sentence', async () => {
    const grantId = await issueGrant('Closed');
    expect((await cancel(grantId)).statusCode).toBe(200);
    const res = await edit(grantId, { options_count: 4000 });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain('cancelled');
    expect(await updates(grantId)).toHaveLength(0);
  });
});
