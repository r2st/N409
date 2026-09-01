import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createValuation } from '../../src/repos/valuations.js';
import { softDeleteUser } from '../../src/repos/adminUsers.js';
import { authHeader, isDbAvailable, seedUser, setupTestApp, type TestApp } from './helpers.js';

const dbUp = await isDbAvailable();

/**
 * Who may be handed work, asked at the four doors that hand it out.
 *
 * `findUsersByIds` — every consumer that decides who to *write to* — excludes
 * deactivated and suspended accounts. Nothing excluded them on the way in:
 * `userExists` asked only whether a row was there, so an engagement's reviewer
 * and a review task's assignee could both be set to somebody who cannot open
 * either. The write succeeded, the worklist named them, and every notification
 * downstream silently dropped them.
 *
 * `ignored` is additive, so the suspended case needs no stale list: the account
 * keeps the `admin` grant that put it in the reviewer picker, which is asserted
 * here too.
 */
describe.skipIf(!dbUp)('assigning work to an account that cannot do it', () => {
  let ctx: TestApp;
  let app: FastifyInstance;
  let ops: Awaited<ReturnType<typeof seedUser>>;
  let live: Awaited<ReturnType<typeof seedUser>>;
  let suspended: Awaited<ReturnType<typeof seedUser>>;
  let closed: Awaited<ReturnType<typeof seedUser>>;
  let valuationId = '';

  beforeAll(async () => {
    ctx = await setupTestApp({ AUTO_PIPELINE: 'off', EMAIL_MODE: 'off' });
    app = ctx.app;
    ops = await seedUser(ctx, { roles: ['admin'] });
    live = await seedUser(ctx, { roles: ['reviewer'] });
    // Suspension is additive: the reviewer grant stays, which is the whole
    // reason nothing downstream could tell.
    suspended = await seedUser(ctx, { roles: ['reviewer', 'ignored'] });
    closed = await seedUser(ctx, { roles: ['reviewer'] });
    await softDeleteUser(ctx.pool, closed.id);
    const v = await createValuation(
      ctx.pool,
      { kind: '409a', companyName: 'Acme Inc', userId: ops.id },
      { actorType: 'human', actorId: ops.id, source: 'test' },
    );
    valuationId = v.id;
  });

  afterAll(async () => ctx?.teardown());

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: authHeader(ops.token), payload });

  describe('POST /workflow/reassign', () => {
    it('refuses a suspended reviewer, and says the account is the problem', async () => {
      const res = await post(`/api/v1/valuations/${valuationId}/workflow/reassign`, {
        reviewer_id: suspended.id,
      });
      expect(res.statusCode).toBe(422);
      // Not "Unknown reviewer": the id was right and the account is not, and a
      // reader told otherwise goes and checks the id.
      expect(res.json().detail).toMatch(/deactivated or suspended/);
    });

    it('refuses a deactivated reviewer', async () => {
      const res = await post(`/api/v1/valuations/${valuationId}/workflow/reassign`, {
        reviewer_id: closed.id,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(/deactivated or suspended/);
    });

    it('still says Unknown reviewer for an id that names nobody', async () => {
      const res = await post(`/api/v1/valuations/${valuationId}/workflow/reassign`, {
        reviewer_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toBe('Unknown reviewer');
    });

    it('accepts a live reviewer', async () => {
      // Without this the cases above pass equally well against a door that
      // refuses everybody.
      const res = await post(`/api/v1/valuations/${valuationId}/workflow/reassign`, {
        reviewer_id: live.id,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valuation.assigned_reviewer_id).toBe(live.id);
    });
  });

  it('PATCH /valuations/:id refuses one too — the other door onto the same column', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/valuations/${valuationId}`,
      headers: authHeader(ops.token),
      payload: { assigned_reviewer_id: suspended.id },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/deactivated or suspended/);
  });

  it('the bulk assign_reviewer arm refuses before it writes a single row', async () => {
    const res = await post('/api/v1/valuations/bulk', {
      ids: [valuationId],
      action: 'assign_reviewer',
      reviewer_id: suspended.id,
    });
    // For the batch, not per row: the reviewer is one value for the whole
    // selection, so it is validated once, like the unknown-reviewer case.
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/deactivated or suspended/);
  });

  it('a review task cannot be opened against one either', async () => {
    const res = await post(`/api/v1/valuations/${valuationId}/tasks`, {
      kind: 'cap_table',
      title: 'Check the option pool',
      assignee_id: suspended.id,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/deactivated or suspended/);
  });

  it('the reviewer picker no longer offers a suspended account', async () => {
    // The additive suspension is why this needed its own predicate: the row
    // still carries `reviewer`, which is what put it in the picker's role set.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/options?group=ops&limit=200',
      headers: authHeader(ops.token),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().options.map((o: { id: string }) => o.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(suspended.id);
    expect(ids).not.toContain(closed.id);
  });
});
